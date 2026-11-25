'use strict';

const PAGE_SIZE = 20;

function studentSummary(state) {
  const orders = Array.isArray(state.orders) ? state.orders : [];
  const menu = Array.isArray(state.menu) ? state.menu : [];
  const summary = {
    version: Number(state.version) || 0, restaurant: String(state.restaurant || ''),
    menuCount: menu.length, orderCount: orders.length, servedCount: 0, paidCount: 0, revenue: 0, profit: 0
  };
  for (const order of orders) {
    if (order.status === '待结账' || order.status === '已结账') summary.servedCount++;
    if (order.status !== '已结账') continue;
    const payable = Number(order.payable) || 0;
    const cost = (Array.isArray(order.items) ? order.items : []).reduce(
      (total, item) => total + (Number(item.cost) || 0) * (Number(item.qty) || 0), 0
    );
    summary.paidCount++;
    summary.revenue += payable;
    summary.profit += payable - cost;
  }
  return summary;
}

function submissionSummary({ id, taskId, studentId, name, title, time, status, score, feedback }) {
  return { id, taskId, studentId, name, title, time, status, score, feedback };
}

function revisionHistory(record) {
  return (record?.history || []).map(({ history, ...revision }) => revision);
}

function pagination(total, requestedPage) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const requested = Number(requestedPage);
  const page = Number.isSafeInteger(requested) ? Math.min(pages, Math.max(1, requested)) : 1;
  return { page, pages, pageSize: PAGE_SIZE, total };
}

function createClassroomData({ db, storage, presence }) {
  const classJoin = "FROM users u LEFT JOIN class_students m ON m.student_id=u.id WHERE u.role='student'";
  const classId = "COALESCE(m.class_id,'default')";
  const readState = db.prepare('SELECT state FROM users WHERE id=?');
  const summariesByStudent = new Map();
  let submissions;

  function allSubmissionSummaries() {
    // The service owns writes to this table. Only the first read parses legacy evidence.
    if (!submissions) {
      const loaded = new Map();
      const query = db.prepare(`SELECT id, json_extract(record,
        '$.taskId','$.studentId','$.name','$.title','$.time','$.status','$.score','$.feedback') metadata
        FROM submissions`);
      for (const { id, metadata } of query.iterate()) {
        const [taskId, studentId, name, title, time, status, score, feedback] = JSON.parse(metadata);
        loaded.set(id, { id, taskId, studentId, name, title, time, status, score, feedback });
      }
      submissions = loaded;
    }
    return submissions;
  }

  function putSubmission(record) {
    db.prepare('INSERT OR REPLACE INTO submissions(id,record) VALUES(?,?)').run(record.id, JSON.stringify(record));
    storage.afterCommit(() => submissions?.set(record.id, submissionSummary(record)));
  }

  function getSubmission(id) {
    const row = db.prepare('SELECT record FROM submissions WHERE id=?').get(id);
    return row ? JSON.parse(row.record) : null;
  }

  function saveStudentState(id, state) {
    db.prepare('UPDATE users SET state=? WHERE id=?').run(JSON.stringify(state), id);
    storage.afterCommit(() => summariesByStudent.delete(id));
  }

  function summaryFor(id) {
    let summary = summariesByStudent.get(id);
    if (!summary) {
      summary = studentSummary(JSON.parse(readState.get(id)?.state || '{}'));
      summariesByStudent.set(id, summary);
    }
    return summary;
  }

  function classList(includeBusinessTotals = false) {
    const counts = db.prepare(`SELECT ${classId} id, COUNT(*) count ${classJoin} GROUP BY 1`).all();
    const countsByClass = new Map(counts.map(row => [row.id, row.count]));
    const totals = new Map();
    if (includeBusinessTotals) {
      for (const row of db.prepare(`SELECT u.id,${classId} classId ${classJoin}`).iterate()) {
        const summary = summaryFor(row.id);
        const total = totals.get(row.classId) || { orders: 0, revenue: 0 };
        total.orders += summary.orderCount;
        total.revenue += summary.revenue;
        totals.set(row.classId, total);
      }
    }
    return db.prepare('SELECT record FROM classes ORDER BY rowid').all().map(({ record }) => {
      const info = JSON.parse(record);
      return {
        ...info, count: countsByClass.get(info.id) || 0,
        ...(includeBusinessTotals ? totals.get(info.id) || { orders: 0, revenue: 0 } : {})
      };
    });
  }

  function studentPage(params, includeBusiness) {
    const selectedClass = params.get('classId') || 'all';
    const filter = selectedClass === 'all' ? '' : ` AND ${classId}=?`;
    const args = filter ? [selectedClass] : [];
    const { total } = db.prepare(`SELECT COUNT(*) total ${classJoin}${filter}`).get(...args);
    const paging = pagination(total, params.get('page'));
    const students = db.prepare(`SELECT u.id,u.name,${classId} classId ${classJoin}${filter} ORDER BY u.id LIMIT ? OFFSET ?`)
      .all(...args, paging.pageSize, (paging.page - 1) * paging.pageSize)
      .map(({ id, name, classId }) => ({
        id, name, classId, presence: presence.get(id) || null,
        ...(includeBusiness ? { summary: summaryFor(id) } : {})
      }));
    if (includeBusiness) {
      const stats = new Map(students.map(student => [student.id, { count: 0, graded: 0, totalScore: 0 }]));
      for (const submission of allSubmissionSummaries().values()) {
        const stat = stats.get(submission.studentId);
        if (!stat) continue;
        stat.count++;
        if (submission.status === '已评价') {
          stat.graded++;
          stat.totalScore += submission.score;
        }
      }
      for (const student of students) student.submissionStats = stats.get(student.id);
    }
    return { students, paging };
  }

  function submissionPage(params) {
    const summaries = allSubmissionSummaries();
    const { total } = db.prepare('SELECT COUNT(*) total FROM submissions').get();
    const paging = pagination(total, params.get('page'));
    const submissions = db.prepare('SELECT id FROM submissions ORDER BY id LIMIT ? OFFSET ?')
      .all(paging.pageSize, (paging.page - 1) * paging.pageSize)
      .map(({ id }) => {
        const { feedback, ...summary } = summaries.get(id);
        return summary;
      });
    return { submissions, paging };
  }

  function overview() {
    const { students } = db.prepare("SELECT COUNT(*) students FROM users WHERE role='student'").get();
    const { classes } = db.prepare('SELECT COUNT(*) classes FROM classes').get();
    const recent = Date.now() - 300000;
    let active = 0, pending = 0, graded = 0;
    for (const activity of presence.values()) if (activity.at > recent) active++;
    for (const submission of allSubmissionSummaries().values()) {
      if (submission.status === '待批阅') pending++;
      if (submission.status === '已评价') graded++;
    }
    return { students, classes, active, pending, graded };
  }

  return { classList, studentPage, submissionPage, overview, saveStudentState, getSubmission, putSubmission, allSubmissionSummaries };
}

module.exports = { createClassroomData, studentSummary, revisionHistory };

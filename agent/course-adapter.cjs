'use strict';
const { sha256, equal, selectedCookie, fail } = require('./identity.cjs');
const TOOLS = new Set(['get_course_overview', 'list_students_progress', 'get_student_detail', 'list_workorders', 'get_submission_detail']);
const pageNames = new Set(['teacher','teacherProgress','teacherPanel','workorders','reviews','interaction','classes','classControl',
  '总览','任务完成进度','学生数据面板','任务工单设计','提交与批阅','师生互动']);
module.exports = function createCourseAdapter({ db, course, evaluate, env = process.env }) {
  const hotel = course === 'hotel';
  const records = table => db.prepare('SELECT record FROM ' + table + ' ORDER BY rowid').all().map(r => JSON.parse(r.record));
  const workorders = () => hotel ? records('workorders') : records('tasks').map(t => ({ ...t, objective: t.deliverable,
    status: t.published ? '已发布' : '草稿', target: 'all' }));
  const submissions = () => records('submissions').map(s => ({ ...s, workorder_id: hotel ? s.orderId : s.taskId,
    student_id: s.studentId, submitted_at: hotel ? s.submittedAt : s.time }));
  function student(id) {
    if (typeof id !== 'string' || id.length > 80) fail(400, 'INVALID_STUDENT', '学生编号无效');
    const row = db.prepare("SELECT * FROM users WHERE id=? AND role='student'").get(id);
    if (!row) fail(404, 'STUDENT_NOT_FOUND', '学生不存在');
    return row;
  }
  function identity(req, input) {
    let session;
    if (input.login_ref !== undefined) {
      if (!/^[a-f0-9]{64}$/.test(input.login_ref) || typeof input.teacher_id !== 'string') fail(401, 'LOGIN_EXPIRED', '登录已失效');
      const sessions = hotel ? db.prepare('SELECT token,expires FROM sessions WHERE user_id=? AND expires>?').all(input.teacher_id, Date.now()) :
        db.prepare('SELECT token,expires FROM sessions WHERE id=? AND expires>?').all(input.teacher_id, Date.now());
      session = sessions.find(s => equal(hotel ? s.token : sha256(s.token), input.login_ref));
      if (session) session = { ...session, id: input.teacher_id, login_ref: input.login_ref };
    } else {
      const cookie = selectedCookie(req.headers, course), token = cookie.slice(cookie.indexOf('=') + 1);
      if (!cookie || !token || token.length > 256) fail(401, 'LOGIN_REQUIRED', '请先登录教师账号');
      const row = hotel ? db.prepare('SELECT user_id AS id,expires FROM sessions WHERE token=? AND expires>?').get(sha256(token), Date.now()) :
        db.prepare('SELECT id,expires FROM sessions WHERE token=? AND expires>?').get(token, Date.now());
      if (row) session = { ...row, login_ref: sha256(token) };
    }
    if (!session) fail(401, 'LOGIN_EXPIRED', '登录已失效，请重新登录');
    const user = db.prepare('SELECT id,name,role FROM users WHERE id=?').get(session.id);
    if (!user || user.role !== 'teacher') fail(403, 'TEACHER_REQUIRED', '教学助手仅向教师开放');
    return { course, teacher_id: user.id, name: user.name, role: user.role,
      login_ref: session.login_ref, login_expires_at: Math.floor(session.expires / 1000) };
  }
  function context(raw = {}) {
    if (!raw || Array.isArray(raw) || typeof raw !== 'object') fail(400, 'INVALID_CONTEXT', '页面上下文无效');
    if (Object.keys(raw).some(k => !['page','class_id','student_id','workorder_id'].includes(k))) fail(400, 'INVALID_CONTEXT', '未知页面上下文字段');
    const out = {};
    for (const [key,value] of Object.entries(raw)) {
      if (value === null || value === '') continue;
      if (typeof value !== 'string' || value.length > 100) fail(400, 'INVALID_CONTEXT', '上下文编号无效');
      out[key] = value;
    }
    if (out.page && !pageNames.has(out.page)) fail(400, 'INVALID_CONTEXT', '未知教学页面');
    if (out.class_id && (!hotel || !db.prepare('SELECT id FROM classes WHERE id=?').get(out.class_id))) fail(400, 'INVALID_CLASS', hotel ? '班级不存在' : '餐饮课程暂不支持班级筛选');
    const st = out.student_id ? student(out.student_id) : null;
    if (st && out.class_id && st.class_id !== out.class_id) fail(400, 'CONTEXT_MISMATCH', '学生不属于所选班级');
    if (out.workorder_id) {
      const order = workorders().find(o => o.id === out.workorder_id);
      if (!order) fail(404, 'WORKORDER_NOT_FOUND', '工单不存在');
      if (out.class_id && order.target?.startsWith('class:') && order.target !== 'class:' + out.class_id) fail(400, 'CONTEXT_MISMATCH', '工单不属于所选班级');
      if (st && !targeted(order, st)) fail(400, 'CONTEXT_MISMATCH', '工单未分配给此学生');
    }
    return out;
  }
  function targeted(order, st) { return !hotel || order.target === 'all' || order.target === 'class:' + st.class_id || String(order.target).split(',').includes(st.id); }
  function safeStudent(row) {
    const s = JSON.parse(row.state || '{}');
    const result = { id: row.id, name: row.name, class_id: row.class_id || null, version: row.version ?? s.version ?? 0, updated_at: row.updated || null };
    if (hotel) {
      result.task_results = s.taskResults || {};
      result.progress = Object.fromEntries(['task1','task2','task3','task4'].map(id => [id, evaluate(s,id).checks]));
      result.business = { employees: (s.employees || []).filter(e => e.status !== '离职').length,
        hires: (s.candidates || []).filter(c => c.stage === '已录用').length, performance_records: Object.keys(s.performance || {}).length };
    } else {
      const orders = s.original?.orders || s.orders || [];
      result.business = { menu_items: (s.original?.menu || s.menu || []).length, orders: orders.length,
        paid_orders: orders.filter(o => ['paid','已结账'].includes(o.status)).length };
    }
    return result;
  }
  function page(items, args) {
    const offset = Number(args.cursor || 0), limit = Number(args.limit || 30);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) fail(400,'INVALID_PAGINATION','分页参数无效');
    return { items: items.slice(offset, offset + limit), total: items.length, next_cursor: offset + limit < items.length ? String(offset + limit) : null };
  }
  function tool(name, args = {}) {
    if (!TOOLS.has(name)) fail(403, 'TOOL_NOT_ALLOWED', '此教学工具未开放');
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !['class_id','student_id','workorder_id','status','cursor','limit'].includes(k))) fail(400,'INVALID_ARGUMENTS','工具参数无效');
    const selection = context(Object.fromEntries(['class_id','student_id','workorder_id'].filter(k => args[k] != null).map(k => [k,args[k]])));
    const students = db.prepare("SELECT * FROM users WHERE role='student' ORDER BY id").all().filter(s => !selection.class_id || s.class_id === selection.class_id);
    const studentIds = new Set(students.map(s => s.id));
    const allOrders = workorders();
    const orders = allOrders.filter(o => !selection.class_id || o.target === 'all' || o.target === 'class:' + selection.class_id || String(o.target).split(',').some(id => studentIds.has(id)));
    const subs = submissions().filter(s => studentIds.has(s.student_id) && (!selection.workorder_id || s.workorder_id === selection.workorder_id));
    let data;
    if (name === 'get_course_overview') {
      const relevantOrders = orders.filter(o => !selection.workorder_id || o.id === selection.workorder_id);
      data = { student_count: students.length, workorder_count: relevantOrders.length,
        published_workorders: relevantOrders.filter(o => o.status === '已发布').length,
        submissions: subs.length, awaiting_review: subs.filter(s => s.status === '待批阅').length,
        reviewed: subs.filter(s => s.status === '已评价').length,
        classes: hotel ? records('classes').map(c => ({ id:c.id,name:c.name,stage:c.stage })) : [] };
    } else if (name === 'list_workorders') {
      data = page(orders.filter(o => (!selection.workorder_id || o.id === selection.workorder_id) && (!args.status || o.status === args.status)), args);
    } else if (name === 'list_students_progress') {
      let rows = students.filter(s => !selection.student_id || s.id === selection.student_id).map(st => ({ ...safeStudent(st),
        workorders: orders.filter(o => targeted(o,st) && (!selection.workorder_id || o.id === selection.workorder_id)).map(o => {
          const sub = subs.find(s => s.student_id === st.id && s.workorder_id === o.id);
          return { id:o.id,title:o.title,status:sub?.status || '未提交',score:sub?.score ?? null,submitted_at:sub?.submitted_at || null };
        }) }));
      if (args.status) rows = rows.filter(r => r.workorders.some(o => o.status === args.status));
      data = page(rows,args);
    } else if (name === 'get_student_detail') {
      const st = student(selection.student_id), state = JSON.parse(st.state || '{}');
      const logs = hotel ? db.prepare('SELECT time,action,detail FROM logs WHERE user_id=? ORDER BY seq DESC').all(st.id) : state.logs || [];
      data = { ...safeStudent(st), logs:page(logs,args), workorders:subs.filter(s => s.student_id === st.id).map(s => ({
        workorder_id:s.workorder_id,status:s.status,score:s.score,submitted_at:s.submitted_at,feedback:s.feedback })) };
    } else {
      const st = student(selection.student_id);
      if (!selection.workorder_id) fail(400,'INVALID_WORKORDER','请选择工单');
      const sub = subs.find(s => s.student_id === st.id && s.workorder_id === selection.workorder_id);
      if (!sub) fail(404,'SUBMISSION_NOT_FOUND','此学生尚未提交该工单');
      // Evidence is user data. Do not include account records or credentials.
      data = { student:{id:st.id,name:st.name}, workorder:allOrders.find(o => o.id === selection.workorder_id),
        submission:{content:hotel ? sub.evidence : sub.content,status:sub.status,score:sub.score,feedback:sub.feedback,
          submitted_at:sub.submitted_at,attempt:sub.attempt || 1,history:sub.history || [],business:hotel ? sub.business : safeStudent({ ...st,state:JSON.stringify(sub.evidence || {}) }).business} };
    }
    const result = { scope:{course,...selection}, retrieved_at:new Date().toISOString(),
      source_version:hotel ? {revision:db.prepare("SELECT value FROM metadata WHERE key='revision'").get().value} : {sha256:sha256(JSON.stringify(data))},data };
    if (Buffer.byteLength(JSON.stringify(result)) > 128 * 1024) fail(413,'TOOL_RESULT_TOO_LARGE','查询结果过大，请缩小范围或分页');
    return result;
  }
  return (req, input) => {
    const expected = env.AGENT_BRIDGE_SECRET || '', supplied = String(req.headers['x-agent-bridge'] || '');
    if (!expected || !['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress) || !equal(expected,supplied)) fail(404,'NOT_FOUND','接口不存在');
    const who = identity(req,input);
    if (input.action === 'identity' || input.action === 'authorize') return who;
    if (input.action === 'context') return { identity:who, context:context(input.page_context) };
    if (input.action === 'tool') return tool(input.tool,input.arguments);
    fail(400,'INVALID_ACTION','未知教学操作');
  };
};

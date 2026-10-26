export const terminal=new Set(['COMMITTED','FAILED','CANCELLED','WAITING_INPUT','WAITING_DEPENDENCY']);
export const labels={QUEUED:'排队中',RUNNING:'正在处理',RETRY_WAIT:'正在恢复执行',COMMITTED:'已保存',FAILED:'执行未完成',CANCELLED:'已停止',WAITING_INPUT:'需要处理后继续',WAITING_DEPENDENCY:'等待前序任务'};
export function storageKey(course,id){return `teacher-chat:${course}:${id}`;}
export function loadState(key){try{return JSON.parse(sessionStorage.getItem(key)||'{}');}catch{return {};}}
export function saveState(key,value){try{sessionStorage.setItem(key,JSON.stringify(value));}catch{}}
export function acceptEvent(event,cursor){return Number.isSafeInteger(event?.seq)&&event.seq>cursor;}
export function draftKey(event){return [event.attempt_id,event.payload?.request_id,event.payload?.item].join(':');}
export const pageLabels={teacher:'课堂总览',teacherProgress:'任务完成进度',teacherPanel:'学生数据面板',workorders:'任务工单设计',reviews:'提交与批阅',interaction:'师生互动',classControl:'班级与阶段控制'};

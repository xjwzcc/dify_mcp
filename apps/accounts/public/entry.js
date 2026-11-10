'use strict';
// Loaded only by the gateway. Standalone course installations keep their entry.
window.teachingAuth = {
  login(course) {
    const requested = new URLSearchParams(location.search).get('role');
    const role = location.pathname.endsWith('/teacher') ? 'teacher' : location.pathname.endsWith('/student') ? 'student' : requested === 'teacher' ? 'teacher' : 'student';
    location.replace('/' + role + '/?' + new URLSearchParams({ course }));
  },
  acceptsRole(role) {
    const pageRole = location.pathname.split('/').pop();
    const requested = ['teacher','student'].includes(pageRole) ? pageRole : new URLSearchParams(location.search).get('role');
    if (['teacher', 'student'].includes(requested) && requested !== role) {
      this.login(location.pathname.split('/')[1]); return false;
    }
    return true;
  },
  async logout() {
    const course = location.pathname.split('/')[1];
    const role = location.pathname.endsWith('/teacher') ? 'teacher' : 'student';
    for (const url of [`/${role}/api/logout`, `/${course}/api/logout`]) {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!response.ok && response.status !== 401) throw Error('退出未完成，请稍后重试');
    }
  }
};

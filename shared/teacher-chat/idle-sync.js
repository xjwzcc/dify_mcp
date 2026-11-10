'use strict';
// Short background reads only while the classroom page is being used.
// Business writes keep their own save/backup lifecycle.
(() => {
  const idleMs = 60000, tasks = new Set();
  let lastActivity = Date.now(), away = false, idleTimer;
  const active = () => !away && !document.hidden && Date.now() - lastActivity < idleMs;
  function stop() {
    clearTimeout(idleTimer);
    for (const task of tasks) { clearTimeout(task.timer); task.timer = null; }
  }
  function schedule(task, delay = task.interval) {
    if (!active() || task.running || task.timer !== null || !tasks.has(task)) return;
    task.timer = setTimeout(async () => {
      task.timer = null;
      if (!active()) return;
      task.running = true;
      try { await task.run(); } catch { /* Each caller owns its error display. */ }
      finally { task.running = false; schedule(task); }
    }, delay);
  }
  function wake() {
    const wasActive = active();
    lastActivity = Date.now();
    clearTimeout(idleTimer);
    if (!active()) return;
    idleTimer = setTimeout(stop, idleMs);
    for (const task of tasks) schedule(task, wasActive ? task.interval : 0);
  }
  for (const name of ['pointerdown', 'keydown', 'wheel', 'touchstart'])
    window.addEventListener(name, wake, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { away = true; stop(); }
    else { away = false; lastActivity = 0; wake(); }
  });
  window.addEventListener('pagehide', () => { away = true; stop(); });
  window.addEventListener('pageshow', () => { away = false; lastActivity = 0; wake(); });
  window.TeachingIdleSync = {
    active,
    add(run, interval) {
      const task = { run, interval, timer: null, running: false };
      tasks.add(task); schedule(task);
      return () => { clearTimeout(task.timer); tasks.delete(task); };
    }
  };
  wake();
})();

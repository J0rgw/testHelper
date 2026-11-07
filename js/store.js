/*
 * Persistencia en localStorage: contador de errores, historial de intentos y preferencias.
 * Todo se guarda por asignatura, así cada JSON tiene su propio progreso.
 */
window.Store = (() => {
  const PREFIX = 'cuaderno-examenes:v1:';

  function read(key, fallback) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      // Sin almacenamiento (modo privado, cuota llena...): la app sigue funcionando sin guardar.
    }
  }

  /* ---------- Contador de errores ---------- */

  // { [questionId]: { count, last } }
  function getFails(subjectId) {
    return read(`fails:${subjectId}`, {});
  }

  function addFails(subjectId, questionIds) {
    if (!questionIds.length) return;
    const fails = getFails(subjectId);
    const now = Date.now();
    for (const id of questionIds) {
      const entry = fails[id] || { count: 0, last: 0 };
      entry.count += 1;
      entry.last = now;
      fails[id] = entry;
    }
    write(`fails:${subjectId}`, fails);
  }

  function resetFails(subjectId, questionId) {
    if (questionId) {
      const fails = getFails(subjectId);
      delete fails[questionId];
      write(`fails:${subjectId}`, fails);
    } else {
      write(`fails:${subjectId}`, {});
    }
  }

  /* ---------- Historial de intentos ---------- */

  // { [examKey]: { attempts, best, last, lastMode, lastDate } }
  function getHistory(subjectId) {
    return read(`history:${subjectId}`, {});
  }

  function recordAttempt(subjectId, examKey, grade, mode) {
    const history = getHistory(subjectId);
    const entry = history[examKey] || { attempts: 0, best: null, last: null };
    entry.attempts += 1;
    entry.last = grade;
    entry.best = entry.best === null ? grade : Math.max(entry.best, grade);
    entry.lastMode = mode;
    entry.lastDate = Date.now();
    history[examKey] = entry;
    write(`history:${subjectId}`, history);
  }

  /* ---------- Preferencias ---------- */

  function getPref(name, fallback) {
    return read(`pref:${name}`, fallback);
  }

  function setPref(name, value) {
    write(`pref:${name}`, value);
  }

  return { getFails, addFails, resetFails, getHistory, recordAttempt, getPref, setPref };
})();

// Tracks which academy lessons the learner has completed, in localStorage.
// Drives the progress bars and checkmarks that turn the lesson list into a
// guided path from beginner to self-sufficient.

const KEY = "quant_academy_done";
const listeners = new Set();

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? new Set(arr) : new Set();
  } catch {
    return new Set();
  }
}

function write(set) {
  try { localStorage.setItem(KEY, JSON.stringify([...set])); } catch { /* private mode */ }
  listeners.forEach((fn) => fn());
}

export function getCompleted() {
  return read();
}

export function isDone(lessonId) {
  return read().has(lessonId);
}

export function setDone(lessonId, done) {
  const set = read();
  if (done) set.add(lessonId);
  else set.delete(lessonId);
  write(set);
}

export function subscribeProgress(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

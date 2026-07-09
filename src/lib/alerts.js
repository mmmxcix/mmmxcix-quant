// Price alerts — localStorage-backed, checked client-side against the live
// price. When the price crosses an alert's threshold, we fire a browser
// Notification (if permitted) and mark the alert as triggered. Purely local:
// no server, no cost, works while the tab is open.
//
// Alert shape: { id, market, symbol, price, direction: "above"|"below",
//                createdAt, triggered, triggeredAt }

const KEY = "quant_alerts";

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function write(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* private mode */ }
  listeners.forEach((fn) => fn(list));
}

const listeners = new Set();
export function subscribeAlerts(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) listeners.forEach((fn) => fn(read()));
  });
}

export function getAlerts() {
  return read();
}

export function getAlertsFor(market, symbol) {
  return read().filter((a) => a.market === market && a.symbol === symbol);
}

export function addAlert({ market, symbol, price, direction }) {
  const list = read();
  const alert = {
    id: "a_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    market,
    symbol: String(symbol).toUpperCase(),
    price: Number(price),
    direction, // "above" | "below"
    createdAt: Date.now(),
    triggered: false,
    triggeredAt: null,
  };
  write([...list, alert]);
  return alert;
}

export function removeAlert(id) {
  write(read().filter((a) => a.id !== id));
}

export function resetAlert(id) {
  write(read().map((a) => (a.id === id ? { ...a, triggered: false, triggeredAt: null } : a)));
}

// Ask for notification permission (call from a user gesture like adding an
// alert). Returns the resulting permission string; degrades gracefully.
export async function ensureNotificationPermission() {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission === "granted" || Notification.permission === "denied") {
    return Notification.permission;
  }
  try { return await Notification.requestPermission(); } catch { return "default"; }
}

function notify(alert) {
  const dir = alert.direction === "above" ? "above" : "below";
  const title = `${alert.symbol} ${dir} ${alert.price}`;
  const body = `Price alert triggered: ${alert.symbol} is ${dir} ${alert.price}.`;
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(title, { body, tag: alert.id });
      return;
    }
  } catch { /* fall through to console */ }
  // Fallback: a console note (the in-app toast handles the visible cue).
  if (typeof console !== "undefined") console.info("[Alert]", body);
}

// Check the current price against all alerts for a symbol. Crossing logic:
// "above" fires when price >= threshold, "below" when price <= threshold.
// Only fires untriggered alerts; returns the alerts that fired this call so the
// UI can show a toast. Persists the triggered state.
export function checkAlerts(market, symbol, price) {
  if (price == null || Number.isNaN(price)) return [];
  const list = read();
  const fired = [];
  let changed = false;
  for (const a of list) {
    if (a.triggered || a.market !== market || a.symbol !== String(symbol).toUpperCase()) continue;
    const hit = a.direction === "above" ? price >= a.price : price <= a.price;
    if (hit) {
      a.triggered = true;
      a.triggeredAt = Date.now();
      changed = true;
      fired.push(a);
      notify(a);
    }
  }
  if (changed) write(list);
  return fired;
}

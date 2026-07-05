// ═══════════════════════════════════════════════════════════════
// liquidGlass — WebGL "liquid glass" signature look (naughtyduk/liquidGL)
// ported from mmmxcix-casino. The vendored /public/liquidGL.js is PATCHED
// (mmmxcix): lens elements are hidden in the html2canvas clone via
// onclone + visibility:hidden (keyed on data-lg-attached) instead of
// being removed — removal reflows the clone and every lens refracts the
// wrong page region. NEVER replace it with a fresh CDN copy.
//
// Hard-won rules (from the casino integration — keep them):
//  · the renderer is a singleton (window.__liquidGLRenderer__) — NEVER
//    destroy/re-init it; new elements get renderer.addLens(), content
//    changes only need captureSnapshot()
//  · the snapshot root is <body> (in-flow). html2canvas CRASHES
//    ("non-finite addColorStop") on a position:fixed element with
//    gradients as snapshot ROOT — so the animated .ambient-bg layer is
//    fixed (auto-excluded from the snapshot) and body keeps a plain
//    dark background-color as the texture base.
//  · the lib sets pointer-events:none + background:transparent inline
//    on every target → src/glass.css restores both (tint !important)
//  · all lens targets share ONE z-index (glass.css forces 50; the
//    shared canvas sits at 49); fixed chrome (sidebar) is NOT a lens —
//    it uses live CSS backdrop-filter frost (.lg-frost)
//  · reveal:"fade" animates ALL lenses globally → first init only
//  · the lib debounces window resize internally (250ms → resizeCanvas +
//    captureSnapshot); no extra resize handling needed here
// ═══════════════════════════════════════════════════════════════

const HTML2CANVAS_SRC =
  "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";
const LIQUIDGL_SRC = "/liquidGL.js";

// Casino's real production settings (from its index.html demo tuning,
// NOT the README preset): crystal-clear glass, visible refraction warp,
// deep narrow bevel. specular OFF (the animated white highlights read
// as glowing dots drifting across every pane — distracting).
const DEFAULTS = {
  snapshot: "body", // in-flow root — see crash note above
  target: ".lg-glass",
  resolution: 2.0,
  refraction: 0.026,
  bevelDepth: 0.119,
  bevelWidth: 0.057,
  frost: 0,
  shadow: false,
  specular: false,
  tilt: false,
  tiltFactor: 5,
  magnify: 1,
  reveal: "none",
};

const state = {
  active: false,
  opts: { ...DEFAULTS },
  pollTimer: null,
  refreshTimer: null,
  heartbeat: null,
  revealGuard: null,
  watchdogs: [],
  domObserver: null,
  scripts: new Map(), // src → Promise
};

/* ── environment gates ─────────────────────────────────────────── */

function isBrowser() {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

function hasWebGL() {
  try {
    const c = document.createElement("canvas");
    return !!(
      window.WebGLRenderingContext &&
      (c.getContext("webgl2") || c.getContext("webgl") || c.getContext("experimental-webgl"))
    );
  } catch {
    return false;
  }
}

// Mobile GPUs/browsers routinely choke on a full-viewport html2canvas
// snapshot at resolution 2.0 (oversized texture, silently black canvas).
// Skip WebGL there entirely — the CSS backdrop-filter glass in glass.css
// (the same fallback desktop shows before init) handles them.
function isMobileViewport() {
  return (
    window.innerWidth <= 820 ||
    window.matchMedia?.("(pointer: coarse)")?.matches
  );
}

/* ── script loading (once) ─────────────────────────────────────── */

function loadScriptOnce(src) {
  if (state.scripts.has(src)) return state.scripts.get(src);
  const p = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.lgLoaded) return resolve();
      existing.addEventListener("load", resolve, { once: true });
      existing.addEventListener("error", reject, { once: true });
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => {
      s.dataset.lgLoaded = "1";
      resolve();
    };
    s.onerror = () => reject(new Error(`liquidGlass: failed to load ${src}`));
    document.head.appendChild(s);
  });
  state.scripts.set(src, p);
  p.catch(() => state.scripts.delete(src)); // allow retry on next init
  return p;
}

/* ── renderer helpers (casino-proven) ──────────────────────────── */

/** Debounced re-snapshot — the documented-safe way to refresh the lens
 *  texture after page content changed. */
function refreshSnapshot(delay = 450) {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(() => {
    try {
      window.__liquidGLRenderer__?.captureSnapshot?.();
    } catch {
      /* keep CSS glass */
    }
  }, delay);
}

// data-lg-attached does double duty: marks the element as lensed AND
// tells the PATCHED library snapshot to hide it via onclone with
// visibility:hidden (keeps layout space — never data-liquid-ignore,
// which removes it and reflows the clone).
function markAttached(el) {
  el.dataset.lgAttached = "1";
  el.removeAttribute("data-liquid-ignore");
}

/** Drop lenses whose elements left the DOM (route changes). */
function pruneLenses() {
  const r = window.__liquidGLRenderer__;
  if (!r?.lenses) return;
  r.lenses = r.lenses.filter((lens) => {
    const alive = lens.el?.isConnected;
    if (!alive) {
      lens._shadowEl?.remove?.();
      lens._mirror?.remove?.();
    }
    return alive;
  });
}

/** Give every NEW glass element a lens (instant — the global fade is
 *  for the initial load only). */
function attachNewLenses() {
  const r = window.__liquidGLRenderer__;
  if (!r) return;
  document.querySelectorAll(state.opts.target).forEach((el) => {
    if (el.dataset.lgAttached) return;
    try {
      r.addLens(el, state.opts);
      markAttached(el);
    } catch {
      /* leave CSS glass on this element */
    }
  });
}

/* ── public API ────────────────────────────────────────────────── */

/**
 * Initialise the liquid-glass system on `options.target` (default
 * ".lg-glass"). Safe to call from a useEffect on every mount: SSR-safe,
 * feature-detected, idempotent (renderer is a singleton). Without
 * WebGL/scripts the CSS fallback in glass.css simply stays.
 */
export function initLiquidGlass(options = {}) {
  if (!isBrowser()) return; // SSR — no-op
  state.opts = { ...DEFAULTS, ...options };
  state.active = true;

  if (isMobileViewport() || !hasWebGL()) return; // CSS glass only

  // Kick off script loads (once); polling below waits for globals.
  loadScriptOnce(HTML2CANVAS_SRC).catch(() => {});
  loadScriptOnce(LIQUIDGL_SRC).catch(() => {});

  let attempts = 0;
  const tryInit = () => {
    if (!state.active) return;
    const ready =
      typeof window.liquidGL === "function" &&
      typeof window.html2canvas === "function" &&
      document.querySelector(state.opts.target);
    if (!ready) {
      if (++attempts < 40) state.pollTimer = setTimeout(tryInit, 250);
      return; // scripts blocked / no targets yet → CSS glass stays
    }

    const renderer = window.__liquidGLRenderer__;
    if (renderer?.canvas) renderer.canvas.style.display = "";

    if (renderer) {
      // Re-mount (e.g. after destroy) — renderer survives, just reattach.
      document.documentElement.classList.add("lg-on");
      pruneLenses();
      attachNewLenses();
      refreshSnapshot(150);
    } else {
      try {
        // Singleton + first lenses. reveal:"fade" ONLY here.
        window.liquidGL({ ...state.opts, reveal: "fade" });
        document
          .querySelectorAll(state.opts.target)
          .forEach(markAttached);
        attachNewLenses(); // anything the constructor run missed
        document.documentElement.classList.add("lg-on");
        // The constructor snapshot ran BEFORE data-lg-attached was set —
        // recapture so the texture doesn't contain the panels themselves.
        refreshSnapshot(400);

        // Watchdog 1: the constructor's first snapshot can fail silently.
        state.watchdogs.push(
          setTimeout(() => {
            const rd = window.__liquidGLRenderer__;
            if (rd && !rd.texture && !rd._capturing) rd.captureSnapshot?.();
          }, 1500)
        );
        // Watchdog 2: if the fade reveal stalls (throttled rAF), force
        // everything visible — invisible UI is never acceptable.
        state.watchdogs.push(
          setTimeout(() => {
            const rd = window.__liquidGLRenderer__;
            if (!rd) return;
            if (rd.canvas) rd.canvas.style.opacity = "1";
            rd.lenses?.forEach((ln) => {
              if (ln.el && getComputedStyle(ln.el).opacity === "0") {
                ln.el.style.opacity = ln.originalOpacity || 1;
              }
            });
          }, 4000)
        );
      } catch (e) {
        console.warn("liquidGL init failed — falling back to CSS glass:", e);
        return;
      }
    }

    // New glass elements (route changes, modals, async cards) → lens +
    // debounced texture refresh.
    if (!state.domObserver) {
      state.domObserver = new MutationObserver((mutations) => {
        if (!window.__liquidGLRenderer__ || !state.active) return;
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node.nodeType !== 1) continue;
            if (
              node.matches?.(state.opts.target) ||
              node.querySelector?.(state.opts.target)
            ) {
              pruneLenses();
              attachNewLenses();
              refreshSnapshot(350);
              return;
            }
          }
        }
      });
      state.domObserver.observe(
        document.getElementById("root") ?? document.body,
        { childList: true, subtree: true }
      );
    }

    // Heartbeat re-snapshot: repairs stale textures after async content
    // changed the page (chart redraws, loaded data) — a stale texture
    // shows up as a smeared/foggy lens.
    if (!state.heartbeat) {
      state.heartbeat = setInterval(() => refreshSnapshot(50), 10000);
    }

    // Permanent reveal failsafe: a lens stuck at opacity 0 means an
    // INVISIBLE panel — never acceptable.
    if (!state.revealGuard) {
      state.revealGuard = setInterval(() => {
        const rd = window.__liquidGLRenderer__;
        if (!rd) return;
        if (rd.canvas && rd.canvas.style.opacity === "0") {
          rd.canvas.style.opacity = "1";
        }
        rd.lenses?.forEach((ln) => {
          if (ln.el?.isConnected && getComputedStyle(ln.el).opacity === "0") {
            ln.el.style.opacity = ln.originalOpacity || 1;
          }
        });
      }, 1000);
    }
  };

  tryInit();
}

/**
 * Deactivate the effect. Per the casino rules the singleton renderer is
 * NEVER destroyed — its shared canvas is hidden and all observers/timers
 * stop; initLiquidGlass() re-attaches later. The CSS fallback glass
 * returns automatically (html.lg-on is removed).
 */
export function destroyLiquidGlass() {
  state.active = false;
  clearTimeout(state.pollTimer);
  clearTimeout(state.refreshTimer);
  clearInterval(state.heartbeat);
  clearInterval(state.revealGuard);
  state.watchdogs.forEach(clearTimeout);
  state.watchdogs = [];
  state.heartbeat = null;
  state.revealGuard = null;
  state.domObserver?.disconnect();
  state.domObserver = null;
  if (isBrowser()) {
    document.documentElement.classList.remove("lg-on");
    const c = window.__liquidGLRenderer__?.canvas;
    if (c) c.style.display = "none"; // hide, never destroy
  }
}

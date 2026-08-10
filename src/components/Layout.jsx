import { useState, useEffect, useRef } from "react";
import { NavLink, Link, useLocation } from "react-router-dom";
import { LayoutDashboard, CandlestickChart, FlaskConical, Newspaper, Compass, Wrench, Activity, Scale, Star, Briefcase, Radar, GraduationCap, Sigma, Menu, X, Target, BookOpenCheck, Telescope, Cpu, Sun, Moon, Monitor, Waypoints, Search, LogIn , Landmark, Globe, Radio, Palette, ChevronDown, Pin, PinOff, User} from "lucide-react";
import { cn } from "@/lib/utils";
import DitherBackground from "@/components/DitherBackground";
import CommandPalette from "@/components/CommandPalette";
import Brandmark, { BrandGlyph } from "@/components/Brandmark";
import { authClient, useSession, signOut } from "@/lib/authClient";
import { THEME_MODES, applyThemeMode, getThemeMode, storeThemeMode } from "@/lib/theme";
import { syncFromServer as syncPrefs, restoreBackups } from "@/lib/portfolio";
import { initDigestAutoResync } from "@/lib/digestSync";

// ⌘ on macOS, Ctrl elsewhere — shown in the quick-nav affordance.
const KBD_HINT = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform) ? "⌘K" : "Ctrl K";
const openPalette = () => window.dispatchEvent(new Event("open-command-palette"));

// Theme mode ("light" | "dark" | "system") — a per-ACCOUNT preference: stored
// on the user via Better Auth, mirrored to localStorage for the before-paint
// script, so an account that picks dark stays dark on every device and reload
// until it switches back. Signed-out visitors keep a device-local mode.
function useTheme() {
  const { data: session } = useSession();
  const [mode, setModeState] = useState(getThemeMode);
  const lastAccountTheme = useRef(null);

  // The account's stored preference wins whenever it (newly) arrives or
  // changes — that's what makes "dark on one device" mean dark everywhere.
  useEffect(() => {
    const t = session?.user?.theme;
    if (t && THEME_MODES.includes(t) && t !== lastAccountTheme.current) {
      lastAccountTheme.current = t;
      setModeState(t);
      storeThemeMode(t);
    }
  }, [session?.user?.theme]);

  // Apply on change; in system mode follow the OS live.
  useEffect(() => {
    applyThemeMode(mode);
    if (mode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyThemeMode("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [mode]);

  const setMode = (next) => {
    setModeState(next);
    storeThemeMode(next);
    applyThemeMode(next);
    // Persist on the account so every device follows (fire-and-forget).
    if (session?.user) authClient.updateUser({ theme: next }).catch(() => { /* offline */ });
  };

  return [mode, setMode];
}

function ThemeToggle({ className }) {
  const [mode, setMode] = useTheme();
  const next = THEME_MODES[(THEME_MODES.indexOf(mode) + 1) % THEME_MODES.length];
  const Icon = mode === "dark" ? Moon : mode === "system" ? Monitor : Sun;
  return (
    <button
      onClick={() => setMode(next)}
      aria-label={`Theme: ${mode} — switch to ${next}`}
      title={`Theme: ${mode} · click for ${next}`}
      className={cn("inline-flex items-center justify-center rounded-lg border border-line text-dim hover:text-text transition-colors", className)}
    >
      <Icon className="w-4 h-4" />
    </button>
  );
}

// Four functional groups: follow the markets → manage what you hold →
// build and test strategies → learn the craft.
const NAV_GROUPS = [
  {
    label: "Markets",
    items: [
      { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
      { to: "/charts", label: "Charts", icon: CandlestickChart },
      { to: "/screener", label: "Screener", icon: Radar },
      { to: "/news", label: "News", icon: Newspaper },
      { to: "/map", label: "World Map", icon: Globe },
      { to: "/macro", label: "Macro", icon: Landmark },
    ],
  },
  {
    label: "Strategy",
    items: [
      { to: "/backtest", label: "Backtest", icon: FlaskConical },
      { to: "/regimes", label: "Regimes", icon: Waypoints },
      { to: "/portfolio", label: "Portfolio", icon: Briefcase },
      { to: "/tools", label: "Tools", icon: Wrench },
      // Argus is public — anyone can watch what the agent does (paper only). The
      // Cortex research system stays dev-only (see DEV_ITEMS).
      { to: "/argus", label: "Argus", icon: Radio },
    ],
  },
  {
    label: "Learn",
    items: [
      { to: "/learn", label: "Academy", icon: GraduationCap },
    ],
  },
];

// Dev-only nav entries appear ONLY for the signed-in admin (dev) account —
// other users don't see that these areas exist. Routes are guarded server-side
// and by RequireAdmin either way; this is just menu visibility.
function useDevNav() {
  const { data: session } = useSession();
  return session?.user?.role === "admin";
}

const DEV_ITEMS = {
  Strategy: [{ to: "/cortex", label: "Cortex", icon: Cpu }],
  Learn: [{ to: "/coach", label: "Coach", icon: Target }],
};

const NAV_GROUPS_KEY = "quant_nav_groups";
function loadGroupState() {
  try { return JSON.parse(localStorage.getItem(NAV_GROUPS_KEY) || "{}"); } catch { return {}; }
}

const NAV_PINNED_KEY = "quant_nav_pinned";
function loadPinned() {
  try { const v = JSON.parse(localStorage.getItem(NAV_PINNED_KEY) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}

// One nav row: the link plus a hover pin toggle. The pin is a SIBLING of the
// anchor (not nested inside it) so the markup stays valid. Reused by the Pinned
// section and the groups.
function NavRow({ item, collapsed, onNavigate, pinned, onTogglePin }) {
  const { to, label, icon: Icon, end } = item;
  return (
    <div className="relative group">
      <NavLink
        to={to} end={end} onClick={onNavigate} title={collapsed ? label : undefined}
        className={({ isActive }) => cn(
          "relative flex items-center rounded-lg text-sm transition-colors",
          collapsed ? "justify-center px-0 py-2.5" : "gap-2.5 pl-3 pr-7 py-[7px]",
          isActive ? "bg-accent/10 text-accent font-medium" : "text-dim hover:text-text hover:bg-surface"
        )}
      >
        <Icon className="w-4 h-4 shrink-0" />
        {!collapsed && <span className="truncate">{label}</span>}
      </NavLink>
      {!collapsed && (
        <button
          type="button" aria-label={pinned ? `Unpin ${label}` : `Pin ${label}`}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onTogglePin(to); }}
          className={cn(
            "absolute right-1.5 top-1/2 -translate-y-1/2 grid place-items-center w-5 h-5 rounded transition-opacity",
            pinned ? "text-accent opacity-100" : "text-dim opacity-0 group-hover:opacity-100 hover:text-text"
          )}
        >
          <Star className={cn("w-3.5 h-3.5", pinned && "fill-current")} />
        </button>
      )}
    </div>
  );
}

function NavItems({ onNavigate, collapsed = false }) {
  const isDev = useDevNav();
  const { pathname } = useLocation();
  const containerRef = useRef(null);
  const [rail, setRail] = useState(null); // { top, height } of the active item
  const [openGroups, setOpenGroups] = useState(loadGroupState); // { label: false } = collapsed
  const [pinned, setPinned] = useState(loadPinned); // ordered list of pinned `to` paths
  const groups = isDev
    ? NAV_GROUPS.map((g) => (DEV_ITEMS[g.label] ? { ...g, items: [...g.items, ...DEV_ITEMS[g.label]] } : g))
    : NAV_GROUPS;

  const groupOpen = (label) => collapsed || openGroups[label] !== false; // default open
  const toggleGroup = (label) => setOpenGroups((s) => {
    const next = { ...s, [label]: s[label] === false ? true : false };
    try { localStorage.setItem(NAV_GROUPS_KEY, JSON.stringify(next)); } catch { /* private mode */ }
    return next;
  });
  const pinnedSet = new Set(pinned);
  const togglePin = (to) => setPinned((p) => {
    const next = p.includes(to) ? p.filter((x) => x !== to) : [...p, to];
    try { localStorage.setItem(NAV_PINNED_KEY, JSON.stringify(next)); } catch { /* private mode */ }
    return next;
  });
  // Pinned rows, in the order they were pinned, dropping any that no longer exist
  // (e.g. a dev-only item after signing out).
  const allItems = groups.flatMap((g) => g.items);
  const pinnedItems = pinned.map((to) => allItems.find((i) => i.to === to)).filter(Boolean);

  // The active accent bar is ONE element that slides to the active item on
  // navigation (shared-layout feel) instead of popping per item.
  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const el = c.querySelector('[aria-current="page"]');
    if (el) setRail({ top: el.offsetTop + 6, height: el.offsetHeight - 12 });
    else setRail(null);
  }, [pathname, isDev, collapsed, openGroups, pinned]);

  return (
    <div ref={containerRef} className="relative">
      {rail && (
        <span
          aria-hidden="true"
          className="nav-rail absolute -left-2 w-[3px] rounded-full bg-accent"
          style={{ top: rail.top, height: rail.height }}
        />
      )}
      {!collapsed && pinnedItems.length > 0 && (
        <div className="mb-2">
          <p className="px-3 mb-1 text-[9px] font-semibold uppercase tracking-[0.2em] text-dim flex items-center gap-1.5">
            <Star className="w-2.5 h-2.5 fill-current" /> Pinned
          </p>
          {pinnedItems.map((item) => (
            <NavRow key={`pin-${item.to}`} item={item} collapsed={collapsed} onNavigate={onNavigate} pinned onTogglePin={togglePin} />
          ))}
        </div>
      )}
      {groups.map((group, gi) => {
        const open = groupOpen(group.label);
        return (
          <div key={group.label} className={collapsed && gi > 0 ? "mt-2 pt-2 border-t border-line/60" : ""}>
            {!collapsed && (
              <button
                type="button"
                onClick={() => toggleGroup(group.label)}
                className={cn(
                  "group flex w-full items-center gap-1 px-3 text-[9px] font-semibold uppercase tracking-[0.2em] text-dim transition-colors hover:text-text",
                  gi === 0 ? "mb-1" : "mt-4 mb-1"
                )}
              >
                {group.label}
                <ChevronDown className={cn("ml-auto w-3 h-3 opacity-0 group-hover:opacity-100 transition-[transform,opacity]", open ? "" : "-rotate-90 opacity-60")} />
              </button>
            )}
            {open && group.items.map((item) => (
              <NavRow key={item.to} item={item} collapsed={collapsed} onNavigate={onNavigate} pinned={pinnedSet.has(item.to)} onTogglePin={togglePin} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

// Signed-in state + entry/exit, at the bottom of the sidebar / drawer. The dev
// account is labelled; sign-out revokes the server-side session.
function SessionBox() {
  const { data: session, isPending } = useSession();
  if (isPending) return null;
  // Guard on session.user, not just session: an auth hiccup can return a
  // truthy error-shaped object, and SessionBox lives in the always-mounted
  // shell — an unguarded read here white-screens the entire app.
  if (!session?.user) {
    return (
      <Link
        to="/login"
        className="flex items-center gap-2 rounded-lg border border-line bg-surface/60 px-3 py-1.5 text-xs text-dim transition-colors hover:text-text"
      >
        <LogIn className="h-3.5 w-3.5" /> Sign in
      </Link>
    );
  }
  return (
    <div className="rounded-lg border border-line bg-surface/60 px-3 py-2">
      <Link to="/account" className="block truncate text-xs text-text transition-colors hover:text-accent" title="Account settings (2FA …)">
        {session.user.name || session.user.email}
      </Link>
      <div className="mt-0.5 flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wide text-dim">
          {session.user.role === "admin" ? "dev account" : "account"}
        </span>
        <button onClick={() => signOut()} className="text-[10px] text-dim transition-colors hover:text-text">
          Sign out
        </button>
      </div>
    </div>
  );
}

function LegalLinks({ small }) {
  const c = small ? "text-[10px] text-dim hover:text-dim" : "text-xs text-dim hover:text-text";
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      <Link to="/impressum" className={cn("transition-colors", c)}>Legal Notice</Link>
      <Link to="/datenschutz" className={cn("transition-colors", c)}>Privacy</Link>
      <Link to="/nutzung" className={cn("transition-colors", c)}>Terms</Link>
    </div>
  );
}

export default function Layout({ children }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  // The desktop sidebar is a slim icon rail that auto-EXPANDS ON HOVER — no click.
  // A pin locks it open (content shifts over); unpinned, the expanded panel just
  // overlays the content so hovering never reflows the page.
  const [pinned, setPinned] = useState(() => {
    try { return localStorage.getItem("quant_sidebar_pinned") === "1"; } catch { return false; }
  });
  const [hoverOpen, setHoverOpen] = useState(false);
  const expanded = pinned || hoverOpen;
  const collapsed = !expanded; // the rail look (drives brand/labels/footer variants)
  const togglePinned = () => setPinned((p) => {
    const n = !p;
    try { localStorage.setItem("quant_sidebar_pinned", n ? "1" : "0"); } catch { /* private mode */ }
    return n;
  });
  const location = useLocation();

  // Durability: recover any locally-backed-up watchlist/portfolio entries, then
  // merge with the server copy so a localStorage clear can never lose them.
  useEffect(() => {
    restoreBackups();
    syncPrefs();
    // Keeps an active digest subscription's symbol list in sync with the live
    // portfolio/watchlist — see src/lib/digestSync.js for why this lives here
    // (the persistent app shell) rather than on the News page.
    return initDigestAutoResync();
  }, []);

  // Close the mobile drawer on route change and lock body scroll while open.
  useEffect(() => { setDrawerOpen(false); }, [location.pathname]);
  useEffect(() => {
    document.body.style.overflow = drawerOpen ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [drawerOpen]);

  return (
    <div className="min-h-screen">
      <div className="ambient-bg" aria-hidden="true" />
      <DitherBackground />
      <div className="grain-layer" aria-hidden="true" />
      <CommandPalette />

      {/* Desktop sidebar — slim rail that expands on hover (overlays), or pins open */}
      <aside
        onMouseEnter={() => setHoverOpen(true)}
        onMouseLeave={() => setHoverOpen(false)}
        className={cn(
          "hidden md:flex fixed inset-y-0 left-0 z-40 flex-col border-r border-line lg-frost transition-[width] duration-200",
          collapsed ? "w-16 p-2" : "w-56 p-4",
          expanded && !pinned ? "shadow-2xl shadow-black/50" : ""
        )}
      >
        <div className={cn("pt-2", collapsed ? "mb-4 grid place-items-center" : "mb-5 px-3")}>
          {collapsed
            ? <span className="text-accent"><BrandGlyph className="w-8 h-8" /></span>
            : <Brandmark glyphClass="w-8 h-8" />}
        </div>
        {collapsed ? (
          <button onClick={openPalette} title={`Search — ${KBD_HINT}`}
            className="mb-4 grid place-items-center w-full py-2 rounded-lg border border-line bg-surface/60 text-dim transition-colors hover:text-text hover:border-line/80">
            <Search className="h-4 w-4" />
          </button>
        ) : (
          <button
            onClick={openPalette}
            className="mb-5 flex w-full items-center gap-2 rounded-lg border border-line bg-surface/60 px-3 py-1.5 text-xs text-dim transition-colors hover:text-text hover:border-line/80"
          >
            <Search className="h-3.5 w-3.5" />
            <span>Jump to…</span>
            <kbd className="ml-auto font-mono text-[10px] text-dim">{KBD_HINT}</kbd>
          </button>
        )}
        <nav className="flex flex-col gap-1 overflow-y-auto overflow-x-hidden pr-1 -mr-1">
          <NavItems collapsed={collapsed} />
        </nav>
        <div className={cn("mt-auto", collapsed ? "flex flex-col items-center gap-2 pb-1" : "px-3 pb-2 space-y-2")}>
          {collapsed ? (
            <>
              <ThemeToggle className="w-9 h-9" />
              <NavLink to="/theme" title="Theme & chart colours"
                className={({ isActive }) => cn("grid place-items-center w-9 h-9 rounded-lg border border-line transition-colors",
                  isActive ? "text-accent border-accent/40 bg-accent/10" : "text-dim hover:text-text")}>
                <Palette className="w-4 h-4" />
              </NavLink>
              <NavLink to="/account" title="Account"
                className={({ isActive }) => cn("grid place-items-center w-9 h-9 rounded-lg border border-line transition-colors",
                  isActive ? "text-accent border-accent/40 bg-accent/10" : "text-dim hover:text-text")}>
                <User className="w-4 h-4" />
              </NavLink>
            </>
          ) : (
          <>
          <SessionBox />
          <div className="flex items-center gap-1.5">
            <ThemeToggle className="w-8 h-8" />
            <NavLink to="/theme" title="Theme & chart colours"
              className={({ isActive }) => cn("grid place-items-center w-8 h-8 rounded-lg border border-line transition-colors",
                isActive ? "text-accent border-accent/40 bg-accent/10" : "text-dim hover:text-text")}>
              <Palette className="w-4 h-4" />
            </NavLink>
            <button onClick={togglePinned} title={pinned ? "Unpin — auto-collapse on hover-out" : "Pin sidebar open"}
              className={cn("ml-auto grid place-items-center w-8 h-8 rounded-lg border transition-colors",
                pinned ? "text-accent border-accent/40 bg-accent/10" : "text-dim border-line hover:text-text")}>
              {pinned ? <PinOff className="w-4 h-4" /> : <Pin className="w-4 h-4" />}
            </button>
          </div>
          <p className="text-[10px] text-dim leading-relaxed">
            Not investment advice. Backtests are hypothetical — past performance guarantees nothing.
          </p>
          <LegalLinks small />
          </>
          )}
        </div>
      </aside>

      {/* Mobile top bar: brand + hamburger */}
      <header className="md:hidden sticky top-0 z-30 flex items-center justify-between border-b border-line lg-frost px-4 min-h-14" style={{ paddingTop: "env(safe-area-inset-top)" }}>
        <Brandmark glyphClass="w-6 h-6" sub={false} />
        <div className="flex items-center gap-1">
          <button
            onClick={openPalette}
            aria-label="Search pages"
            className="p-2 rounded-lg text-dim hover:text-text active:bg-surface transition-colors"
          >
            <Search className="w-5 h-5" />
          </button>
          <ThemeToggle className="w-9 h-9" />
          {/* No hamburger here: the bottom tab bar's "More" opens the very same
              drawer, and two controls for one menu is a coin-flip for the user
              (and two tab stops to the same place for a screen reader). The
              bottom one wins — it is thumb-reachable and carries a text label. */}
        </div>
      </header>

      {/* Mobile slide-out drawer */}
      {drawerOpen && (
        <div className="md:hidden fixed inset-0 z-40">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setDrawerOpen(false)} />
          <div className="absolute inset-y-0 right-0 w-72 max-w-[85vw] bg-surface border-l border-line flex flex-col p-4 shadow-2xl animate-[slidein_0.18s_ease-out]">
            <div className="flex items-center justify-between mb-6 px-1">
              <Brandmark glyphClass="w-8 h-8" />
              <button onClick={() => setDrawerOpen(false)} aria-label="Close menu"
                className="p-2 rounded-lg text-dim hover:text-text active:bg-bg transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
            <nav className="flex flex-col gap-1 overflow-y-auto">
              <NavItems onNavigate={() => setDrawerOpen(false)} />
            </nav>
            <div className="mt-auto space-y-3 pt-4 border-t border-line">
              <SessionBox />
              <LegalLinks />
            </div>
          </div>
        </div>
      )}

      <main className={cn("p-3 sm:p-4 md:p-8 pb-24 md:pb-8 transition-[margin] duration-200", pinned ? "md:ml-56" : "md:ml-16")}>
        {/* keyed by route so each page entry replays the reveal. Capped + centred
            here (not on <main>, which needs its sidebar offset) so ultrawide
            screens don't leave the content hugging the left. */}
        <div key={location.pathname} className="view-in mx-auto max-w-[1800px]">{children}</div>
      </main>

      {/* Mobile footer — extra bottom room so the legal links clear the tab bar */}
      <footer className="md:hidden border-t border-line px-4 pt-4 mt-4" style={{ paddingBottom: "calc(5.5rem + env(safe-area-inset-bottom))" }}>
        <LegalLinks />
        <p className="mt-2 text-[10px] text-dim">Not investment advice.</p>
      </footer>

      {/* Mobile bottom tab bar — thumb-friendly primary nav */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-30 lg-frost border-t border-line flex items-stretch"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }} aria-label="Primary">
        {[
          { to: "/", label: "Home", icon: LayoutDashboard, end: true },
          { to: "/charts", label: "Charts", icon: CandlestickChart },
          { to: "/screener", label: "Screener", icon: Radar },
          { to: "/map", label: "Map", icon: Globe },
        ].map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end}
            className={({ isActive }) => cn("flex-1 flex flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium transition-colors",
              isActive ? "text-accent" : "text-dim hover:text-text")}>
            <Icon className="w-[22px] h-[22px]" strokeWidth={1.9} />
            <span>{label}</span>
          </NavLink>
        ))}
        <button onClick={() => setDrawerOpen(true)} aria-expanded={drawerOpen} aria-haspopup="menu"
          className="flex-1 flex flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium text-dim hover:text-text transition-colors">
          <Menu className="w-[22px] h-[22px]" strokeWidth={1.9} aria-hidden="true" /><span>More</span>
        </button>
      </nav>
    </div>
  );
}

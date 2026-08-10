// MMMXCIX Quant — Daily Digest Worker (standalone Cloudflare Worker, NOT a Pages Function).
//
// Sends a personalized daily market digest to every confirmed subscriber:
//   • a MARKET SNAPSHOT strip (BTC / ETH / SPY / QQQ day moves, up/down coloured)
//   • an AI-synthesized MARKET PULSE + curated TOP STORIES (functions/api/briefing.js
//     — same endpoint the on-site Briefing tab uses, one batched call per run)
//   • per-subscriber "YOUR HOLDINGS" cards for their portfolio/watchlist symbols —
//     LLM-confirmed relevance + a grounded why/expectation, not a bare-ticker regex
//   • a raw-teaser fallback (categories/freeOnly/sources) if the briefing call is
//     unreachable or a category comes back empty, so nobody is ever sent nothing
//   • a dynamic subject line carrying the day's biggest moves
//   • a TOKENIZED unsubscribe link + RFC 8058 one-click headers (deliverability)
//
// Setup (KV binding, secrets, cron trigger): see workers/README.md.
// Deploy: `npx wrangler deploy` from workers/ (wrangler.toml beside this file).
//
// Bindings / secrets expected:
//   SUBSCRIBERS       — KV namespace (same one the Pages project uses for /api/subscribe)
//   RESEND_API_KEY    — Resend API key (secret)
//   DIGEST_FROM       — sender address, e.g. "MMMXCIX Quant <digest@mmmxcix.com>"
//   DIGEST_TEST_TOKEN — token for manual test runs via GET ?token=
//
// No secret is needed for the /api/briefing call — it's public + rate-limited
// on that end (same model as functions/api/bias.js), so nothing new to configure.

const NEWS_URL = 'https://quant.mmmxcix.com/api/news';
const BRIEFING_URL = 'https://quant.mmmxcix.com/api/briefing';
const SITE_URL = 'https://quant.mmmxcix.com/news';
const CONFIRM_BASE = 'https://quant.mmmxcix.com/api/subscribe';
const YAHOO_PROXY = 'https://quant.mmmxcix.com/api/yahoo/v8/finance/chart';
const BINANCE_24H = 'https://api.binance.com/api/v3/ticker/24hr';
const RESEND_URL = 'https://api.resend.com/emails';
const MAX_ITEMS = 12;           // items in a "general" digest
const MAX_ITEMS_PER_TOPIC = 8;  // cap per category section in a personalized digest
const SEND_DELAY_MS = 600; // polite sequential sending (well under Resend rate limits)

// Brand tokens — mirrors the site's light theme (src/index.css) so the mail
// reads as the same product: graphite ink, silver hairlines, deep up/down.
const C = {
  ground: '#fafafb',
  card: '#ffffff',
  line: '#e4e4e7',
  ink: '#0c0c0f',
  dim: '#585860',
  faint: '#8a8d94',
  up: '#0b6e47',
  down: '#be2830',
  // Pewter Blue — the site's real, shipped --c-accent (src/index.css), used
  // here to mark AI-synthesized content, same role as BiasSection.jsx's
  // "News & data" card on-site. accentBg/accentBorder are flat-hex email-safe
  // approximations of the site's bg-accent/5 and border-accent/30 tints.
  accent: '#4A648C',
  accentBg: '#f5f7fa',
  accentBorder: '#c9d1dd',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(date) {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'Europe/Zurich',
  });
}

// "3h ago" / "yesterday" — relative time for item pubDates.
function relTime(iso, now) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '';
  const mins = Math.max(0, Math.round((now.getTime() - t) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

const fmtPct = (p) => `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`;
const fmtPrice = (v) =>
  v >= 1000 ? Math.round(v).toLocaleString('en-US') : v >= 10 ? v.toFixed(2) : v.toFixed(4);

// ── market snapshot ─────────────────────────────────────────────────────────
// Best-effort: any symbol that fails is simply omitted; an empty snapshot
// omits the strip entirely. Never blocks the digest.
async function fetchSnapshot() {
  const out = [];
  const jobs = [];

  for (const sym of ['BTCUSDT', 'ETHUSDT']) {
    jobs.push(
      fetch(`${BINANCE_24H}?symbol=${sym}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          const price = +d?.lastPrice, chg = +d?.priceChangePercent;
          if (isFinite(price) && isFinite(chg)) out.push({ label: sym.replace('USDT', ''), price, changePct: chg });
        })
        .catch(() => {})
    );
  }
  for (const sym of ['SPY', 'QQQ']) {
    jobs.push(
      fetch(`${YAHOO_PROXY}/${sym}?range=5d&interval=1d`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          const res = d?.chart?.result?.[0];
          const closes = (res?.indicators?.quote?.[0]?.close || []).filter((c) => isFinite(c));
          const meta = res?.meta?.regularMarketPrice;
          if (closes.length < 2) return;
          const price = isFinite(meta) ? meta : closes[closes.length - 1];
          const prev = closes[closes.length - 2];
          if (prev > 0) out.push({ label: sym, price, changePct: ((price - prev) / prev) * 100 });
        })
        .catch(() => {})
    );
  }

  await Promise.allSettled(jobs);
  // Stable display order.
  const order = { BTC: 0, ETH: 1, SPY: 2, QQQ: 3 };
  out.sort((a, b) => (order[a.label] ?? 9) - (order[b.label] ?? 9));
  return out;
}

// ── news selection ───────────────────────────────────────────────────────
async function fetchAllNews() {
  const res = await fetch(NEWS_URL, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`news fetch failed: HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.items)) throw new Error('news feed returned no items');
  return data.items;
}

// AI-synthesized market pulse + curated stories + per-symbol relevance — ONE
// batched call per run for the UNION of every confirmed subscriber's symbols
// (see runDigest), shared with the on-site Briefing tab. All relevance
// matching now lives in this one endpoint: the old local matchesSymbols() did
// a bare `\bTICKER\b` regex, which matched "NOW" (ServiceNow) against the
// common English word "now" appearing incidentally in unrelated headlines —
// that logic is gone from here, replaced by functions/api/briefing.js's
// LLM-confirmed (or, with no LLM, name-only) matching.
async function fetchBriefing(symbols) {
  try {
    const res = await fetch(BRIEFING_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbols }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// Raw fallback pool (free/source filters only, no relevance matching) — used
// when the briefing call is unreachable, or a category's briefing data comes
// back empty, so a subscriber is never silently sent nothing they asked for.
function rawPool(allItems, prefs) {
  const p = prefs || {};
  const freeOnly = p.freeOnly !== false;
  const sourceSet = Array.isArray(p.sources) && p.sources.length ? new Set(p.sources) : null;
  return allItems.filter((it) => {
    if (freeOnly && it.access !== 'free') return false;
    if (sourceSet && !sourceSet.has(it.source)) return false;
    return true;
  });
}

// Builds one subscriber's sections from the SHARED briefing result (their own
// symbols looked up in it) plus the raw fallback pool for "general".
function buildSections(prefs, allItems, briefing) {
  const p = prefs || {};
  const categories = Array.isArray(p.categories) && p.categories.length ? p.categories : ['general'];
  const sections = [];

  if (categories.includes('portfolio') || categories.includes('watchlist')) {
    const label = categories.includes('portfolio') && categories.includes('watchlist')
      ? 'Your symbols' : categories.includes('portfolio') ? 'Your portfolio' : 'Your watchlist';
    const mySymbols = [...new Set((p.symbols || []).map((s) => String(s.symbol || '').toUpperCase()).filter(Boolean))];
    const holdings = mySymbols
      .map((sym) => (briefing?.symbols?.[sym] ? { symbol: sym, ...briefing.symbols[sym] } : null))
      .filter((h) => h && (h.relevantHeadlines?.length > 0 || h.why))
      .slice(0, MAX_ITEMS_PER_TOPIC);
    if (holdings.length) sections.push({ kind: 'holdings', label, holdings });
  }

  if (categories.includes('general')) {
    if (briefing?.stories?.length) {
      sections.push({ kind: 'stories', label: 'Top stories', pulse: briefing.pulse, items: briefing.stories });
    } else {
      const items = rawPool(allItems, p).slice(0, MAX_ITEMS);
      if (items.length) sections.push({ kind: 'raw', label: 'General finance news', items });
    }
  }

  return { sections };
}

// ── email build ─────────────────────────────────────────────────────────────
function unsubscribeUrl(email, token) {
  return `${CONFIRM_BASE}?action=unsub&email=${encodeURIComponent(email)}&token=${encodeURIComponent(token || '')}`;
}

function subjectFor(snapshot, dateStr) {
  // Lead with the two biggest absolute movers — the quant hook in the inbox.
  if (snapshot.length) {
    const movers = [...snapshot].sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct)).slice(0, 2);
    const lead = movers.map((m) => `${m.label} ${fmtPct(m.changePct)}`).join(' · ');
    return `${lead} — MMMXCIX Quant Digest (${dateStr})`;
  }
  return `MMMXCIX Quant — Daily Market Digest (${dateStr})`;
}

function snapshotHtml(snapshot) {
  if (!snapshot.length) return '';
  const cells = snapshot
    .map((m) => {
      const color = m.changePct >= 0 ? C.up : C.down;
      const arrow = m.changePct >= 0 ? '▲' : '▼';
      return `
        <td align="center" style="padding:10px 4px;border:1px solid ${C.line};border-radius:10px;background:${C.ground};">
          <div style="font-size:11px;letter-spacing:1px;color:${C.dim};text-transform:uppercase;">${escapeHtml(m.label)}</div>
          <div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;font-weight:700;color:${C.ink};margin-top:2px;">${fmtPrice(m.price)}</div>
          <div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;font-weight:600;color:${color};margin-top:1px;">${arrow} ${fmtPct(m.changePct)}</div>
        </td>`;
    })
    .join('<td style="width:8px;"></td>');
  return `
    <tr>
      <td style="padding:14px 0 4px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${cells}</tr></table>
      </td>
    </tr>`;
}

function buildEmail(sections, snapshot, date, email, unsubToken) {
  const dateStr = formatDate(date);
  const subject = subjectFor(snapshot, dateStr);
  const unsubUrl = unsubscribeUrl(email, unsubToken);
  const now = date;

  // The market pulse rides on whichever section carries it (the 'stories'
  // section, if the briefing call succeeded) — rendered once, above sections.
  const pulse = sections.find((s) => s.kind === 'stories' && s.pulse)?.pulse;
  let sectionsHtml = pulse
    ? `
      <tr>
        <td style="padding:14px 0 4px 0;">
          <div style="border:1px solid ${C.accentBorder};background:${C.accentBg};border-radius:10px;padding:14px 16px;">
            <div style="font-size:10px;letter-spacing:1px;text-transform:uppercase;color:${C.accent};font-weight:700;margin-bottom:6px;">
              ✦ Market pulse
            </div>
            <div style="font-size:13px;color:${C.ink};line-height:1.6;">${escapeHtml(pulse.summary)}</div>
          </div>
        </td>
      </tr>`
    : '';

  for (const section of sections) {
    const label = `
      <tr>
        <td style="padding:20px 0 6px 0;">
          <span style="display:inline-block;padding:2px 10px;border:1px solid ${C.line};border-radius:999px;
                       font-size:11px;letter-spacing:1px;text-transform:uppercase;color:${C.dim};">
            ${escapeHtml(section.label)}
          </span>
        </td>
      </tr>`;

    // "Your holdings" — one card per symbol: stance lean, grounded why/
    // expectation, then the LLM-confirmed (not bare-ticker-matched) headlines.
    if (section.kind === 'holdings') {
      const cards = section.holdings
        .map((h) => {
          const stanceColor = h.stance === 'long' ? C.up : h.stance === 'short' ? C.down : C.dim;
          const stanceLabel = h.stance === 'long' ? '▲ LONG LEAN' : h.stance === 'short' ? '▼ SHORT LEAN' : '● NEUTRAL';
          const why = h.why
            ? `<div style="font-size:12px;color:${C.ink};line-height:1.5;margin-top:6px;">${escapeHtml(h.why)}</div>`
            : '';
          const expectation = h.expectation
            ? `<div style="font-size:11px;color:${C.accent};line-height:1.5;margin-top:4px;">→ ${escapeHtml(h.expectation)}</div>`
            : '';
          const links = (h.relevantHeadlines || [])
            .slice(0, 3)
            .map(
              (it) => `
            <div style="padding:3px 0;">
              <a href="${escapeHtml(it.link)}" style="color:${C.ink};font-size:12px;text-decoration:none;">${escapeHtml(it.title)}</a>
              <span style="font-size:10px;color:${C.faint};"> · ${escapeHtml(it.source || '')}</span>
            </div>`
            )
            .join('');
          return `
          <tr>
            <td style="padding:0 0 8px 0;">
              <div style="border:1px solid ${C.line};border-radius:10px;padding:12px 14px;">
                <span style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;font-weight:700;color:${C.ink};">${escapeHtml(h.symbol)}</span>
                <span style="font-size:11px;color:${C.dim};margin-left:8px;">${escapeHtml(h.name || '')}</span>
                <div style="font-size:10px;font-weight:700;letter-spacing:0.5px;color:${stanceColor};margin-top:4px;">${stanceLabel}</div>
                ${why}${expectation}
                ${links}
              </div>
            </td>
          </tr>`;
        })
        .join('');
      sectionsHtml += label + cards;
      continue;
    }

    // 'stories' (curated + synthesized) and 'raw' (fallback teaser) sections
    // share the same row shape — 'stories' items carry `synthesis` instead of
    // the publisher's raw `description`.
    const rows = section.items
      .map((it) => {
        const meta = [it.source, relTime(it.pubDate, now)].filter(Boolean).join(' · ');
        const body = it.synthesis || it.description;
        const desc = body
          ? `<div style="font-size:12px;color:${C.dim};line-height:1.5;margin-top:3px;">${escapeHtml(body)}</div>`
          : '';
        return `
          <tr>
            <td style="padding:9px 0;border-bottom:1px solid ${C.line};">
              <a href="${escapeHtml(it.link)}"
                 style="color:${C.ink};font-size:15px;font-weight:600;text-decoration:none;line-height:1.4;">
                ${escapeHtml(it.title)}
              </a>
              ${desc}
              <div style="font-size:11px;color:${C.faint};margin-top:3px;">${escapeHtml(meta)}</div>
            </td>
          </tr>`;
      })
      .join('');
    sectionsHtml += label + rows;
  }

  const html = `
<div style="background:${C.ground};padding:24px 12px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
         style="max-width:560px;margin:0 auto;background:${C.card};border:1px solid ${C.line};border-radius:12px;">
    <tr>
      <td style="padding:28px 28px 8px 28px;">
        <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${C.dim};">
          MMMXCIX Quant
        </div>
        <h1 style="margin:6px 0 0 0;font-size:20px;color:${C.ink};">
          Daily Market Digest
        </h1>
        <div style="margin-top:4px;font-size:13px;color:${C.dim};">${escapeHtml(dateStr)}</div>
      </td>
    </tr>
    <tr>
      <td style="padding:4px 28px 24px 28px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          ${snapshotHtml(snapshot)}
          ${sectionsHtml}
        </table>
      </td>
    </tr>
    <tr>
      <td style="padding:16px 28px 24px 28px;border-top:1px solid ${C.line};">
        <p style="margin:0;font-size:12px;color:${C.dim};line-height:1.6;">
          You're receiving this because you subscribed to and confirmed the MMMXCIX Daily Digest.
          <a href="${unsubUrl}" style="color:${C.ink};">Unsubscribe</a> ·
          <a href="${SITE_URL}" style="color:${C.ink};">more news</a>.
          Not investment advice.
        </p>
      </td>
    </tr>
  </table>
</div>`;

  let text = `MMMXCIX Quant — Daily Market Digest\n${dateStr}\n`;
  if (snapshot.length) {
    text += `\n${snapshot.map((m) => `${m.label} ${fmtPrice(m.price)} (${fmtPct(m.changePct)})`).join(' · ')}\n`;
  }
  if (pulse) text += `\nMarket pulse: ${pulse.summary}\n`;
  for (const section of sections) {
    text += `\n## ${section.label}\n`;
    if (section.kind === 'holdings') {
      for (const h of section.holdings) {
        text += `- ${h.symbol} (${h.name || h.symbol}) — ${h.stance}\n`;
        if (h.why) text += `  ${h.why}\n`;
        if (h.expectation) text += `  → ${h.expectation}\n`;
        for (const it of (h.relevantHeadlines || []).slice(0, 3)) text += `  · ${it.title}\n    ${it.link}\n`;
      }
      continue;
    }
    for (const it of section.items) {
      const meta = [it.source, relTime(it.pubDate, now)].filter(Boolean).join(' · ');
      const body = it.synthesis || it.description;
      text += `- ${it.title}${meta ? ` (${meta})` : ''}\n${body ? `  ${body}\n` : ''}  ${it.link}\n`;
    }
  }
  text += `\n--\nUnsubscribe: ${unsubUrl}\nMore news: ${SITE_URL}\nNot investment advice.\n`;

  return { subject, html, text, unsubUrl };
}

// Confirmation (double opt-in) email — mirrors the one the Pages Function
// sends, used as a fallback for records that signed up while Resend wasn't
// configured on the Pages project.
function buildConfirmEmail(email, token) {
  const link = `${CONFIRM_BASE}?email=${encodeURIComponent(email)}&token=${token}`;
  const html =
    `<div style="background:${C.ground};padding:24px;font-family:system-ui,Segoe UI,sans-serif">` +
    `<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:${C.card};border:1px solid ${C.line};border-radius:12px">` +
    `<tr><td style="padding:28px">` +
    `<div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${C.dim}">MMMXCIX Quant</div>` +
    `<h1 style="margin:6px 0 12px;font-size:20px;color:${C.ink}">Confirm your subscription</h1>` +
    `<p style="color:${C.dim};font-size:14px;line-height:1.6">Please confirm your Daily Digest subscription:</p>` +
    `<p style="margin:20px 0"><a href="${link}" style="background:${C.ink};color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-size:14px">Confirm subscription</a></p>` +
    `<p style="color:${C.faint};font-size:12px">Didn't request this? Just ignore this email.</p>` +
    `</td></tr></table></div>`;
  return {
    subject: 'Confirm your MMMXCIX Quant Digest subscription',
    html,
    text: `Confirm your subscription: ${link}`,
  };
}

function randomToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function listSubscriberRecords(kv) {
  const records = [];
  let cursor = undefined;
  do {
    const page = await kv.list({ prefix: 'sub:', cursor });
    for (const key of page.keys) {
      const email = key.name.slice('sub:'.length);
      const rec = await kv.get(key.name, 'json');
      if (rec && rec.email) records.push(rec);
      else records.push({ email, confirmed: true, legacy: true, prefs: { categories: ['general'], freeOnly: true } });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return records;
}

async function sendMail(env, to, mail) {
  const body = {
    from: env.DIGEST_FROM,
    to: [to],
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  };
  // RFC 8058 one-click unsubscribe headers — mail clients render their own
  // unsubscribe button and deliverability scoring rewards it.
  if (mail.unsubUrl) {
    body.headers = {
      'List-Unsubscribe': `<${mail.unsubUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    };
  }
  const res = await fetch(RESEND_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`resend HTTP ${res.status}`);
}

async function runDigest(env) {
  if (!env.SUBSCRIBERS) throw new Error('KV binding SUBSCRIBERS missing');
  if (!env.RESEND_API_KEY) throw new Error('secret RESEND_API_KEY missing');
  if (!env.DIGEST_FROM) throw new Error('secret DIGEST_FROM missing');

  const [allItems, snapshot] = await Promise.all([fetchAllNews(), fetchSnapshot()]);
  const records = await listSubscriberRecords(env.SUBSCRIBERS);
  const now = new Date();

  // ONE batched synthesis call for the whole run: union every confirmed
  // subscriber's symbols so the shared per-symbol D1 cache in
  // functions/api/briefing.js does the work once, not once per subscriber.
  const symbolUnion = new Map();
  for (const rec of records) {
    if (!rec.confirmed) continue;
    for (const s of rec.prefs?.symbols || []) {
      const key = String(s?.symbol || '').toUpperCase();
      if (key && !symbolUnion.has(key)) symbolUnion.set(key, s);
    }
  }
  const briefing = await fetchBriefing([...symbolUnion.values()]);

  let sent = 0, failed = 0, confirmSent = 0, skippedEmpty = 0;

  for (const rec of records) {
    try {
      // Unconfirmed: send a confirmation email (once), never the digest.
      if (!rec.confirmed) {
        if (!rec.confirmSentAt && rec.confirmToken) {
          await sendMail(env, rec.email, buildConfirmEmail(rec.email, rec.confirmToken));
          rec.confirmSentAt = now.toISOString();
          await env.SUBSCRIBERS.put(`sub:${rec.email}`, JSON.stringify(rec));
          confirmSent++;
          await sleep(SEND_DELAY_MS);
        }
        continue;
      }

      // Legacy records carry no token — mint one so their unsubscribe links
      // are tokenized like everyone else's.
      if (!rec.confirmToken) {
        rec.confirmToken = randomToken();
        await env.SUBSCRIBERS.put(`sub:${rec.email}`, JSON.stringify(rec));
      }

      // Confirmed: build the personalized digest from the shared briefing.
      let { sections } = buildSections(rec.prefs, allItems, briefing);
      // Never go silent on a confirmed subscriber: if a symbol-only prefs set
      // matched nothing today, fall back to general market news so they still
      // get the daily snapshot instead of an unexplained empty inbox.
      if (sections.length === 0) {
        sections = buildSections({ ...rec.prefs, categories: ['general'] }, allItems, briefing).sections;
      }
      if (sections.length === 0) { skippedEmpty++; continue; } // feed truly empty (e.g. news down)
      await sendMail(env, rec.email, buildEmail(sections, snapshot, now, rec.email, rec.confirmToken));
      sent++;
      await sleep(SEND_DELAY_MS);
    } catch {
      failed++;
    }
  }

  return {
    subscribers: records.length, sent, failed, confirmSent, skippedEmpty,
    items: allItems.length, snapshot: snapshot.length,
    briefing: briefing ? { hasLLM: briefing.hasLLM, symbols: Object.keys(briefing.symbols || {}).length, stories: briefing.stories?.length || 0 } : null,
  };
}

// Refresh the /api/vol volatility snapshot (DoltHub → D1). It rides this
// worker's daily cron because the upstream needs ~30-60s per full pull — far
// too slow for a user-facing request, and exactly what a scheduled job is for.
// Needs DEV_ACCESS_TOKEN as a worker secret; without it the call is skipped
// silently (the page then just shows an older snapshot, labelled as stale).
async function syncVolSnapshot(env) {
  if (!env.DEV_ACCESS_TOKEN) return { skipped: 'no_token' };
  try {
    const r = await fetch('https://quant.mmmxcix.com/api/vol', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: env.DEV_ACCESS_TOKEN, sync: true }),
    });
    return await r.json().catch(() => ({ error: 'bad_json' }));
  } catch (e) {
    return { error: String(e.message || e).slice(0, 120) };
  }
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runDigest(env));
    ctx.waitUntil(syncVolSnapshot(env));
  },

  // Manual test runs: GET https://<worker>/?token=<DIGEST_TEST_TOKEN>
  // Preview without sending: GET ?token=<..>&preview=1 → returns the HTML.
  async fetch(request, env) {
    if (request.method !== 'GET') {
      return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
        status: 405,
        headers: { 'content-type': 'application/json' },
      });
    }

    const url = new URL(request.url);
    const token = url.searchParams.get('token');
    if (!env.DIGEST_TEST_TOKEN || token !== env.DIGEST_TEST_TOKEN) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }

    try {
      // Render-only preview: see today's digest in the browser, nothing sent.
      // ?symbols=AAPL,NOW also exercises the "Your holdings" briefing path.
      if (url.searchParams.get('preview')) {
        const [allItems, snapshot] = await Promise.all([fetchAllNews(), fetchSnapshot()]);
        const symbolsParam = url.searchParams.get('symbols');
        const previewSymbols = symbolsParam
          ? symbolsParam.split(',').map((s) => ({ market: 'stock', symbol: s.trim() }))
          : [];
        const briefing = await fetchBriefing(previewSymbols);
        const categories = previewSymbols.length ? ['general', 'portfolio'] : ['general'];
        const { sections } = buildSections({ categories, freeOnly: true, symbols: previewSymbols }, allItems, briefing);
        const mail = buildEmail(sections, snapshot, new Date(), 'preview@example.com', 'preview');
        return new Response(mail.html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }

      const summary = await runDigest(env);
      return new Response(JSON.stringify({ status: 'ok', ...summary }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ status: 'error', message: String(err && err.message) }),
        { status: 500, headers: { 'content-type': 'application/json' } }
      );
    }
  },
};

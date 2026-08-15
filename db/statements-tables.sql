-- Statements by important people, and the themes they were matched to.
--
-- Written by scripts/statements-agent.mjs through /api/statements (machine
-- token), read publicly — the source is public Telegram previews and public RSS.
--
-- WHY A TABLE AND NOT THE argus_kv BLOB. The live feed is a rolling window and
-- would fit in a blob; the point of storing it is that it stops being a rolling
-- window. Every statement kept is one more row in the panel the next study runs
-- on, and `t.me/s/` only pages back as far as a channel's own history — a
-- statement that scrolls off and was never stored is not recoverable at the same
-- fidelity later.
--
-- Volume: the two desks publish ~150 messages a day, of which ~28% are
-- statements and ~20% of those land in a theme. That is ~40 statement rows a
-- day, ~15k a year, at well under 1 KB each. Nothing here strains a 5 GB
-- allowance or a 100,000-write budget.
--
-- Created automatically by functions/_lib/statements.mjs on first use. This file
-- is the readable schema and the manual path:
--   npx wrangler d1 execute mmmxcix-quant-auth --remote --file db/statements-tables.sql

CREATE TABLE IF NOT EXISTS statements (
  id           TEXT PRIMARY KEY,  -- channel:messageId, or a hash for RSS
  at           INTEGER NOT NULL,  -- ms, the moment it was published
  speaker_id   TEXT,              -- roster id from src/lib/statements/parse.js
  speaker      TEXT,
  role         TEXT,
  quote        TEXT NOT NULL,
  subject      TEXT,              -- the "ON <TOPIC>" hint, when the wire gave one
  source       TEXT,              -- channel or feed name
  url          TEXT,

  -- The MEASURED assignment: the fixed lexicon in src/lib/statements/themes.js.
  -- This is the only column any statistic may be attached to, because it is the
  -- one docs/STATEMENTS_FINDINGS.md was computed with.
  themes       TEXT,              -- comma-separated theme ids

  -- The model's opinion, recorded and never applied. Kept so the lexicon can be
  -- audited against it over time — the disagreements are where the next veto
  -- rule comes from. See src/lib/statements/extract.js.
  model_themes TEXT,
  agreement    TEXT,              -- agree | model-wider | model-narrow | disagree
  confidence   TEXT,              -- the model's own, on its own answer
  because      TEXT,

  data         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_statements_at      ON statements (at);
CREATE INDEX IF NOT EXISTS idx_statements_speaker ON statements (speaker_id, at);

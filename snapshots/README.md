# snapshots/ — reserved snapshot layout (stubs)

Static-first data layer (docs/STATIC_FIRST_AUDIT.md §5, docs/BRIEFING.md).
Nothing produces or reads these yet.

- `manifest.json`: every snapshot path, its store, source and cadence.
- `r2/`: **templates** for objects that will live in R2 (public custom domain,
  never behind a Worker). They never carry data in the repo; per-day history
  (`YYYY-MM-DD`) belongs in R2, not in git.
- Committed daily snapshots live in `public/snapshots/` (deployed as static
  files by the Pages build). Not `public/data/`: `.gitignore`'s `data/` matches it.

`test/snapshots.test.mjs` enforces the envelope, the manifest/file match, and
the repo size guard (≤ 50 MB total, ≤ 2 MB per file, no dated files in git).

# Stand & To-do — 14. August 2026

Was fertig ist, was offen ist, in der Reihenfolge, in der es Sinn ergibt.
Ergänzt `docs/HANDOFF.md` (Zustand der Agents) und `docs/BOARD.md` (die
Zugriffsschicht). `docs/DEINE_TODO_LISTE.md` ist historisch (19. Juli) und gilt
nicht mehr.

---

## Abgeschlossen

### Die Zugriffsschicht — Welle 1 · 13./14. Aug

- [x] Katalog: 12 Ressourcen, je eine Deklaration mit geschlossenem
      Argument-Schema, reinem `select` und reinem `digest`
      (`src/lib/board/catalog.js`)
- [x] Endpoint `/api/board`: Katalog-Listing, Einzellesung, Batch bis 12,
      Quellen pro Request memoisiert, Rate-Limit, read-only
- [x] Seite `/board`: Übersicht in einem Request + Inspector über jede Ressource
- [x] Instrumentenliste aus `Monitor.jsx` nach `src/lib/universe.js` gezogen —
      Seite und Schicht lesen EINE Liste
- [x] 27 Tests (Invarianten, Coercion, jede Ressource gegen Fixture); gesamt 423 grün
- [x] Gegen Produktion verifiziert: jede Ressource an echten Payloads, die
      Pages-Function selbst in Node mit gefaktem D1
- [x] Ergebnis: 270 KB Rohdaten → 6,4 KB Digest; Startbatch 4,5 KB

### Die drei Agents

- [x] Argus: RR-Floor auf 1.5, Skip-Regel auf 8 Trades, `breakEvenStudy`,
      `metalabel`, `walkforward`, `explore`, `pace`, Half-life-Script
- [x] Argus-Scorecard: fünf Komponenten pro Trade, reine Aufzeichnung
- [x] Arena: Micro-Price über 35'600 gemeinsame Samples gemessen → **kein Edge**;
      zwei Bugs auf dem Weg gefunden und gefixt
- [x] Kronos: läuft 01:00/13:00, journalisiert **auch die Absagen**

### Die fünf Videos — alle fünf Befunde geshippt

- [x] Setup-Scorecard (Video 3) · Pairs-Screener mit Benjamini-Hochberg (1) ·
      Payoff-Formen in der Registry (2) · Telegram-OSINT-Ingest (4) ·
      Carry-Engine über Perp-Funding (5)

### Diagnosen

- [x] Cortex: sieht **nur Abstracts**, Volltext auf 0 % — empirisch bestätigt
- [x] Argus: die zwei Verlustursachen benannt und gefixt (keine davon erzeugt einen Edge)
- [x] Speicherfrage beantwortet: **D1 reicht** (778 KB von 5 GB, 1 Zeile pro
      Snapshot-Read, 1,49 ms Parse beim Ledger-Cap gegen 10 ms CPU-Limit)

---

## Offen

### 1 · Board Welle 2 — dieselben zwei Funktionen je Ressource

- [ ] `cortex.state` / `cortex.candidates` (Lab)
- [ ] `registry.strategies` (library) — **admin**
- [ ] `vol.snapshot` (DoltHub-IV)
- [ ] `news.telegram` (OSINT)
- [ ] `portfolio.holdings` / `portfolio.watchlist` — **admin**, die ersten
      Ressourcen, die das Sichtbarkeits-Gate wirklich benutzen

### 2 · Board Welle 3

- [ ] Weltkarten-Layer (ships, planes, fires, conflicts, jamming), Macro,
      London-Hub, ML-Memory

### 3 · Der Chat — `/api/ask`

- [ ] Katalog als Tool-Liste (kein Aufwand pro Tool), begrenzte Schleife (≤5 Aufrufe)
- [ ] Provider-Kette aus `/api/generate` wiederverwenden
- [ ] Umschaltbar auf lokale OmniRoute / CLI-Shim wie in `Backtest.jsx`
- [ ] Optional: `scripts/board.mjs` als CLI mit demselben Katalog

### 4 · Speicher — bevor es weh tut

- [ ] **Ledger normalisieren**: eigene D1-Tabelle, denormalisierte Spalten +
      `data`-JSON (Muster: `functions/api/library.js`). Grund: ein D1-Wert ist
      auf ~2 MB begrenzt, ein Jahr à 12 Trades/Tag wären ~5,5 MB — und
      Meta-Labelling will jeden Trade für immer
- [ ] **Historie**: Append-Tabelle für Equity/Heat/Zustand. Heute wird der
      Snapshot überschrieben, „was war letzte Woche" ist unbeantwortbar.
      ~720 Zeilen/Tag = unter 1 % des Write-Budgets
- [ ] Nicht nötig: Vektor-DB. Falls Volltextsuche über News gewünscht: FTS5 in D1

### 5 · Cortex — der grösste Qualitätshebel im Research-Teil

- [ ] **Zuerst die Strukturfrage klären**: die meisten akademischen
      Aktienstrategien sind QUERSCHNITTLICH (Universum ranken, oberstes Dezil
      long). `runBacktest({candles, signalFn})` ist Einzelinstrument-Zeitreihe.
      Wenn die Engine das nicht abbilden kann, ist Scheitern am Gauntlet der
      erwartete Ausgang und kein Befund — das gehört **vor** allem anderen geprüft
- [ ] Volltext holen: PDF-Extractor für OpenAlex (`best_oa_location.pdf_url`),
      SSRN, Zenodo
- [ ] Absagen statt raten: Reproduktions-Checkliste (Universum, Zeitraum,
      Rebalance, Lookback, Kosten) — nicht füllbar ⇒ keine Strategie erzeugen
- [ ] Nach Mechanismen suchen, nicht nach `"trading strategy"` (PEAD,
      Zeitreihen-Momentum, Varianzrisikoprämie, Betting-against-Beta)

### 6 · Eigenes Modell — Phase 2

- [ ] Kronos auf unseren Märkten feintunen
      (`GitHub/Kronos/finetune/train_predictor.py`, RTX 5080, ~13 GB frei,
      Binance-Kerzen unbegrenzt)
- [ ] Durch dasselbe Gauntlet: **unser Modell vs Kronos-base vs Random Walk**,
      auf der bestehenden Bewertungstafel
- [ ] Danach eventuell Tokenizer + Predictor von Grund auf
- [ ] Negative Ergebnisse genauso berichten wie positive

### 7 · Argus — warten, nicht tunen

- [ ] Die nächsten ~100 Trades abwarten. Weiteres Tuning davor ist Rauschanpassung
- [ ] Break-even-Hypothese messen (22 von 68 Verlierern lagen ≥0,5R vorn) —
      braucht die neuen Excursion-Zeitstempel, also neue Trades
- [ ] `node scripts/argus-halflife.mjs`, sobald der Ledger Wochen statt Tage umspannt
- [ ] Meta-Labelling: ~272 weitere Trades, bis es ein Modell liefert
- [ ] **Offene Frage:** 8 Lessons, keine einzige positive — obwohl London
      (+3,66R / 23 Trades) und Off-Hours (+2,36R / 6) die profitablen Buckets
      sind. Warum wird die Gewinnerseite nie zur Lesson?

### 8 · Kleinfunde aus dem Bau der Schicht

- [ ] `tier: 1` in der News-Konfiguration heisst „offiziell/Wire" und umfasst
      drei PR-Newswire-Feeds. Ein `tier:1`-Filter liefert damit
      Pressemitteilungen statt Fed/SEC/BLS. Entscheidung nötig, weil es die
      News-Seite mitverändert
- [ ] Namensdopplung prüfen: „the desk" heisst in der Landing-Copy die ganze
      App, die neue Seite heisst deshalb `/board` — passt das so?

---

## Nur du (aus früheren Sessions — bitte prüfen, ob noch offen)

- [ ] Kostenlosen aisstream.io-Key holen (Schiffsverfolgung)
- [ ] WAF-Rate-Limits im Cloudflare-Dashboard
- [ ] `DEV_ACCESS_TOKEN` rotieren
- [ ] Anwaltliche Durchsicht der Rechtstexte

---

## Grenzen, die gemessen und nicht verhandelbar sind

- Ein **eigenes LLM von Grund auf** ist nicht machbar. Nicht versprechen.
- Ein **kleines feingetuntes Modell in Cortex** würde ihn verschlechtern.
  Cortex' Problem ist gemessen: er sieht nur Abstracts.
- Ein eigenes Modell gehört als **Signalquelle** in die Architektur, nicht als
  Gehirn der Agents.
- Der Board ist **read-only**. Argus' Kommandokanal (close/cancel/reset) bleibt
  in `/api/argus` — eine Allowlist, die nur liest, darf öffentlich sein; eine,
  die handelt, nicht.

# Stand & To-do — 14. August 2026 (aktualisiert nach dem Durchgang)

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

### Projekt 3 · Insider-Trades — 15. Aug

- [x] **Form-4-Ingest** aus dem SEC-Tagesindex in D1 (`insider_filings`,
      `insider_clusters`, `/api/insider`, `scripts/insider-agent.mjs`, täglich
      05:00 über den Daemon). Live-Lauf verifiziert: 506/506 Einreichungen
      geparst, 0 unlesbar
- [x] **Clusterkäufe** (`src/lib/insider/cluster.js`) — datiert nach der
      LETZTEN Meldung, nicht nach dem Handelstag; eine Sammelmeldung mehrerer
      verbundener Einheiten ist KEIN Cluster
- [x] **Historischer Panel** aus den SEC-Quartalsdatensätzen: 21 Quartale,
      962'524 Form 4, davon 73'596 mit Offenmarktkauf (`scripts/insider-backfill.mjs`)
- [x] **Durch die eigene Validierung geschickt → dokumentierter FEHLSCHLAG.**
      Details in `docs/INSIDER_FINDINGS.md`. Kurz: bestes Gitter-Setting Sharpe
      0,24, deflated Sharpe **4,9 %** nach 72 Trials, Walk-Forward 1 von 3
      Fenstern positiv. Cluster schlagen Einzelkäufe (0,24 vs −0,14) und der
      Placebo-Test ist signifikant (p = 0,010) — aber das Niveau trägt nicht.
      Ereignisstudie wird mit dem Horizont **schlechter**, nicht besser
- [x] Zwei eigene Bugs auf dem Weg gefunden und gefixt (Look-ahead über
      Zeitstempel-vs-Kalendertag, fehlender Liquiditätsfilter). Zusammen ergaben
      sie Sharpe 3,67 und +1'199'985 % out-of-sample — beides war der Bug
- [ ] **Bewusst NICHT gebaut:** Oberfläche, Alerting, Conviction-Ranking. Eine
      Seite, die ein Signal behauptet, das die Messung nicht stützt, ist genau
      das, was die Doktrin verbietet
- [ ] **Kongress-Daten:** zurückgestellt, mit Begründung. 45 Tage Meldefrist
      gegen 3 Tage bei Form 4 — und Form 4 ist bei 3 Tagen schon negativ.
      Wenn, dann als Aggregat-Exposure und durch dasselbe Skript

### Projekt 4 · Aussagen → Profiteure — 15./16. Aug

- [x] **Aussagen-Ingest**: historisch über `t.me/s/?before=` rückwärts geblättert
      (`scripts/statements-harvest.mjs`) — **34'342 Nachrichten, 2023-04 bis
      2026-08**; live über `/api/telegram` + `/api/news`
      (`scripts/statements-agent.mjs`, alle 30 min im Daemon)
- [x] **Thema-Extraktion doppelt**: fixes Lexikon (22 Themen, je ein genannter
      Mechanismus) + OmniRoute in zwei erzwungenen JSON-Runden. **Das Modell
      wird AUFGEZEICHNET, nicht angewendet** — ein Klassifikator, der nie
      gemessen wurde, würde jede Zahl still ungültig machen. Erfundene Themen-Ids
      werden verworfen, nicht auf die nächstbeste gemappt
- [x] **Thema → Korb**: 22 US-Körbe, gegen IBKRs Themen-Endpoint gegengeprüft,
      dann handfest verdrahtet (eine API, deren Mitgliedschaft sich ändert, ist
      nicht reproduzierbar)
- [x] **Ereignisstudie → dokumentierter FEHLSCHLAG.** `docs/STATEMENTS_FINDINGS.md`.
      8'676 Aussagen, 1'901 mit Thema, 2'101 bepreiste Ereignisse. Gepoolt 5d:
      **Median −0,14 %, mittlere Hälfte −2,23 % … +2,01 %** — die Streuung ist
      eine Grössenordnung breiter als die Mitte. Placebo mit verschobenen Daten
      **p = 0,781**. 7 Themen über der 30-Ereignis-Schwelle, **keines** überlebt
      (knappstes: crypto p = 0,065, Median −4,98 %)
- [x] **Die Falle war NICHT die Falle.** Erwartet war „in Sekunden eingepreist".
      Gemessen: die Reaktions-Session — die, die die Nachricht aufnimmt, bevor
      jemand handeln kann — bewegt sich im Median **+0,05 %** gegen den Index.
      Es gab kaum eine Bewegung, für die man zu spät sein konnte
- [ ] **Bewusst NICHT gebaut:** Oberfläche, Alerting. Schritt 5 war „erst wenn 4
      etwas zeigt" — 4 zeigt nichts
- [ ] Nächste Hypothese (nicht gestartet): engere Definition einer Aussage — nicht
      „der Präsident erwähnte Öl", sondern „ein konkretes Instrument wurde
      angekündigt, mit benanntem Profiteur und Datum". Kleinere Stichprobe,
      stärkerer Mechanismus; die Messmaschine steht
- [ ] `financialjuice`-Backfill ist **unvollständig abgebrochen**: 59'998
      Nachrichten, aber nur zurück bis **2025-07-06** (WalterBloomberg reicht bis
      2023-04). `node scripts/statements-harvest.mjs --channel financialjuice`
      setzt fort — der Harvester läuft ab der ältesten Id weiter, die schon auf
      der Platte liegt.
      **Bis dahin `--channels WalterBloomberg` benutzen.** Ohne das Flag mischt
      die Studie einen halb geernteten Kanal dazu und kippt die Stichprobe in die
      Gegenwart; die Korpus-Zeile des Skripts zeigt deshalb pro Kanal die
      Abdeckung an

### Projekt 1 · Polymarket — Frage 1 gemessen, Rest überlebt, noch kein Edge (16. Aug)

- [x] **Datenweg gefunden — keiner der beiden aus dem Briefing.** Polymarkets
      eigene Domains sind weiterhin tot (polymarket.com, gamma-api, clob,
      data-api: alle Connect-Fehler, am 16. Aug erneut geprüft). Statt
      eth_getLogs oder Pages-Proxy: **Polymarkets öffentlicher orderbook-Subgraph
      auf Goldsky** antwortet von hier, keylos, in ~0,3 s.
      `api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/orderbook-subgraph/prod/gn`
      Enthält **jeden OrderFilled von 2022-11-21 bis 2026-04-27**. Der Index
      hängt ~100 Tage hinter der Chain — für einen Live-Copier tödlich, für eine
      Studie ideal
- [x] **Gemessene Grenzen** (nicht angenommen): `first` max 1000 ·
      **455'444'548 Fills insgesamt**, Voll-Harvest ist mit 455'000 Requests
      ausgeschlossen · `orderbooks(orderBy:tradesQuantity)` läuft im Subgraph-
      Postgres in einen Statement-Timeout, es gibt also keine billige
      Top-Wallet-Liste · **aber** `where:{maker:0x…}` und `where:{takerAssetId:…}`
      sind indexiert (~0,3 s) — darauf steht der ganze Wallet-zentrische Ansatz
- [x] `scripts/polymarket-harvest.mjs` — Universum wird aus dem **In-Sample-
      Fenster** gezogen (2025-01 bis T=2025-10-01), stratifiziert über die
      Aktivitätsspanne, nie nach Profit. Market Maker (>20k Fills/Seite) werden
      gekappt und **namentlich als `truncated` vermerkt**, nicht still verworfen
- [x] `src/lib/polymarket/trades.js` + `copy.js` — Fill-Dekodierung (Cash-Bein
      bestimmt die Richtung), FIFO-P&L mit sichtbarem offenem Rest, das
      Copy-Fill-Modell (**gleicher Einsatz → schlechterer Preis → WENIGER
      Anteile**), Wallet-p-Werte und Benjamini-Hochberg über alle getesteten
      Wallets. 12 Tests
- [ ] **Der Harvest läuft** (400 Wallets, ~40 min). Erster Anlauf war ein
      Designfehler: Universum absteigend sortiert ⇒ Start bei Market Makern,
      181 MB für 36 Wallets, Kurs auf 10 GB. Jetzt komprimierte Trade-Zeilen
      statt Roh-Events und Verarbeitung von den wenigst-aktiven her
- [x] **Harvest fertig:** 397 Wallets, 776'236 dekodierte Trades, 20 Market Maker
      gekappt und namentlich ausgeschlossen
- [x] **Frage 1 GEMESSEN** (`docs/POLYMARKET_FINDINGS.md`): Ranking in-sample →
      out-of-sample bei den EIGENEN Fills des Leaders. Spearman **0,438**,
      Top-20 OOS **+15,07 %** (17/20 positiv) gegen **−2,30 %** beim Rest,
      48 BH-Überlebende. Sieht nach Edge aus — **ist aber nicht als Edge
      belegt**, siehe unten
- [x] **Die zwei Artefakte gemessen, die dasselbe Bild gratis erzeugen:**
      · **Attrition:** 209 Wallets haben einen In-Sample-Wert und **keinen**
        Out-of-Sample-Wert (58 %). Alles ist auf „hat überlebt" konditioniert —
        dieselbe Verzerrung wie beim Leaderboard, nur durch die Hintertür
      · **Dispositionseffekt, und der entscheidet:** die Top-20 lassen
        **0,653** ihres Kapitals unrealisiert offen, der Rest **0,338** — fast
        das Doppelte. FIFO auf geschlossenen Round Trips zählt nur, was jemand
        zu schliessen BESCHLIESST. Wer Gewinner realisiert und auf Verlierern
        sitzt, gewinnt per Konstruktion — und weil die Gewohnheit stabil ist,
        reproduziert sie sich out of sample und sieht aus wie ein Edge
- [x] **Beide Nachträge aus `f14454e` eingebaut — und sie ändern das Bild:**
      · **Liquidation an der Schnittkante** (offene Positionen zum letzten
        gehandelten Preis, `markedPnl` + `priceBook`, aus Daten die schon da
        waren): **halbiert den Effekt, entfernt ihn aber nicht.**
        rho 0,438 → **0,263**, Top-20 +15,07 % → **+7,16 %**, Rest +0,30 %.
        Der Dispositionseffekt erklärte also rund die Hälfte
      · **Vier rollende Schnittdaten** statt einem (alle ≥ Ende des
        Sampling-Fensters, sonst leakt die Selektion): der Rest überlebt
        **jeden** Schnitt — rho 0,263 / 0,245 / 0,313 / 0,229, Top-20
        +7,16 / +5,12 / +3,52 / +2,72 %, Rest immer nahe null oder negativ.
        Also keine Eigenschaft des Oktobers
      · `unmarkable` = 0,0 % — jede offene Position war bewertbar
- [ ] **Trotzdem noch kein Edge.** Drei bekannte Verzerrungen zeigen alle in
      dieselbe Richtung: es ist die **obere Schranke** (eigene Fills des
      Leaders) · **Attrition bleibt** (209–267 Wallets ohne OOS-Wert; wer ganz
      aufhört, hat auch keinen markierten Wert) · der Mark ist der **letzte
      gehandelte Preis, nicht die Auflösung** · die p-Werte behandeln
      korrelierte Trades als unabhängig, was die 48 BH-Überlebenden aufbläst
- [x] **On-chain-Auflösung: halb gelöst, mit einem konkreten Blocker.**
      · **Die fehlende Brücke ist gefunden.** Eine Token-Id lässt sich nicht zur
        conditionId zurückrechnen (die Ableitung läuft vorwärts über einen
        Kurvenpunkt). Der orderbook-Subgraph schliesst die Lücke: `MarketData`
        ist nach Token-Id verschlüsselt und trägt `{ condition, outcomeIndex }`.
        **121'920 von 121'920 Tokens gemappt**, via `where:{id_in:[…]}` in
        ~240 Requests statt 121'920 (erster Entwurf lief auf zwei Stunden zu)
      · `src/lib/polymarket/resolve.js` — Decoder für `ConditionResolution`
        (Wortlayout `[slotCount][offset][len][p0][p1…]`, Offset wird gelesen
        nicht angenommen) plus Lookup, der eine Auflösung **nach** der
        Bewertungskante verweigert. 3 Tests, u.a. dass „alle Numeratoren null"
        null ergibt und nicht „wertlos"
      · `scripts/polymarket-resolutions.mjs` — beide Phasen, fortsetzbar
- [x] **Blocker umgangen — über State statt Logs (17. Aug).** Der Alchemy-Key ist
      da, aber **Free Tier deckelt `eth_getLogs` bei 10 Blöcken** (5,7 Mio.
      Requests → tot). Eine Auflösung steht aber auch als State im Contract:
      `payoutDenominator(bytes32)` und `payoutNumerators(bytes32,uint256)`.
      `eth_call` hat kein Range-Limit, Archive-`eth_call` und JSON-RPC-Batching
      gehen beide auf dem Free Tier. **Strikt besser als Logs:** ein State-Read
      am Bewertungsblock kann einen später aufgelösten Markt gar nicht sehen —
      der Zukunfts-Leak ist strukturell weg statt nachträglich gefiltert
- [x] `src/lib/polymarket/keccak.js` — Selektoren werden **berechnet, nicht
      erinnert** (Node liefert SHA3-256, nicht keccak256). Festgenagelt an zwei
      Vektoren, der zweite reproduziert `0xb44d84d3…5894` allein aus dem
      Signatur-String
- [x] `scripts/polymarket-payouts.mjs` + `polymarket-rpc-check.mjs`
- [ ] **Drossel-Falle, für die Zukunft:** Alchemy antwortet auf eine überlastete
      Batch **nicht** mit 429, sondern HTTP 200 mit „exceeded its compute units
      per second capacity" in den **einzelnen** Calls. Erster Lauf verbuchte das
      als „nicht aufgelöst" → 629/28'586 und 0 bewertete Tokens, beides reiner
      Rate-Limiter. Jetzt Requeue + selbstregelnder Takt + unbeantwortete Calls
      werden gezählt und gedruckt
- [ ] **Läuft gerade:** Payout-Scan an der Out-of-Sample-Kante. Pass 1 durch —
      **84'422 von 85'502** beantworteten Bedingungen waren zur Kante bereits
      aufgelöst (98,7 %), 443 unbeantwortet. Pass 2 (Numeratoren) läuft, ~1,5 h.
      Danach nur noch `node scripts/polymarket-validate.mjs` — das Skript liest
      `payouts.json` automatisch und rechnet die dritte Bewertung
- [ ] Historisch, erledigt durch den State-Weg: kein freier RPC liefert Logs. Gemessen,
      nicht vermutet: `polygon-bor-rpc.publicnode.com` hat die Historie
      **gepruned** (nur kopfnah lieferbar) · `polygon.drpc.org` lehnt
      `eth_getLogs` mit Range auf dem Free Plan generell ab (auch bei 2'000
      Blöcken) · `1rpc.io` deckelt bei **50 Blöcken** · Ankr und Blast wollen
      Schlüssel · `llamarpc` antwortet leer. Auch die Geschwister-Subgraphen
      helfen nicht: `oi-subgraph` und `fpmm-subgraph` leben, aber ihr
      `Condition` hat nur ein Feld — `id`, keine Payouts.
      **Fix, eine Minute Arbeit für dich:** ein kostenloser Archive-Key
      (Alchemy/Infura/QuickNode haben alle Polygon-Archive im Free Tier), dann
      `PM_RPC=<url> node scripts/polymarket-resolutions.mjs --phase resolutions`.
      Das Skript ist fertig und wartet nur auf den Endpunkt
- [ ] **Danach:** CTF-Contract
      `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045`, `ConditionResolution` =
      Topic `0xb44d84d3…5894`, `payoutNumerators` im Datenteil, über
      `eth_getLogs` an `polygon-bor-rpc.publicnode.com` (alles in `f14454e`
      verifiziert). Beide Bewertungen nebeneinander; wo sie auseinanderlaufen,
      ist das selbst ein Befund. **Erst danach** lohnt das Fill-Modell
- [ ] **NOCH NICHT GEBAUT: die zweite Harvest-Phase** — pro OOS-Trade eines
      gerankten Wallets die Tape des Tokens ab `t+delay` (aliasierte
      GraphQL-Batches, geschätzt ~500 Requests). Ohne sie kann `replayCopy`
      nicht laufen
- [ ] Frage 2 (unser Fill) bleibt ungebaut — sie lohnt erst, wenn Frage 1
      sauber beantwortet ist. Nichts in diesem Repo behauptet, dass Copytrading
      auf Polymarket funktioniert

### Diagnosen

- [x] Cortex: sieht **nur Abstracts**, Volltext auf 0 % — empirisch bestätigt
- [x] Argus: die zwei Verlustursachen benannt und gefixt (keine davon erzeugt einen Edge)
- [x] Speicherfrage beantwortet: **D1 reicht** (778 KB von 5 GB, 1 Zeile pro
      Snapshot-Read, 1,49 ms Parse beim Ledger-Cap gegen 10 ms CPU-Limit)

---

## Offen

### 1–5 · ✅ am 14. Aug abgearbeitet

- [x] **Board Welle 2** — `cortex.state`, `cortex.candidates`,
      `registry.strategies`, `vol.iv`, `news.telegram`, `portfolio.holdings`,
      `portfolio.watchlist` (die vier admin-gated benutzen erstmals das
      Sichtbarkeits-Gate, zwei Schlösser statt einem)
- [x] **Board Welle 3** — `world.layers`, `world.hazards`, `macro.yields`,
      `ml.track`. 22 Ressourcen insgesamt (17 öffentlich, 5 admin)
- [x] **Der Chat** — `/api/ask`, zwei Strict-JSON-Runden statt Tool-Loop
      (provider-unabhängig, läuft auch auf lokaler OmniRoute), Katalog =
      Tool-Liste, ≤6 Reads pro Frage, Belege reisen mit der Antwort
- [x] **Speicher** — `argus_trades` + `argus_history`, additiv geschrieben,
      selbstheilendes DDL, kann den Persist des Agenten nie fehlschlagen lassen.
      Neue Ressource `argus.equity` beantwortet erstmals eine Frage über die
      Vergangenheit
- [x] **Cortex-Strukturfrage** — beantwortet, und die beunruhigende Hälfte war
      falsch: `factors.js` enthielt bereits eine funktionierende
      Querschnitts-Maschine (`runBAB`), nur mit fest verdrahtetem Ranking. Jetzt
      `src/lib/crossSection.js` mit `rankFn` als Parameter; `runBAB` ruft sie auf
      und ist bit-identisch

### 5b · Cortex — was jetzt wirklich offen ist

- [ ] **Cortex kann keine `rankFn` erzeugen.** Er emittiert `strategy(ctx)` für
      die Einzelinstrument-Engine. Das ist ein Prompt und eine Code-Form, keine
      Engine-Operation — und der ehrliche nächste Schritt
- [ ] Volltext holen: PDF-Extractor für OpenAlex (`best_oa_location.pdf_url`),
      SSRN, Zenodo
- [ ] Absagen statt raten: Reproduktions-Checkliste (Universum, Zeitraum,
      Rebalance, Lookback, Kosten) — nicht füllbar ⇒ keine Strategie erzeugen
- [ ] Nach Mechanismen suchen, nicht nach `"trading strategy"` (PEAD,
      Zeitreihen-Momentum, Varianzrisikoprämie, Betting-against-Beta)

### 6 · Eigenes Modell — Phase 2

- [x] **Datenpipeline gebaut und verifiziert:**
      `scripts/kronos/prepare_binance.py` holt Binance-Kerzen und schreibt genau
      die drei Pickles, die `finetune/dataset.py` lädt (`{symbol: DataFrame}`,
      DatetimeIndex `datetime`, Spalten open/high/low/close/vol/amt). Der
      Vertrag ist aus dem Kronos-Repo abgelesen, nicht geraten. Splits sind
      chronologisch, Val/Test greifen genau um `lookback_window` zurück — Kontext,
      nie Label. Trockenlauf gegen die echte Binance-API erfolgreich.
- [ ] **Training selbst** — Stunden GPU, absichtlich nicht nebenbei gestartet:
      `--out ../Kronos/finetune/data/mmmxcix`, dann `dataset_path` in
      `finetune/config.py` setzen, `use_comet = False`, dann
      `python finetune/train_predictor.py`
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
- [x] **Offene Frage beantwortet (14. Aug):** Es war ein Anzeige-Artefakt, kein
      Lernfehler. `deriveLessons` liefert auf dem Live-Ledger **30 Lessons — 28
      losing, EINE strong-positive** („liquidity-sweep shorts: 50% win, +0,24R
      über 14 Trades → favor") und eine neutrale. Gespeichert wurden aber nur
      `slice(0, 8)` einer nach |Expectancy| sortierten Liste, und auf einem
      verlierenden Buch sind die acht grössten Beträge alle Verluste. Die
      Sizing-Schleife hat die positive Lesson die ganze Zeit benutzt — nur die
      Seite hat sie nie gezeigt. Jetzt `displayLessons()`: geboostete Buckets
      zuerst, Cap 10.
- [ ] Nebenbefund: London ist mit inzwischen 25 Trades nur noch **+0,07R** (t
      0,23), Off-Hours +0,23R über 7 Trades — unter der Stichprobenschwelle von
      8, also gar keine Lesson. Der London-Effekt ist kleiner, als er im
      Handoff aussieht.

### 8 · Kleinfunde aus dem Bau der Schicht

- [x] **`tier: 1` — mein Befund war falsch.** Der Kommentar in `news.js` sagt
      es selbst: eine Firmenmitteilung IST eine Primärquelle („straight from the
      company, not third-party paraphrase"), und ein Per-Feed-Cap verhindert
      schon, dass ein Vielschreiber die Liste flutet. Was wirklich fehlte, war
      eine **zweite Achse**: Tier sagt, wie autoritativ — nichts sagte, *was* die
      Quelle ist. Jetzt `kind: official | press | media`, additiv, die
      Tier-Semantik der News-Seite bleibt unverändert.
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

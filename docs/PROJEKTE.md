# Die fünf grossen Projekte — Briefing, 15. August 2026

Fünf Ideen, jede bekommt einen eigenen Chat. Dieses Dokument ist der Startpunkt
für diese Chats: was die Idee ist, **welcher Datenweg nachweislich funktioniert**
(alles unten am 15. Aug 2026 von diesem Rechner aus geprüft), was die erste
ehrliche Lieferung wäre, und wo die Falle liegt.

Die Reihenfolge unten ist eine Empfehlung, keine Vorgabe — die Begründung steht
am Schluss.

---

## 1 · Polymarket Copytrade-Agent

Einen oder mehrere Wallets auf Polymarket beobachten und ihre Positionen
nachbilden.

**Datenweg — mit einer wichtigen Einschränkung.** Polymarkets eigene Domains
sind **von diesem Rechner aus nicht erreichbar**: `polymarket.com`,
`gamma-api.polymarket.com` und `clob.polymarket.com` laufen alle in einen
Verbindungs-Timeout, und zwar sowohl über curl als auch über PowerShell — es ist
also nicht die Sandbox, sondern der Netzweg selbst. Zwei Auswege, beide offen:

- **On-chain lesen.** Polymarket lebt auf Polygon, jeder Trade ist ein Event im
  Exchange-Contract. Keylose RPCs verifiziert: `polygon-bor-rpc.publicnode.com`
  und `polygon.drpc.org` antworten (Block 0x57cb563). `polygon-rpc.com` und
  Ankr verlangen inzwischen Schlüssel. Damit sind Wallet-Historie und Fills
  vollständig lesbar, ganz ohne Polymarkets API.
- **Cloudflare als Proxy.** Unsere Pages-Functions gehen aus Cloudflares Netz
  raus, nicht aus diesem — ein `/api/polymarket`-Endpoint kann funktionieren, wo
  der lokale Agent scheitert. Muss geprüft werden, nicht angenommen.

**Nachtrag 16. Aug — die Markt-Auflösungen sind KEINE Sackgasse.** Der Lauf vom
15./16. Aug (`f8e6f1a`, `427d5cf`) blieb daran hängen, dass offene Positionen
nicht bewertbar seien: der Orderbook-Subgraph kennt keine Auflösungen, die
Geschwister-Subgraphs (`positions`, `pnl`) geben 404. Man braucht die Subgraphs
aber gar nicht — die Auflösung steht on-chain, und sie ist von hier aus keylos
lesbar. Am 16. Aug gegen den öffentlichen RPC nachgemessen:

- **Conditional-Tokens-Contract** (Gnosis CTF, den Polymarket benutzt):
  `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` auf Polygon — lebt, 30.016 Zeichen
  Bytecode, 256.633 Events in 1.500 Blöcken.
- **`ConditionResolution` = Topic `0xb44d84d3289691f71497564b85d4233648d9dbae8cbdbb4329f301c3a0185894`.**
  Nicht aus dem Gedächtnis, sondern an einem echten Event dekodiert: 4 Topics
  (conditionId, oracle, questionId indiziert) und im Datenteil
  `outcomeSlotCount = 2`, danach `payoutNumerators = [0, 1]` — also „Outcome 2 hat
  gewonnen". Genau die Zahl, die eine offene Position bewertbar macht.
- Gelesen über `eth_getLogs` an `polygon-bor-rpc.publicnode.com` bzw.
  `polygon.drpc.org`, ohne Schlüssel.

**Und die Bewertung offener Positionen braucht die Auflösung nicht einmal
zwingend**, um den Dispositionseffekt zu entschärfen: Es genügt, jede offene
Position am Stichtag zum letzten gehandelten Preis zu bewerten — „alle
liquidieren an der Schnittkante". Das ist die übliche Konvention in
Trader-Ranking-Studien, es kommt aus Daten, die der Harvester schon hat, und es
nimmt dem „Verlierer nie schliessen"-Muster sofort seinen Vorteil. Die
On-chain-Auflösung liefert danach die *wahre* Endbewertung. Beide Zahlen
nebeneinander sind aussagekräftiger als jede allein.

**Erste ehrliche Lieferung: nicht der Copier, sondern die Messung.** Ein
Leaderboard ist der überlebensverzerrteste Datensatz, den es gibt — die
Gewinnerliste besteht per Konstruktion aus denen, die Glück hatten. Die Frage
vor jeder Zeile Agent-Code lautet: **bleibt der Vorsprung eines Wallets über die
Zeit bestehen?** Also: Wallets bis Zeitpunkt T ranken, danach out-of-sample
messen, was sie verdient haben — mit Benjamini-Hochberg über alle getesteten
Wallets, exakt wie im Pairs-Screener. Wenn nichts überlebt, ist das Projekt hier
zu Ende und hat zwei Tage gekostet statt zwei Wochen.

**Die Falle:** man kopiert immer zu einem schlechteren Preis als der Kopierte.
Bei binären Märkten mit dünnem Buch frisst genau das die Marge. Die Messung muss
zum *realistischen* Fill rechnen, nicht zum Fill des Leaders.

**Wiederverwendbar:** das ganze Argus-Gerüst (Paper-Buch, Risiko-Gates, Ledger,
Lernschleife, Journal), die FDR-Korrektur aus `pairsScreen.js`.

---

## 2 · Memecoin-Agent (Argus-Geschwister, mit Wallet-Copying)

Wie Argus, aber auf Solana-Memecoins, inklusive Nachbilden fremder Trades
(FOMO-App-Prinzip).

**Datenweg.** DexScreener antwortet keylos (HTTP 200 verifiziert). Dazu kommen
Birdeye, Jupiter und Helius (Solana-RPC + Webhooks, freie Tiers) sowie die
pump.fun-Endpoints. Solana ist vollständig öffentlich, Wallet-Tracking ist
technisch gelöst.

**Die Falle ist hier grösser als die Idee.** Drei Dinge, die wir bereits
gemessen haben und die hier alle zugleich zuschlagen:

- **Latenz frisst den Edge.** Die Arena hat gezeigt, dass ein Signal von 0.3
  Ticks bei Retail-Gebühren nichts wert ist. Bei Memecoins ist der Slippage pro
  Trade ein Vielfaches davon, und wer nachkauft, kauft dem Leader seinen Ausstieg
  ab.
- **Unsere Qualitätsregeln passen nicht.** Pflicht-Stop und Mindest-Trades pro
  Jahr sind für ein Buch gedacht, das mehrere Tage hält. Ein Token, der in 40
  Sekunden 80 % macht und in 20 auf null geht, ist kein Setup, sondern eine
  andere Anlageklasse.
- **Rugs und Honeypots** sind kein Randfall, sondern der Normalfall. Ohne
  Verkaufbarkeits-Prüfung ist jede Statistik geschönt: die Verlierer lassen sich
  gar nicht erst verkaufen und tauchen im Ledger nie auf.

**Erste ehrliche Lieferung:** dieselbe Messung wie bei 1, nur härter — die
Trades verfolgter Wallets nachrechnen zu *unserem* Fill (Zeitstempel des
Leaders + realistische Verzögerung + Slippage nach Poolgrösse). Vermutlich ist
das Ergebnis vernichtend; dann wissen wir es für 200 Zeilen Analyse statt für
einen Agenten.

---

## 3 · Insider- und Politiker-Trades — ERLEDIGT 15. Aug (`7e441ba`)

Trades von Kongressmitgliedern, CEOs und Grossaktionären nachverfolgen.

> **Ergebnis: das Signal fällt durch unsere Prüfung** — deflated Sharpe 4,9 %,
> Walk-Forward 1 von 3 Fenstern positiv. Cluster schlagen Einzelkäufe (0,24 vs
> −0,14) und der Placebo-Test ist signifikant (p = 0,010): die *Form* aus der
> Literatur ist real, das *Niveau* trägt nicht. Ereignisstudie wird mit jedem
> Horizont schlechter (5d +0,07 %, 21d −0,63 %, 63d −1,27 %, 126d −5,65 %),
> „länger halten" ist also nicht die Rettung. Der Effekt sitzt vermutlich im
> Micro-Cap-Rand, den der Liquiditätsfilter entfernt — dieser Zielkonflikt IST
> der Befund, kein Parameter zum Drehen.
>
> Gebaut: Ingest (`scripts/insider-agent.mjs`, täglich 05:00), Cluster-Erkennung,
> Messung (`scripts/insider-validate.mjs`). Bewusst NICHT gebaut: Seite,
> Alerting, Ranking — eine Oberfläche, die ein Signal suggeriert, das die
> Messung verwirft, ist genau das, was die Doktrin verbietet. Kongress-Daten
> zurückgestellt: 45 Tage Frist gegen Form 4s drei, und drei reichen schon nicht.
> Volle Details: `docs/INSIDER.md`, `docs/INSIDER_FINDINGS.md`.
>
> Der Rest des Abschnitts steht unverändert, weil er den Auftrag beschreibt, aus
> dem das Ergebnis entstanden ist.

**Datenweg — der sauberste von allen fünf, und komplett gratis.**

- **SEC EDGAR Form 4** (Käufe/Verkäufe von Officers, Directors, >10 %-Haltern):
  Tagesindex (`sec.gov/Archives/edgar/daily-index/…`) und Volltextsuche
  (`efts.sec.gov/LATEST/search-index?q=…&forms=4`) beide **HTTP 200 verifiziert**.
  Strukturiertes XML, Meldefrist zwei Werktage — das ist der Goldstandard.
  SEC verlangt einen echten User-Agent mit Kontakt, sonst 403.
- **Kongress:** `disclosures-clerk.house.gov` **HTTP 200 verifiziert**
  (Jahres-ZIPs mit den Periodic Transaction Reports), Senat über die EFD-Suche.
  Meldefrist 45 Tage — das ist der springende Punkt, siehe Falle.
- **Trump persönlich:** keine Einzeltrades. Es gibt nur die jährliche
  OGE-278e-Offenlegung; alles andere sind Unternehmensmeldungen (DJT).

**Erste ehrliche Lieferung:** Form-4-Ingest in D1 plus eine Seite, die
Clusterkäufe zeigt (mehrere Insider derselben Firma innerhalb weniger Tage) —
und dann sofort durch unsere eigene Validierung: taugt das als Faktor? Wir haben
DSR, Walk-Forward, purged CV und den Registry-Pfad bereits stehen. Damit ist das
Ding kein Gimmick, sondern eine geprüfte Strategie oder ein dokumentierter
Fehlschlag.

**Die Falle:** die berühmten Pelosi-Trades sind bis zu 45 Tage alt, wenn du sie
siehst. Wer sie einzeln nachkauft, kauft eine Nachricht, die der Markt längst
hat. Der in der Literatur belegte Effekt sitzt im **aggregierten** Signal
(besonders bei Insider-*Käufen* mit mehreren Beteiligten), nicht im Nachäffen
einzelner Namen. Genau das prüfen wir, statt es zu behaupten.

---

## 4 · Aussagen wichtiger Leute → wer profitiert

„Trump sagt, man solle in Kernenergie investieren" → Tool listet Uranminen,
Reaktorbauer, Zulieferer.

**Datenweg — grösstenteils schon gebaut.** Der Telegram-OSINT-Feed liefert
Trump-Schlagzeilen in Minuten (WalterBloomberg, financialjuice), der RSS-Ingest
den Rest, OmniRoute stellt das Modell, und `/api/briefing` macht bereits
Extraktion aus Nachrichten. Für die Zuordnung Thema → Firmen gibt es zusätzlich
IBKRs Themen-Endpoints (`get_company_themes`, `search_investment_topics`) als
Abkürzung gegenüber einer handgepflegten Liste.

**Erste ehrliche Lieferung: das Event-Lab dranhängen, nicht die Vibes.** Die
Kette ist Aussage → Thema → Korb → **historische Ereignisstudie**. Das Tool soll
nicht sagen „Uranaktien könnten profitieren", sondern „bei 23 vergleichbaren
Aussagen lag der Median des Korbs nach fünf Tagen bei +0.4 %, die Streuung bei
±6 %". Das Event-Lab dafür existiert seit Juli.

**Die Falle:** solche Nachrichten sind in Sekunden eingepreist, und ein Korb aus
„könnte profitieren" ist schnell ein Sammelbecken für Beta. Ohne die
Ereignisstudie ist es ein Narrativ-Generator — hübsch und wertlos.

---

## 5 · Social-Media-Promo-Agent

Bewirbt das Projekt selbstständig. **Ausdrücklich erst nach dem Launch.**

**Realität der Plattformen:** automatisiertes Posten auf X braucht einen
bezahlten API-Tier, Instagram beschränkt Automatisierung stark, und ein Account,
der wie ein Bot aussieht, wird wie ein Bot behandelt. Der belastbare Zuschnitt
ist deshalb **Entwurf und Warteschlange mit deiner Freigabe**, nicht
Vollautomatik: der Agent schreibt, du drückst auf senden.

**Wiederverwendbar:** die Marketing-Skills sind vorhanden, der Digest-Worker
zeigt, wie ein Cron-getriebener Agent bei uns aussieht.

---

## Reihenfolge, und warum

1. ~~**Insider-Tracker (3).**~~ **ERLEDIGT am 15. Aug** (`7e441ba`) — und zwar
   als dokumentierter Fehlschlag, was die Lieferung war. Ingest und Cluster
   laufen, das Signal fällt durch: deflated Sharpe 4,9 %, Walk-Forward 1 von 3
   Fenstern positiv. Cluster schlagen Einzelkäufe und der Placebo-Test ist
   signifikant — die *Form* stimmt, das *Niveau* trägt nicht. Details in
   `docs/INSIDER.md` und `docs/INSIDER_FINDINGS.md`. Bewusst nicht gebaut:
   Seite, Alerting, Ranking. Der tägliche Ingest läuft trotzdem weiter
   (`scripts/insider-agent.mjs`, 05:00), weil ein öffentliches Register sich
   später nicht in gleicher Güte nachholen lässt — und weil Projekt 4 dessen
   Emittenten-/Ticker-Schicht ohnehin braucht.
2. **Aussagen-Tool (4).** Jetzt an der Reihe. Erbt die Ticker-Schicht aus 3 und
   nutzt Nachrichten-Ingest, Telegram-OSINT, LLM und Event-Lab, die alle laufen.
3. **Polymarket (1).** Vorher die Wallet-Persistenz messen. Fällt die Messung
   negativ aus, ist das Projekt beendet, bevor es beginnt — und das ist ein
   gutes Ergebnis.
4. **Memecoins (2).** Technisch am schwersten, mikrostrukturell am
   feindlichsten. Erst sinnvoll, wenn die Latenz-Arithmetik aus 1 vorliegt.
5. **Promo-Agent (5).** Per Definition nach dem Launch.

### Zwei Lehren aus Projekt 3, die für alle folgenden gelten

Beide haben dort eine Strategie wie einen Triumph aussehen lassen (Sharpe 3,67,
+1.199.985 % out of sample), bevor sie auffielen:

- **Kalendertage vergleichen, nicht Zeitstempel.** Ein Meldedatum ist UTC-
  Mitternacht, eine Yahoo-Tageskerze trägt 13:30/14:30 UTC. Roh verglichen liegt
  die Kerze *nach* der Meldung — und der Einstieg passiert am Tag, an dem die
  Meldung noch gar nicht öffentlich war.
- **Investierbares Universum erzwingen.** Ohne Filter misst eine
  gleichgewichtete Auswertung die Tick-Grösse von Sub-Dollar-Aktien. In 3 sind
  es 5 $ Schlusskurs und 1 Mio. $ Median-Umsatz, beurteilt auf Balken *vor* dem
  Einstieg.

Was für alle fünf gilt und in jedem der Chats als erstes auf den Tisch gehört:
**zuerst messen, ob es überhaupt etwas zu holen gibt, dann bauen.** Argus hat
uns hundert Trades gekostet, um genau das zu lernen.

---

## Start-Prompts

Ein Block pro Projekt, zum Kopieren in einen frischen Chat im Ordner
`mmmxcix-quant`. Jeder Block ist eigenständig — er nennt den Auftrag, die
geprüften Datenwege, die erste Lieferung, die Falle und was nicht zu tun ist.

### Projekt 4 · Aussagen wichtiger Leute → wer profitiert

```text
Projekt 4 von 5: Aussagen wichtiger Leute → wer davon profitiert. Briefing in
docs/PROJEKTE.md, Abschnitt "4 · Aussagen wichtiger Leute → wer profitiert".

Lies zuerst, in dieser Reihenfolge:
  docs/PROJEKTE.md          Abschnitt 4 + "Zwei Lehren aus Projekt 3"
  docs/INSIDER_FINDINGS.md  wie eine Messung bei uns aussieht, die NEIN sagt
  docs/HANDOFF.md           Zustand der Agents, was an Argus schiefging
  CLAUDE.md                 Stack, Architektur, Konventionen

DOKTRIN: erst messen, ob es etwas zu holen gibt, dann bauen. Projekt 3 hat
Ingest und Cluster gebaut, die Messung hat das Signal verworfen (deflated Sharpe
4,9 %) — und genau das war die Lieferung. Ein Feature, das eine Behauptung
aufstellt, die wir nicht geprüft haben, wird nicht gebaut.

WAS ES IST: eine Aussage ("Trump sagt, man solle in Kernenergie investieren")
wird zu einem Thema, das Thema zu einem Korb von Titeln (US-lastig), und der
Korb bekommt eine HISTORISCHE EREIGNISSTUDIE. Das Tool sagt nicht
"Uranaktien könnten profitieren", sondern "bei N vergleichbaren Aussagen lag der
Median des Korbs nach fünf Tagen bei X %, die Streuung bei Y %".

ERSTE LIEFERUNG, in dieser Reihenfolge:
 1. Aussagen-Ingest: Telegram-OSINT (/api/telegram, u.a. WalterBloomberg,
    financialjuice) + RSS (/api/news). Sprecher, Zeitstempel, Wortlaut.
 2. Thema-Extraktion über OmniRoute (LAB_LLM_URL), Ausgabe streng als JSON.
    Muster für zwei erzwungene JSON-Runden: functions/api/briefing.js.
 3. Thema → Korb. Emittenten-/Ticker-Schicht aus Projekt 3 nutzen
    (src/lib/insider/, functions/_lib/insider.mjs); als Abkürzung für die
    Themen-Zuordnung gibt es IBKRs get_company_themes / search_investment_topics.
 4. EREIGNISSTUDIE über die Historie — src/lib/eventLab.js und die Seite
    EventLab.jsx existieren seit Juli. Horizonte 1/5/21 Tage, Median UND
    Streuung, Trefferquote, und ein Placebo mit verschobenen Daten.
 5. Erst wenn 4 etwas zeigt: Oberfläche.

GEPRÜFT (15. Aug 2026, nicht neu herleiten):
  /api/telegram liefert MTProto-Feed, 13 Kanäle, 60s-Takt
  /api/news, /api/briefing laufen
  Trump selbst hat KEINE Einzeltrades — nur die jährliche OGE-278e-Offenlegung

FALLE: solche Nachrichten sind in Sekunden eingepreist, und ein Korb aus
"könnte profitieren" ist schnell nur Beta. Ohne Ereignisstudie ist das Ding ein
Narrativ-Generator. Und die zwei Bugs aus Projekt 3 gelten hier genauso:
Kalendertage statt Zeitstempel vergleichen, investierbares Universum erzwingen.

NICHT TUN:
  · Argus anfassen — das Messfenster läuft.
  · `git add -A` — parallele Sessions committen im selben Repo; vor jedem
    Commit `git status` lesen und nur eigene Dateien stagen.
  · Etwas "profitabel" nennen, das nur im Backtest profitabel ist.

STACK: React+Vite auf Cloudflare Pages, Functions unter functions/api/, D1,
lokale Agents unter scripts/ (via agent-daemon.mjs), Tests `node --test`,
vollständige Prüfung `npm run check`.
```

### Projekt 1 · Polymarket Copytrade-Agent

```text
Projekt 1 von 5: Polymarket Copytrade-Agent. Briefing in docs/PROJEKTE.md,
Abschnitt "1 · Polymarket Copytrade-Agent".

Lies zuerst:
  docs/PROJEKTE.md          Abschnitt 1 + "Zwei Lehren aus Projekt 3"
  docs/INSIDER_FINDINGS.md  wie eine ehrliche Messung bei uns aussieht
  docs/HANDOFF.md           Argus, Arena, und was die Messung nicht überlebt hat
  src/lib/pairsScreen.js    unsere Benjamini-Hochberg-Korrektur, hier wieder nötig

DOKTRIN: erst messen, dann bauen. Ein Leaderboard ist der überlebensverzerrteste
Datensatz überhaupt — die Gewinnerliste besteht per Konstruktion aus denen, die
Glück hatten.

ERSTE LIEFERUNG IST NICHT DER COPIER, SONDERN DIE MESSUNG:
 Bleibt der Vorsprung eines Wallets out of sample bestehen? Wallets bis
 Zeitpunkt T ranken, danach messen, was sie verdient haben — zu UNSEREM Fill,
 nicht zu dem des Kopierten (Zeitstempel des Leaders + realistische Verzögerung
 + Slippage nach Buchtiefe). Benjamini-Hochberg über alle getesteten Wallets.
 Fällt sie negativ aus, ist das Projekt beendet und hat zwei Tage gekostet
 statt zwei Wochen — das ist ein gutes Ergebnis, kein Misserfolg.

DATENWEG — WICHTIG: Polymarkets eigene Domains sind von diesem Rechner NICHT
erreichbar. polymarket.com, gamma-api.polymarket.com und clob.polymarket.com
laufen in einen Verbindungs-Timeout, über curl UND über PowerShell — es ist der
Netzweg, nicht die Sandbox. Zwei Auswege, beide am 15. Aug geprüft:
  · on-chain lesen: Polymarket lebt auf Polygon, jeder Trade ist ein Contract-
    Event. Keylos verifiziert: polygon-bor-rpc.publicnode.com und
    polygon.drpc.org. polygon-rpc.com und Ankr verlangen inzwischen Schlüssel.
  · über eine Pages-Function proxien: Cloudflares Egress ist nicht unserer.
    Muss geprüft werden, nicht angenommen.

FALLE: man kopiert immer zu einem schlechteren Preis als der Kopierte; bei
binären Märkten mit dünnem Buch frisst genau das die Marge. Dazu die zwei Bugs
aus Projekt 3: Kalendertage statt Zeitstempel, und ein Liquiditätsfilter, sonst
misst man die Tick-Grösse toter Märkte.

NICHT TUN:
  · Echtes Geld. Paper zuerst, wie bei allen drei bestehenden Agents.
  · Argus anfassen. `git add -A`. Backtest-Gewinne "profitabel" nennen.

WIEDERVERWENDEN: das Argus-Gerüst (Paper-Buch, Risiko-Gates, Ledger,
Lernschleife, Journal) in scripts/argus-agent.mjs + src/lib/argus/.
```

### Projekt 2 · Memecoin-Agent (Argus-Geschwister)

```text
Projekt 2 von 5: Memecoin-Agent auf Solana, mit Nachbilden fremder Trades.
Briefing in docs/PROJEKTE.md, Abschnitt "2 · Memecoin-Agent".

Lies zuerst:
  docs/PROJEKTE.md   Abschnitt 2 + "Zwei Lehren aus Projekt 3"
  docs/HANDOFF.md    besonders den Arena-Abschnitt: dort steht gemessen, warum
                     ein 0,3-Tick-Signal bei Retail-Gebühren nichts wert ist

DOKTRIN: erst messen, dann bauen. Dieses Projekt ist von den fünf das mit der
höchsten Wahrscheinlichkeit, dass die Messung NEIN sagt. Genau deshalb kommt sie
zuerst.

ERSTE LIEFERUNG: die Trades verfolgter Wallets zu UNSEREM Fill nachrechnen —
Zeitstempel des Leaders + realistische Verzögerung + Slippage nach Poolgrösse.
Dazu zwingend eine Verkaufbarkeits-Prüfung (Honeypot/Rug), sonst ist die
Statistik geschönt: die Verlierer lassen sich gar nicht verkaufen und tauchen im
Ledger nie auf. Ohne diese beiden Korrekturen ist jede Zahl wertlos.

DATENWEG: DexScreener antwortet keylos (verifiziert 15. Aug). Dazu Birdeye,
Jupiter, Helius (Solana-RPC + Webhooks) und pump.fun, alle mit freien Tiers.
Solana ist vollständig öffentlich, Wallet-Tracking ist technisch gelöst.

DREI DINGE, DIE HIER GLEICHZEITIG ZUSCHLAGEN:
  · Latenz frisst den Edge — wer nachkauft, kauft dem Leader den Ausstieg ab.
  · Unsere Qualitätsregeln passen nicht: Pflicht-Stop und Mindest-Trades pro
    Jahr sind für ein Buch gedacht, das Tage hält. Wenn du sie lockerst, schreib
    auf WARUM und was stattdessen die Reissleine ist.
  · Rugs und Honeypots sind der Normalfall, nicht der Randfall.

NICHT TUN:
  · Echtes Geld. Paper only, und wenn live, dann notify-only.
  · Argus anfassen. `git add -A`. Backtest-Gewinne "profitabel" nennen.
```

### Projekt 5 · Social-Media-Promo-Agent

```text
Projekt 5 von 5: Social-Media-Promo-Agent. Briefing in docs/PROJEKTE.md,
Abschnitt "5 · Social-Media-Promo-Agent". NUR STARTEN, WENN DER LAUNCH STEHT.

Lies zuerst:
  docs/PROJEKTE.md  Abschnitt 5
  docs/HANDOFF.md   damit klar ist, was wir über die Agents behaupten dürfen
  CLAUDE.md         Stack, Marke, Tonalität

ZUSCHNITT: Entwurf und Warteschlange mit menschlicher Freigabe, KEINE
Vollautomatik. Automatisiertes Posten auf X verlangt einen bezahlten API-Tier,
Instagram beschränkt es stark, und ein Account, der wie ein Bot aussieht, wird
wie ein Bot behandelt. Der Agent schreibt, der Mensch drückt auf senden.

ERSTE LIEFERUNG: eine Warteschlange (D1) + eine Seite, auf der Entwürfe
freigegeben, geändert oder verworfen werden. Cron-Muster steht beim
Daily-Digest-Worker.

HARTE REGEL, die über allem steht: NIEMALS Performance-Zahlen veröffentlichen,
die unsere eigene Prüfung verworfen hat. Argus verliert, das Insider-Signal ist
durchgefallen, die Micro-Price-Idee trägt nicht — das darf beworben werden als
das, was es ist (offen dokumentierte Forschung), niemals als Gewinn. Ein
Marketing-Text, der eine Behauptung aufstellt, die docs/ widerlegt, ist ein Bug.

NICHT TUN:
  · Echte Accounts ohne ausdrückliche Freigabe verbinden.
  · Zahlen erfinden oder Backtests als Ergebnisse ausgeben.
  · `git add -A`.
```

### Projekt 3 · Insider-Trades (ERLEDIGT, nur zur Referenz)

```text
Projekt 3 von 5: Insider- und Politiker-Trades. Briefing steht in
docs/PROJEKTE.md, Abschnitt "3 · Insider- und Politiker-Trades".

Lies zuerst, in dieser Reihenfolge, und fang erst danach an:
  docs/PROJEKTE.md   Abschnitt 3 — Auftrag, geprüfte Datenwege, die Falle
  docs/HANDOFF.md    Zustand der drei Agents und was an Argus schiefging
  docs/TODO.md       was sonst offen ist
  docs/BOARD.md      die Zugriffsschicht, über die neue Ressourcen laufen
  CLAUDE.md          Stack, Architektur, Konventionen

DOKTRIN, die über allem steht: erst messen, ob es etwas zu holen gibt, dann
bauen. Argus hat uns hundert Trades gekostet, um das zu lernen — ein Buch, das
verliert, wird durch Slicen nicht besser. Kein Feature, das eine Behauptung
aufstellt, die wir nicht geprüft haben.

ERSTE LIEFERUNG, in dieser Reihenfolge:
 1. Form-4-Ingest von SEC EDGAR in D1 (Käufe/Verkäufe von Officers, Directors,
    >10%-Haltern). Tagesindex + Volltextsuche, strukturiertes XML, zwei
    Werktage Meldefrist.
 2. Clusterkäufe sichtbar machen: mehrere Insider derselben Firma innerhalb
    weniger Tage — das ist die Form des Signals, die in der Literatur trägt.
 3. SOFORT durch unsere eigene Validierung schicken: taugt das als Faktor?
    DSR, Walk-Forward, purged CV und der Registry-Pfad stehen bereits. Ergebnis
    ist eine geprüfte Strategie ODER ein dokumentierter Fehlschlag — beides ist
    eine Lieferung.
 4. Erst danach Oberfläche, Alerting, Kongress-Daten.

GEPRÜFTE DATENWEGE (15. Aug 2026, nicht neu herleiten):
  sec.gov/Archives/edgar/daily-index/…            HTTP 200
  efts.sec.gov/LATEST/search-index?q=…&forms=4    HTTP 200
  disclosures-clerk.house.gov                     HTTP 200
  SEC verlangt einen echten User-Agent mit Kontakt, sonst 403.
  Kongress-Meldefrist: 45 Tage. Wer Einzeltrades nachkauft, kauft eine
  Nachricht, die der Markt längst hat — der Effekt sitzt im Aggregat.

NICHT TUN:
  · Argus anfassen. Das Messfenster für die nächsten hundert Trades läuft; die
    Scorecard ist Instrumentierung, keine Justierung.
  · `git add -A`. In diesem Repo committen parallele Sessions — vor jedem
    Commit `git status` lesen und nur die eigenen Dateien stagen.
  · Etwas als "profitabel" bezeichnen, das nur im Backtest profitabel ist.

STACK: React+Vite auf Cloudflare Pages, Functions unter functions/api/, D1 als
Datenbank, lokale Agents unter scripts/ (gestartet von agent-daemon.mjs),
Tests `node --test`, vollständige Prüfung `npm run check`.
```

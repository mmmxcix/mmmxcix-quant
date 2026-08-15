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

## 3 · Insider- und Politiker-Trades

Trades von Kongressmitgliedern, CEOs und Grossaktionären nachverfolgen.

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

1. **Insider-Tracker (3).** Gratis, rechtlich unproblematisch, Datenweg
   verifiziert, und das Ergebnis ist ein *Faktor*, den unsere bestehende
   Validierung beurteilen kann. Höchstes Verhältnis von Wert zu Risiko.
2. **Aussagen-Tool (4).** Erbt von 3 die Ticker- und Themenschicht und nutzt
   Nachrichten-Ingest, LLM und Event-Lab, die alle schon laufen.
3. **Polymarket (1).** Vorher die Wallet-Persistenz messen. Fällt die Messung
   negativ aus, ist das Projekt beendet, bevor es beginnt — und das ist ein
   gutes Ergebnis.
4. **Memecoins (2).** Technisch am schwersten, mikrostrukturell am
   feindlichsten. Erst sinnvoll, wenn die Latenz-Arithmetik aus 1 vorliegt.
5. **Promo-Agent (5).** Per Definition nach dem Launch.

Was für alle fünf gilt und in jedem der Chats als erstes auf den Tisch gehört:
**zuerst messen, ob es überhaupt etwas zu holen gibt, dann bauen.** Argus hat
uns hundert Trades gekostet, um genau das zu lernen.

---

## Start-Prompt für den nächsten Chat (Projekt 3)

Zum Kopieren in einen frischen Chat im Ordner `mmmxcix-quant`. Für ein anderes
Projekt denselben Text nehmen und den Abschnittsverweis austauschen.

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

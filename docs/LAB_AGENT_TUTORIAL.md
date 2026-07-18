# Lab-Agent Tutorial — 24/7-Prozess auf deinem PC, Anzeige auf quant.mmmxcix.com

**Ziel:** Auf deinem Windows-PC läuft rund um die Uhr ein kostenloser Prozess (n8n als Zeitplaner + Node-Skripte als Rechenkern). Er rechnet lokal — Research, Paper-Trading, Strategie-Checks — und **pusht** seinen Zustand an deine Website. Die Website zeigt alles an, egal wo du bist.

```
┌────────────── dein PC (24/7) ──────────────┐        ┌───── Cloudflare ─────┐
│  n8n (Scheduler, localhost:5678)           │  push  │  /api/lab (Function) │
│    └─ ruft alle 15 min auf:                │ ─────► │    └─ speichert in KV│
│       node scripts/lab-agent.mjs           │  HTTPS │                      │
│       (rechnet lokal, baut State-JSON)     │        │  quant.mmmxcix.com   │
└────────────────────────────────────────────┘        │  Coach → "Lab agent" │
                                                      └──────────────────────┘
```

**Wichtig zu verstehen:** Die Website kann deinen PC nicht „abfragen" (er ist hinter deinem Router). Darum schiebt der PC seine Ergebnisse aktiv raus — das Push-Modell. Die Website ist reine Anzeige; gerechnet wird alles bei dir.

**Kosten: CHF 0.** n8n self-hosted ist kostenlos (Fair-Code-Lizenz), Node.js ist frei, der Cloudflare-Empfang läuft im Free Tier (der Speicher nutzt deinen bestehenden Newsletter-KV mit). Einzige echte Kosten: ~5–15 W Strom für den laufenden PC.

---

## Schritt 1 — Node.js systemweit installieren (einmalig)

Du hast bisher nur das portable Node im Temp-Ordner — für einen Dauerbetrieb brauchst du die richtige Installation. PowerShell **als Administrator**:

```powershell
winget install OpenJS.NodeJS.LTS
```

Danach PowerShell neu öffnen und prüfen:

```powershell
node --version    # sollte v22.x oder neuer zeigen
```

## Schritt 2 — Ersten Push von Hand testen (5 Minuten)

Bevor n8n ins Spiel kommt: einmal manuell prüfen, dass die Kette funktioniert.

```powershell
cd C:\Users\gilap\Documents\GitHub\mmmxcix-quant
$env:LAB_TOKEN = "<dein Dev-Token>"    # derselbe wie beim KI-Generator/Coach
node scripts\lab-agent.mjs
```

Erwartete Ausgabe: `state pushed (… bytes) → https://quant.mmmxcix.com/api/lab`

**Kontrolle auf der Website:** Öffne quant.mmmxcix.com → **Coach** → oben siehst du die neue Karte **„Lab agent (your PC)"** mit Status **online**, letztem Push und Live-Preisen. Das ist genau die Anzeige, die später den vollen Portfolio-HQ-Zustand zeigt.

> Der Token ist dein `DEV_ACCESS_TOKEN`. Er gehört in die Umgebungsvariable, niemals in eine Datei im Repo.

## Schritt 3 — n8n installieren und starten

```powershell
npm install -g n8n
n8n
```

Beim ersten Start öffnet sich http://localhost:5678 — lege dort das lokale Konto an (bleibt komplett auf deinem PC).

## Schritt 4 — Den Workflow anlegen (im n8n-Editor)

1. **New Workflow** → Name z. B. `Lab Agent`.
2. Ersten Node hinzufügen: **Schedule Trigger** → Rule: *Every 15 minutes*.
3. Zweiten Node: **Execute Command** und verbinden. Command:
   ```
   node C:\Users\gilap\Documents\GitHub\mmmxcix-quant\scripts\lab-agent.mjs
   ```
4. Damit das Skript den Token bekommt, setze ihn **dauerhaft für dein Benutzerkonto** (einmalig in PowerShell):
   ```powershell
   [Environment]::SetEnvironmentVariable("LAB_TOKEN", "<dein Dev-Token>", "User")
   ```
   Danach n8n einmal neu starten, damit es die Variable erbt.
5. Oben rechts **Save**, dann den Schalter auf **Active** stellen.
6. Test: Node anklicken → **Execute step** → im Output sollte `state pushed` stehen.

Ab jetzt pusht dein PC alle 15 Minuten. Die Coach-Karte zeigt „online", solange der letzte Push jünger als ~45 Minuten ist.

## Schritt 5 — Echter 24/7-Betrieb (Autostart + kein Schlafmodus)

**a) n8n automatisch starten** — am einfachsten mit pm2:

```powershell
npm install -g pm2 pm2-windows-startup
pm2 start (Get-Command n8n).Source --name n8n
pm2 save
pm2-startup install
```

Damit startet n8n bei jeder Windows-Anmeldung automatisch neu. (Alternative ohne pm2: Aufgabenplanung → „Bei Anmeldung" → Programm `n8n`.)

**b) PC am Einschlafen hindern** (sonst endet „24/7" nach 30 Minuten):

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
```

Monitor darf ausgehen, der Rechner nicht. Wenn der PC nachts aus ist, ist das übrigens kein Drama: Die Website zeigt dann einfach „offline" und den letzten Stand — kaputt geht nichts.

## Schritt 6 — Kontrollen & Handgriffe

| Was | Wie |
|---|---|
| Läuft n8n? | Browser: http://localhost:5678 · oder `pm2 status` |
| Letzte Läufe ansehen | n8n → Workflow → **Executions** (rote = Fehler mit Log) |
| Push von Hand auslösen | `node scripts\lab-agent.mjs` |
| Status auf der Website | Coach-Seite → Lab-agent-Karte → Refresh |
| Agent-Logik erweitern | `scripts/lab-agent.mjs` → Funktion `computeState()` |

## Sicherheit — die drei Regeln

1. **Token nur als Umgebungsvariable**, nie in Dateien/Commits (der Endpoint prüft ihn serverseitig, Lesen UND Schreiben sind damit geschützt — Fremde sehen deinen Lab-Zustand nicht).
2. Der Agent pusht **nur Anzeigedaten** (Zahlen, Status). Keine API-Keys, keine Secrets in den State legen.
3. n8n bleibt auf localhost (nicht ins Internet freigeben) — es muss von außen nicht erreichbar sein, denn dein PC ruft immer nur raus.

## Schritt 7 — Der autonome Research-Agent (läuft von selbst, KEIN 2. Workflow nötig)

Neben dem Paper-Trader (`lab-agent.mjs`, alle 15 min) gibt es den **Research-Agent** (`research-agent.mjs`): Er liest die neuesten Quant-Papers von arXiv, lässt deine eigene KI-API daraus Strategie-Code extrahieren, jagt jeden Kandidaten durch die volle Validierungs-Pipeline (k-Fold, Noise-Test, Deflated Sharpe mit globalem Versuchszähler) und speichert die Überlebenden auf der Website. Das ist genau der „KI researched von selbst"-Teil aus dem Video.

**Zwei Wege — du brauchst nur EINEN:**

- **A) Automatisch (kein 2. Workflow nötig):** Der Paper-Trader startet den Research-Agent von selbst mit — alle ~20 h fährt einer der 15-Min-Läufe zusätzlich **einen** Research-Zyklus hoch (detached, damit der Paper-Push schnell bleibt). Steuerung: `LAB_RESEARCH_EVERY_H=12` (Takt), Logs in `C:\Users\gilap\.mmmxcix-research.log`.
- **B) Eigener n8n-Workflow (sichtbar, empfohlen wenn du die Läufe in n8n sehen willst):** einen täglichen `Research Agent`-Workflow anlegen (Schedule *Days → 1*, Command `node …\research-agent.mjs`) **und** die Auto-Variante mit `LAB_AUTO_RESEARCH=0` abschalten, sonst läuft Research doppelt.

> ⚠️ Nie beide gleichzeitig aktiv lassen. Wenn du einen eigenen Workflow hast → `LAB_AUTO_RESEARCH=0`. Wenn nicht → Variable weglassen (bzw. `1`).

**Immer bis ein Treffer kommt (optional):** `LAB_RESEARCH_UNTIL_HIT=1` lässt den Agent pro Lauf so lange Papers lesen, bis **eine** Strategie durch die Pipeline kommt — gedeckelt durch `LAB_RESEARCH_MAX` (Default 12), damit ein magerer Tag nicht ewig läuft oder das Kontingent leert. **Wichtig, ehrlich:** Jeder Versuch hebt die globale Deflated-Sharpe-Hürde (Anti-Overfitting) — mehr Lesen macht jeden einzelnen Treffer also *schwerer*, nicht leichter. Der Deckel ist die ehrliche Bremse. Nur mit einem **täglichen** Takt sinnvoll (nicht alle 15 min).

> Nach dem Ändern von Umgebungsvariablen: **n8n einmal neu starten** (`pm2 restart n8n` oder Prozess schließen/öffnen), damit die Läufe die neuen Werte erben.

**Von Hand testen (optional, zum Debuggen):**
```powershell
cd C:\Users\gilap\Documents\GitHub\mmmxcix-quant
node scripts\research-agent.mjs
```
Erwartete Ausgabe: `arXiv: 25 papers, N fresh…` und pro Paper entweder `✓ CANDIDATE`, `✗ graveyard: … (Grund)`, `~ skipped` — und bei sehr guten Treffern `🤖 auto-promoted … → paper portfolio`.

### Voll-Autonomie: Auto-Promotion mit Deckel
Ein Kandidat, dessen **Deflated Sharpe ≥ 97 %** liegt (strenger als die 95 %-Hürde zum Überleben), wandert **automatisch** ins Paper-Portfolio — ohne dass du in der Registry klicken musst. Damit findet, testet UND handelt das System selbstständig, genau wie im Video.
- **Deckel:** Maximal **5** solcher Auto-Strategien laufen gleichzeitig (serverseitig erzwungen; die neuesten verdrängen die ältesten). Deine manuell veröffentlichten Strategien bleiben davon unberührt — beide koexistieren.
- **Erkennbar:** Auto-Strategien tragen ein 🤖 im Namen (im Portfolio HQ auf der Coach-Seite).
- **Schwelle ändern:** `LAB_AUTO_PROMOTE_DSR=98` (strenger) bzw. niedriger, wenn du mehr durchlassen willst.

### Selbst-Reparatur des generierten Codes
Wenn das KI-Modell mal Code liefert, der nicht kompiliert (falscher Funktionsname o. ä.), schickt der Agent den Fehler **einmal** ans Modell zurück und bittet um eine Korrektur, statt sofort zu beerdigen. Das hebt die Trefferquote spürbar und kostet nur bei Fehlschlag einen Extra-Call.

**Wo die Ergebnisse landen:** Coach-Seite → Karte „Lab agent" → Block **Research loop** (Zähler: papers read / strategies tried / graveyard / candidates / **auto-promoted**). Die Überlebenden erscheinen in der **Registry** unter „Agent research candidates" mit Ein-Klick-Import; die Auto-Promotions zusätzlich direkt im **Portfolio HQ**.

### Wichtig: die KI-Anbieter-Kette (alle kostenlos)
Der Research-Agent braucht deine KI-API (`/api/generate`). Der Endpoint probiert die Anbieter in **fester Reihenfolge** durch und fällt bei **jedem** Fehler (Rate-Limit, Ausfall, leere Antwort) automatisch zum nächsten:

| Priorität | Anbieter | Modell | Freies Kontingent | Cloudflare-Secret |
|---|---|---|---|---|
| 1 *(optional, später)* | Anthropic | `claude-sonnet-5` | bezahlt (beste Qualität) | `ANTHROPIC_API_KEY` |
| 2 | **Mistral** | Codestral (Code-Spezialist) | 1 Mrd. Tokens/Monat | `MISTRAL_API_KEY` |
| 3 | Groq | Llama 3.3 70B | 14'400 Calls/Tag | `GROQ_API_KEY` |
| 4 | Google Gemini | Flash | ~1'500 Calls/Tag | `GEMINI_API_KEY` |

**Warum diese Reihenfolge:** *Mistral Codestral* ist ein auf Code spezialisiertes Modell → schreibt die besten Strategien. *Groq* ist zwar schnell, läuft aber auf dem generalistischen Llama → zweite Wahl fürs Programmieren, dafür quasi unbegrenzt als Absicherung. *Gemini* bleibt der letzte Fallback. Sobald ein `ANTHROPIC_API_KEY` gesetzt ist, klemmt er sich automatisch ganz vorne dazu.

**Keys erstellen (je 2 Minuten, keine Kreditkarte):**
1. **Mistral:** console.mistral.ai → Anmelden → *API Keys* → *Create new key*. (Für das freie „Experiment"-Kontingent das Training auf deinen Daten in den Einstellungen aktivieren — für uns unkritisch, wir senden nur öffentliche arXiv-Abstracts.)
2. **Groq:** console.groq.com → Anmelden → *API Keys* → *Create API Key*.
3. Beide in **Cloudflare** hinterlegen: Pages → dein Projekt → *Settings* → *Environment variables* → als **Secret** `MISTRAL_API_KEY` und `GROQ_API_KEY` hinzufügen (Production). Danach einmal *Retry deployment*.

**Datenschutz:** Alle drei dürfen bedenkenlos genutzt werden — wir schicken nur öffentliche Paper-Abstracts und die Bitte, generischen Strategie-Code zu schreiben. Nichts Persönliches, keine Secrets; dein Dev-Token sieht das LLM nie (er authentifiziert nur deinen Endpoint).

Symptom `~ skipped (rate-limited)` erscheint erst, wenn **alle** gesetzten Anbieter gleichzeitig limitiert sind — dann bleiben die Papers „frisch" und werden beim nächsten Lauf erneut versucht. Weitere Stellschrauben:
- **Weniger pro Lauf:** Umgebungsvariable `LAB_RESEARCH_PAPERS=1` setzen.
- **Mehr Durchsatz:** einen bezahlten `ANTHROPIC_API_KEY` als Cloudflare-Secret hinterlegen (der Endpoint bevorzugt ihn dann automatisch).

## Kontrollen & Handgriffe

| Was | Wie |
|---|---|
| Läuft n8n? | Browser: http://localhost:5678 · oder `pm2 status` |
| Letzte Läufe ansehen | n8n → Workflow → **Executions** (rote = Fehler mit Log) |
| Paper-Trader von Hand | `node scripts\lab-agent.mjs` |
| Research von Hand | `node scripts\research-agent.mjs` |
| Status auf der Website | Coach-Seite → Lab-agent-Karte → Refresh |
| Kandidaten sehen/importieren | Registry-Seite → „Agent research candidates" |

## Sicherheit — die drei Regeln

1. **Token nur als Umgebungsvariable**, nie in Dateien/Commits (der Endpoint prüft ihn serverseitig, Lesen UND Schreiben sind damit geschützt — Fremde sehen deinen Lab-Zustand nicht).
2. Die Agents pushen **nur Anzeigedaten** (Zahlen, Status, Strategie-Code). Keine API-Keys, keine Secrets in den State legen — der KI-Schlüssel bleibt serverseitig in Cloudflare.
3. n8n bleibt auf localhost (nicht ins Internet freigeben) — es muss von außen nicht erreichbar sein, denn dein PC ruft immer nur raus.

## Die Threepio-Phasen (alle live)

- **Phase 1:** Validierungs-Pipeline im Backtest (Walk-Forward, Deflated Sharpe, Noise-Test). ✅
- **Phase 2:** Strategy Registry mit Lebenszyklus (Factory → Validated → Paper → Graveyard) + Korrelations-Matrix. ✅
- **Phase 3:** Paper-Trader (`lab-agent.mjs`) führt die veröffentlichten Strategien virtuell aus → Portfolio HQ auf der Coach-Seite. ✅
- **Phase 4:** Research-Agent (`research-agent.mjs`) liest Papers → KI-Code → Validierung → Kandidaten/Graveyard, autonom. ✅

*Kein Investment-Advice; das System handelt ausschließlich mit virtuellem Geld.*

---

## Schritt 8 — Cortex: Nacht-Recherche + Tages-Validierung (kein Handverschieben mehr)

Ab hier läuft die Pipeline vollständig ohne dich. Nachts wird gesucht, tagsüber
wird geprüft und automatisch ins Paper-Portfolio befördert.

### Die drei Agenten

| Agent | Wann | Was |
|---|---|---|
| `lab-agent.mjs` | alle 15 Min | führt die publizierten Strategien aus, RiskGate, pusht State |
| `research-agent.mjs` | 2–5× pro Nacht | erntet Quellen, liest Volltext, baut + testet Strategien |
| `revalidate-agent.mjs` | alle ~3h tagsüber | testet Kandidaten auf frischen Daten nach, befördert automatisch |

### Die zwei Strenge-Profile

Jede Strategie wird in **einem** Backtest-Durchlauf gegen **beide** Regime bewertet:

| | Prop firm | Privates Konto |
|---|---|---|
| Max Drawdown (Backtest) | 15 % | 35 % |
| Profit-Faktor | ≥ 1.25 | ≥ **1.35** |
| Min. Trades | 30 | 20 |
| DSR bei Entdeckung | ≥ 97 % | ≥ 95 % |
| DSR bei Re-Validierung | ≥ 95 % | ≥ 92 % |
| Live-Drawdown-Limit | 8 % | 30 % |
| Tagesverlust-Limit | 4 % | 10 % |
| Handelsfenster (UTC) | 13–21 | 0–24 |
| Plätze im Buch | 3 | 8 |

Der Profit-Faktor ist beim privaten Profil **höher**, nicht niedriger. Das lockere
Drawdown-Limit ist ein Tausch, kein Rabatt: wer ein 30-%-Loch graben darf, muss
dafür besser bezahlen. Sonst wäre "privat" nur das Profil, in dem schwache
Strategien durchrutschen.

Anpassen: alles steht in `src/lib/profiles.js` an einer Stelle.

### n8n: zwei zusätzliche Workflows

**Nacht-Recherche** — Schedule Trigger, Cron `0 1,3,5 * * *` (also 01:00, 03:00, 05:00):

```
Execute Command:
  node scripts/research-agent.mjs
```

Für 5 Läufe: `0 0,1,2,3,4 * * *`. Mehr als 5 bringt wenig — jeder Versuch hebt
den globalen DSR-Zähler, die Hürde steigt also mit jedem Lauf.

**Tages-Validierung** — Schedule Trigger, Cron `0 8,11,14,17,20 * * *`:

```
Execute Command:
  cd C:\Users\gilap\Documents\GitHub\mmmxcix-quant && node scripts/revalidate-agent.mjs
```

Beide brauchen `LAB_TOKEN` in der Umgebung, wie der Lab-Agent auch.

> Wenn du die Nacht-Workflows anlegst, setze `LAB_AUTO_RESEARCH=0` — sonst
> startet der 15-Minuten-Agent zusätzlich noch alle ~20h eine eigene Recherche.

### Die Quellen (7 statt 2)

arXiv · OpenAlex · Crossref · Zenodo · Practitioner-Blogs (Alpha Architect,
Quantpedia, Robot Wealth, QuantInsti, NBER) · Hacker News · **YouTube**
(Transkripte über yt-dlp).

**Volltext statt Abstract:** Wo möglich liest der Agent den ganzen Text — arXiv-HTML,
`content:encoded` aus RSS, YouTube-Auto-Captions. Ein Abstract sagt, *dass* Momentum
wirkt; der Text sagt, *wie* gemessen wurde. Gemessene Rate: ~5 von 14 Fundstücken
werden hochgestuft, der Rest fällt sauber aufs Abstract zurück.

**Nicht dabei: TikTok und Instagram.** Beide sind login-verrammelt und aktiv
anti-Bot; ein Scraper dafür bricht binnen Wochen und *still*. Reddit stand kurz
in der Liste und flog wieder raus — es antwortet inzwischen jedem Nicht-OAuth-Client
mit 403. Eine Quelle, die still nichts liefert, ist schlimmer als eine Quelle weniger.

---

## Schritt 9 — IBKR Paper-Account automatisch bespielen (optional)

Der Agent kann seine Entscheidungen zusätzlich als echte Orders in deinen
**IBKR-Paper-Account** spiegeln.

### Voraussetzungen

1. **Client Portal Gateway** läuft lokal (Standard `https://localhost:5000`)
2. Du hast dich dort **einmal im Browser** mit den **Paper**-Zugangsdaten eingeloggt
3. Die Session hält ~1 Tag — danach ist ein erneuter Login nötig (IBKR-Vorgabe,
   nicht umgehbar)

### Einschalten

```powershell
$env:LAB_IBKR_TRADE   = "1"          # ohne das passiert gar nichts
$env:LAB_IBKR_SHARES  = "10"         # feste Stückzahl je Strategie
$env:LAB_IBKR_ACCOUNT = "DU1234567"  # optional, sonst erstes Konto
```

### Die drei Bremsen

1. **Opt-in** — ohne `LAB_IBKR_TRADE=1` wird keine einzige Order gesendet
2. **Paper-Assertion** — der Agent verweigert den Dienst bei jeder Konto-ID, die
   nicht `DU…`/`DF…` ist. Ein versehentlich im Live-Konto eingeloggtes Gateway
   führt zu einem lauten Abbruch, nicht zu echten Trades
3. **Kill-Switch** — `LAB_IBKR_KILL=1` blockiert sofort alles, ohne Code-Änderung

### Was gespiegelt wird — und was nicht

Nur **Aktien**-Strategien. Das Gateway löst normale US-Ticker zu Kontrakten auf;
eine `BTCUSDT`-Strategie hat dort nichts zu handeln und wird übersprungen (mit
Vermerk, nicht stillschweigend). Auto-promotete Strategien laufen aktuell auf
`BTCUSDT` — für IBKR musst du also mindestens eine Aktien-Strategie in der
Registry publizieren, sonst ist die Spiegelung zwar scharf, aber ohne Arbeit.

Die Stückzahl ist **fix** und folgt nicht dem simulierten Konto. Absicht: die
beiden Konten haben unterschiedliche Stände und driften ab dem ersten Fill
auseinander. Verglichen werden soll das **Signal**, nicht die Positionsgröße.

Status steht auf der RiskGate-Seite unter „IBKR paper mirroring".

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

## Schritt 7 — Der autonome Research-Agent (2. Workflow, täglich)

Neben dem Paper-Trader (`lab-agent.mjs`, alle 15 min) gibt es jetzt den **Research-Agent** (`research-agent.mjs`): Er liest die neuesten Quant-Papers von arXiv, lässt deine eigene KI-API daraus Strategie-Code extrahieren, jagt jeden Kandidaten durch die volle Validierungs-Pipeline (k-Fold, Noise-Test, Deflated Sharpe mit globalem Versuchszähler) und speichert die Überlebenden auf der Website. Das ist genau der „KI researched von selbst"-Teil aus dem Video.

**Von Hand testen:**
```powershell
cd C:\Users\gilap\Documents\GitHub\mmmxcix-quant
node scripts\research-agent.mjs
```
Erwartete Ausgabe: `arXiv: 25 papers, N fresh…` und pro Paper entweder `✓ CANDIDATE`, `✗ graveyard: … (Grund)` oder `~ skipped (rate-limited)`.

**In n8n als zweiten Workflow anlegen** (nicht alle 15 min — einmal täglich reicht und schont das KI-Kontingent):
1. **Create Workflow** → Name `Research Agent`.
2. **Schedule Trigger** → *Trigger Interval*: **Days**, *Days Between Triggers*: **1** (z. B. Trigger at Hour 3 nachts).
3. **Execute Command** → `node C:\Users\gilap\Documents\GitHub\mmmxcix-quant\scripts\research-agent.mjs`.
4. **Save** → **Active**.

**Wo die Ergebnisse landen:** Coach-Seite → Karte „Lab agent" → Block **Research loop** (Zähler: papers read / strategies tried / graveyard / candidates). Die Überlebenden erscheinen in der **Registry** unter „Agent research candidates" mit Ein-Klick-Import.

### Wichtig: das KI-Kontingent (Gemini Free Tier)
Der Research-Agent braucht deine KI-API (`/api/generate`). Aktuell läuft die über den **kostenlosen Gemini-Tarif**, der ein **tägliches Limit** hat. Symptom: `~ skipped (rate-limited)`. Das ist kein Fehler — die Papers bleiben „frisch" und werden beim nächsten Lauf erneut versucht. Optionen:
- **Nichts tun:** einmal täglich laufen lassen; das Kontingent reicht meist für 1–2 Papers/Tag → über Wochen sammeln sich Kandidaten an.
- **Weniger pro Lauf:** Umgebungsvariable `LAB_RESEARCH_PAPERS=1` setzen.
- **Mehr Durchsatz:** einen bezahlten `ANTHROPIC_API_KEY` als Cloudflare-Secret hinterlegen (der Endpoint bevorzugt ihn dann automatisch) — dann verschwindet das Limit praktisch.

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

# Setup-Tutorial: Alles, was DU außerhalb von Claude Code machen musst

Dieses Dokument ist deine komplette Checkliste für alle manuellen Schritte — Dinge, die ich (Claude) nicht für dich tun kann, weil sie auf deinem PC, in deinem Browser oder in fremden Dashboards passieren. Reihenfolge einhalten; jeder Block sagt dir, wie du prüfst, ob er geklappt hat.

## Die Checkliste im Überblick

| # | Aufgabe | Dauer | Status |
|---|---|---|---|
| 1 | Dev-Token bereitlegen | 2 min | ☐ |
| 2 | Node.js LTS installieren | 5 min | ☐ |
| 3 | Token als Umgebungsvariable setzen | 2 min | ☐ |
| 4 | Ersten Push testen → Coach-Karte „online" | 5 min | ☐ |
| 5 | n8n installieren + Workflow anlegen | 15 min | ☐ |
| 6 | Autostart (pm2) einrichten | 10 min | ☐ |
| 7 | Energieeinstellungen (kein Schlafmodus) | 2 min | ☐ |
| 8 | Newsletter-Secrets in Cloudflare (offen seit Wochen) | 15 min | ☐ |
| 9 | Später: NinjaTrader/TradingView (Trading-Roadmap) | — | ☐ |

---

## 1) Dev-Token bereitlegen

Der Lab-Agent authentifiziert sich mit deinem `DEV_ACCESS_TOKEN` — derselbe Token, den du beim KI-Generator und der Coach-Seite eingibst.

- **Du kennst ihn noch:** einfach bereithalten.
- **Vergessen?** Cloudflare Dashboard → **Workers & Pages** → dein Projekt `mmmxcix-quant` → **Settings** → **Environment variables** → `DEV_ACCESS_TOKEN`. Secrets sind dort nicht lesbar — dann neuen Wert setzen (langer Zufallsstring), **Save**, und danach einmal neu deployen (passiert automatisch beim nächsten Push; sag mir sonst Bescheid). Denk daran, den neuen Token danach im Browser auf der Coach-Seite neu einzugeben.

## 2) Node.js LTS systemweit installieren

Bisher hast du nur mein portables Node im Temp-Ordner — für Dauerbetrieb brauchst du die echte Installation.

PowerShell **als Administrator** (Startmenü → „PowerShell" → Rechtsklick → Als Administrator ausführen):

```powershell
winget install OpenJS.NodeJS.LTS
```

**Prüfen** (neues PowerShell-Fenster öffnen — wichtig, sonst kennt es den Pfad noch nicht):

```powershell
node --version     # erwartet: v22.x oder neuer
npm --version
```

## 3) Token dauerhaft als Umgebungsvariable setzen

Einmalig in PowerShell (normaler Benutzer reicht):

```powershell
[Environment]::SetEnvironmentVariable("LAB_TOKEN", "<HIER-DEIN-DEV-TOKEN>", "User")
```

**Prüfen** (neues Fenster): `echo $env:LAB_TOKEN` → zeigt den Token.

> Regel: Der Token existiert nur an zwei Orten — als Cloudflare-Secret und als diese Umgebungsvariable. Nie in Dateien, nie in Git, nie in n8n-Feldern eintippen.

## 4) Ersten Push von Hand testen

```powershell
cd C:\Users\gilap\Documents\GitHub\mmmxcix-quant
node scripts\lab-agent.mjs
```

Erwartet: `state pushed (… bytes) → https://quant.mmmxcix.com/api/lab`

**Sichtprüfung:** quant.mmmxcix.com → **Coach** → Karte **„Lab agent (your PC)"** zeigt grün **online**, „last push just now", BTC/ETH/SOL-Preise. Damit ist die ganze Kette PC → Cloudflare → Website bewiesen.

Häufige Fehler an dieser Stelle:
- `LAB_TOKEN is not set` → Schritt 3 wiederholen, neues Fenster öffnen.
- `push failed: HTTP 401` → Token falsch (Tippfehler? alter Token?).
- `node: not recognized` → Schritt 2, neues Fenster.

## 5) n8n installieren und den Workflow anlegen

**Installieren & starten:**

```powershell
npm install -g n8n
n8n
```

Erster Start dauert ~1 Minute, dann öffnet sich **http://localhost:5678**. Dort lokales Konto anlegen (E-Mail + Passwort — bleibt auf deinem PC, kein Cloud-Zwang; die Fragen zum Unternehmen kannst du beliebig beantworten oder skippen).

**Workflow bauen** (im n8n-Editor):
1. **Create Workflow**, Name: `Lab Agent`.
2. Plus-Symbol → Suche **Schedule Trigger** → hinzufügen → *Trigger Interval*: **Minutes**, *Minutes Between Triggers*: **15**.
3. Am Schedule-Node auf **+** → Suche **Execute Command** → hinzufügen → Feld *Command*:
   ```
   node C:\Users\gilap\Documents\GitHub\mmmxcix-quant\scripts\lab-agent.mjs
   ```
4. Oben **Save**, dann Schalter **Inactive → Active**.
5. **Test:** Execute-Command-Node anklicken → **Execute step** → im Output-Panel muss `state pushed` stehen. Falls `401`: n8n neu starten (es muss die LAB_TOKEN-Variable aus Schritt 3 erben — sie wurde VOR dem n8n-Start gesetzt?).

Ab jetzt pusht dein PC alle 15 Minuten automatisch, solange n8n läuft.

## 6) Autostart — n8n überlebt Neustarts

```powershell
npm install -g pm2 pm2-windows-startup
pm2 start (Get-Command n8n).Source --name n8n
pm2 save
pm2-startup install
```

**Prüfen:** PC neu starten → anmelden → 2 Minuten warten → http://localhost:5678 erreichbar? `pm2 status` zeigt `n8n … online`?

> Hinweis: pm2-startup greift **bei Anmeldung**. Wenn der PC neu startet und niemand sich anmeldet, läuft n8n nicht. Für einen ernsthaften Server-Betrieb später: automatische Anmeldung aktivieren oder n8n als Windows-Dienst (sag mir Bescheid, das machen wir zusammen).

## 7) Energieeinstellungen

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change monitor-timeout-ac 10
```

Monitor darf ausgehen (10 min), Rechner nie. Stromkosten-Realität (24/7, ~0.27 CHF/kWh): Laptop idle ~8 W ≈ **1.60 CHF/Monat**; Büro-Desktop ~45 W ≈ **9 CHF/Monat**; Gaming-PC idle ~80 W ≈ 16 CHF/Monat. (Watt ist die Rate — „pro Stunde" steckt schon drin.) Wenn der PC doch mal aus ist: kein Schaden — die Coach-Karte zeigt „offline" und den letzten Stand.

## 8) Offene Cloudflare-Aufgabe: Newsletter-Secrets (seit Wochen pendent!)

Damit dein Newsletter-Double-Opt-in echte Bestätigungs-Mails verschickt:

1. **resend.com** → kostenloses Konto → **API Keys** → Key erstellen (beginnt mit `re_`). Free Tier: 100 Mails/Tag — reicht locker.
2. Bei Resend deine Domain `mmmxcix.com` verifizieren (**Domains → Add Domain** → die angezeigten DNS-Einträge in Cloudflare → **DNS** anlegen; Resend prüft automatisch).
3. Cloudflare → **Workers & Pages** → `mmmxcix-quant` → **Settings → Environment variables** → zwei Secrets anlegen (Production):
   - `RESEND_API_KEY` = dein `re_…`-Key
   - `DIGEST_FROM` = z. B. `MMMXCIX Quant <digest@mmmxcix.com>`
4. Neu deployen lassen (nächster Git-Push oder Dashboard → Deployments → Retry).

**Prüfen:** Auf der News-Seite mit deiner E-Mail subscriben → Bestätigungs-Mail kommt an.

## 9) Später (Trading-Roadmap, nichts überstürzen)

Erst wenn Phase 1 der Coach-Roadmap (Academy) durch ist:
- **NinjaTrader**: ninjatrader.com → Konto → Desktop-Plattform installieren → im Login **Simulation** wählen. Kostenlos für Sim/Backtesting.
- **TradingView**: Gratis-Konto reicht anfangs (Paper-Trading eingebaut).
- **Topstep**: erst kaufen, wenn das Sim-Gate aus dem Coach-Plan grün ist — vorher ist es Gebühren-Verbrennen.

---

## Troubleshooting-Spickzettel

| Symptom | Ursache → Lösung |
|---|---|
| `node: not recognized` | PATH noch alt → neues PowerShell-Fenster; notfalls Schritt 2 wiederholen |
| Push: HTTP 401 | Falscher/alter Token → Schritt 1+3; n8n danach neu starten |
| Coach-Karte „offline" trotz n8n | n8n → **Executions**: rote Läufe anklicken, Fehlermeldung lesen |
| n8n nach Reboot weg | `pm2 status` → leer? `pm2 resurrect`; pm2-startup nur bei Anmeldung! |
| n8n-Port 5678 belegt | Anderes n8n läuft schon (pm2!) → nicht doppelt manuell starten |
| Karte zeigt „No state received yet" | Noch nie gepusht → Schritt 4 |

Wenn irgendwo etwas hakt: Fehlermeldung kopieren und mir heute Abend geben — den Rest (Phase 2: Strategy Registry mit Graveyard) baue ich dann, während du das hier abhakst.

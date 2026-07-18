# Deine To-do-Liste

Stand: 19. Juli 2026, nach der Nachtsession. Alles, was **du** noch tun musst —
in der Reihenfolge, in der es Sinn ergibt.

Alles andere ist gebaut, getestet und committed (Branch `cortex-autonomous`,
3 Commits). Nichts davon ist auf `main`, `main` ist unangetastet.

---

## Zuerst: 5 Minuten, danach läuft das Meiste

### 1. Branch anschauen und mergen

```powershell
cd C:\Users\gilap\Documents\GitHub\mmmxcix-quant
git log --oneline main..cortex-autonomous     # was drin ist
git checkout main
git merge --no-ff cortex-autonomous
node "node_modules\vite\bin\vite.js" build     # muss durchlaufen
git push origin main
```

Der Push löst das Cloudflare-Deployment aus. **Wichtig:** Der neue
`research`-Kanal in `/api/generate` ist erst nach diesem Deploy aktiv — bis
dahin läuft der Nacht-Agent auf einen 400er.

### 2. Umgebungsvariable setzen

```powershell
[Environment]::SetEnvironmentVariable("LAB_AUTO_RESEARCH", "0", "User")
```

Sonst startet der 15-Minuten-Agent **zusätzlich** alle ~20 h eine eigene
Recherche und du hast doppelte Läufe.

---

## Dann: n8n-Workflows (ca. 15 Minuten)

Du hast aktuell nur den „Lab Agent"-Workflow. Es fehlen **drei**. Für jeden:
neuer Workflow → *Schedule Trigger* → *Execute Command*.

| Workflow | Cron | Befehl |
|---|---|---|
| Nacht-Recherche | `0 1,3,5 * * *` | `cd C:\Users\gilap\Documents\GitHub\mmmxcix-quant && node scripts/research-agent.mjs` |
| Tages-Validierung | `0 8,11,14,17,20 * * *` | `cd C:\Users\gilap\Documents\GitHub\mmmxcix-quant && node scripts/revalidate-agent.mjs` |
| Quellensuche | `0 12 * * *` | `cd C:\Users\gilap\Documents\GitHub\mmmxcix-quant && node scripts/discover-sources.mjs` |

Alle brauchen `LAB_TOKEN` in der Umgebung (hast du bereits). **n8n nach dem
Setzen von Umgebungsvariablen neu starten**, sonst kennt es sie nicht.

Willst du 5 Nacht-Läufe statt 3: `0 0,1,2,3,4 * * *`.

---

## Optional, aber lohnend

### 3. IBKR Paper-Konto verbinden (30–45 Minuten)

Vollständige Anleitung: **`docs/IBKR_TUTORIAL.md`**

Kurzfassung: Paper-Konto aktivieren → Client Portal Gateway herunterladen und
starten → im Browser mit den **Paper**-Daten einloggen → drei Umgebungsvariablen
setzen → Testlauf.

Beachte: Die Gateway-Session läuft **täglich** ab, das ist IBKR-Vorgabe. Und
gespiegelt werden nur **Aktien**-Strategien.

### 4. pm2-Autostart für n8n

Damit n8n nach einem Neustart von selbst hochkommt:

```powershell
npm install -g pm2 pm2-windows-startup
pm2-startup install
pm2 start n8n
pm2 save
```

### 5. Energieeinstellungen

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
```

Ohne das schläft der PC nachts ein und die Recherche läuft nicht.

### 6. Dev-Token rotieren

Dein `LAB_TOKEN` war früher in dieser Session auf einem Screenshot sichtbar.
Neu erzeugen und in Cloudflare als `DEV_ACCESS_TOKEN` ersetzen — dann in beiden
Umgebungsvariablen aktualisieren.

---

## Was du wissen solltest, bevor du dich wunderst

### Erwarte 1–2 beförderte Strategien pro Monat, nicht Dutzende

Ich habe einen Fehler gefunden, der **schon vorher** im Code steckte: Die
DSR-Schwelle von 95/97 % war bei einem lebenslang wachsenden Versuchszähler
mathematisch unerreichbar. Nach ein paar Dutzend Papers hätte das System **nie
wieder** etwas befördert.

Gemessen an echten Daten: Eine wirklich gute Strategie (QQQ-Trend, Sharpe 1.05)
erreicht bei 90 Versuchen nur **58.7 %**. Die alten Schwellen hätten sie
abgelehnt.

Neu: **70 % (prop) / 50 % (privat)**, mit gefenstertem Zähler und Märkten als
Cluster gezählt. Die Messtabelle steht in **`docs/CORTEX_CALIBRATION.md`** —
schau sie dir an, bevor du die Werte änderst.

### Die erste Nacht wird wenig liefern

Der Quellen-Discovery-Agent hat 139 Kandidaten in der Warteschlange, die er über
die nächsten Läufe abarbeitet. Aktuell 6 aktive Feeds. Das wächst über eine
Woche, nicht über eine Nacht.

### Was ich NICHT verifizieren konnte

- **Der `research`-Kanal in `/api/generate`** — braucht das Deployment (Punkt 1).
- **Die IBKR-Order-Kette** — kein Gateway lief. Code ist geschrieben und
  syntaktisch geprüft, aber nie gegen ein echtes Gateway ausgeführt.

Beides also bitte beim ersten Lauf im Auge behalten.

---

## Offene Punkte, die ich bewusst nicht gebaut habe

**Bull/Bear-Debatte.** Das Dokument, das du geschickt hast, beschreibt eine
Adversarial-Debatte (Bull-Case gegen Bear-Case) vor der Strategie-Annahme. Das
ist der einzige substanzielle Punkt aus dem Papier, den unsere Version nicht hat.
Ich habe stattdessen die Kalibrierung repariert — ein Tor, das nie öffnet, macht
jede Debatte davor bedeutungslos. Als nächster Schritt sinnvoll: ein
`critique`-Kanal in `/api/generate`, der für jeden Überlebenden eine
Gegenposition und explizite Invalidierungsbedingungen erzeugt und am Kandidaten
speichert.

**Fill-Modell im Simulator.** Füllt weiterhin zum letzten Close. Die
Per-Markt-Slippage ist jetzt in den Kosten drin, aber der Fill selbst ist
unverändert optimistisch.

**Deine alte Leseliste.** orionrfx/Nebula, das Google Doc (habe ich für die
3PO-Analyse gelesen), awesome-quant, computational-finance-course,
ml-for-trading, financial-models-numerical-methods. Die drei GitHub-Repos
speisen inzwischen die Quellensuche — inhaltlich durchgearbeitet habe ich sie
noch nicht.

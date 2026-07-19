# IBKR Paper-Account mit Cortex verbinden

Schritt für Schritt. Rechne mit **30–45 Minuten** beim ersten Mal, das meiste
davon Wartezeit beim IBKR-Login.

Am Ende platziert der Agent alle 15 Minuten echte Orders in deinem
IBKR-**Paper**-Konto — automatisch, nach denselben Signalen, die der Simulator
handelt.

---

## Bevor du anfängst — drei Dinge, die du wissen solltest

**1. Es ist ein Paper-Konto.** Kein echtes Geld. Der Agent weigert sich aktiv,
auf einem Live-Konto zu laufen (siehe Schritt 6).

**2. Die Gateway-Session läuft täglich ab.** IBKR erzwingt das, das ist nicht
umgehbar. Du musst dich einmal pro Tag im Browser neu einloggen, sonst pausiert
die Spiegelung (der Agent merkt es und schreibt es ins Log — er handelt nicht
blind weiter).

**3. Nur Aktien-Strategien werden gespiegelt.** Das Gateway löst normale
US-Ticker zu Kontrakten auf. Eine `BTCUSDT`-Strategie hat dort nichts zu
handeln und wird übersprungen. Wenn dein Paper-Portfolio aktuell nur Crypto
enthält, ist die Spiegelung zwar scharf, hat aber nichts zu tun — siehe
Schritt 8.

---

## Schritt 1 — Paper-Konto aktivieren

1. Einloggen auf [interactivebrokers.com](https://www.interactivebrokers.com)
2. Menü oben rechts → **Settings** → **Account Settings**
3. Abschnitt **Paper Trading Account** → **Reactivate** bzw. **Create**
4. IBKR schickt dir einen **separaten Benutzernamen** (beginnt mit `du…`) und
   du vergibst ein eigenes Passwort

> Das Paper-Konto hat **eigene Zugangsdaten**. Das ist wichtig: du loggst das
> Gateway später mit *diesen* ein, nicht mit deinen Live-Daten.

Die Konto-ID beginnt mit **`DU`** (z. B. `DU1234567`). Notiere sie.

---

## Schritt 2 — Client Portal Gateway herunterladen

1. [interactivebrokers.com/en/trading/ib-api.php](https://www.interactivebrokers.com/en/trading/ib-api.php)
2. Reiter **Client Portal API** → **Download** (ZIP, ca. 30 MB)
3. Entpacken, z. B. nach `C:\ibkr-gateway\`

Voraussetzung: **Java 8 oder neuer**. Prüfen:

```powershell
java -version
```

Fehlt Java: [adoptium.net](https://adoptium.net) → Temurin JRE 17 installieren.

---

## Schritt 3 — Gateway starten

```powershell
cd C:\ibkr-gateway
.\bin\run.bat root\conf.yaml
```

Das Fenster **offen lassen** — das ist der laufende Server. Es sollte enden mit
etwa `Open https://localhost:5000 to login`.

> Tipp: Später via pm2 oder Aufgabenplanung automatisch starten lassen, damit du
> das nicht jeden Tag von Hand machst.

---

## Schritt 4 — Einloggen und Zertifikat akzeptieren

1. Browser öffnen: **https://localhost:5000**
2. Warnung „Verbindung ist nicht sicher" → **Erweitert** → **Weiter zu localhost**

   Das ist erwartet: das Gateway nutzt ein selbstsigniertes Zertifikat auf
   deinem eigenen Rechner. Kein Grund zur Sorge, aber merk dir, dass du das
   akzeptiert hast.

3. Mit den **Paper**-Zugangsdaten aus Schritt 1 einloggen (`du…`)
4. Erfolgreich, wenn dort steht: **Client login succeeds**

Prüfen, ob es wirklich läuft:

```powershell
curl.exe -k https://localhost:5000/v1/api/iserver/auth/status
```

Erwartet: `{"authenticated":true,"connected":true,...}`

Wenn `authenticated:false` → nochmal im Browser einloggen.

---

## Schritt 5 — Konto-ID bestätigen

```powershell
curl.exe -k https://localhost:5000/v1/api/iserver/accounts
```

In der Antwort steht deine Konto-ID. **Sie muss mit `DU` oder `DF` beginnen.**

Steht dort `U1234567` (ohne D), bist du im **Live-Konto** eingeloggt. Dann:
ausloggen, mit den Paper-Daten neu einloggen. Der Agent würde sich ohnehin
weigern — aber besser, du merkst es hier.

---

## Schritt 6 — Cortex scharf schalten

PowerShell, dauerhaft für deinen Benutzer:

```powershell
[Environment]::SetEnvironmentVariable("LAB_IBKR_TRADE", "1", "User")
[Environment]::SetEnvironmentVariable("LAB_IBKR_SHARES", "10", "User")
[Environment]::SetEnvironmentVariable("LAB_IBKR_ACCOUNT", "DU1234567", "User")
```

`LAB_IBKR_ACCOUNT` ist optional — ohne den Eintrag nimmt der Agent das erste
Konto. Setz ihn trotzdem, wenn das Gateway mehrere Konten sieht.

**Danach n8n neu starten**, sonst kennt es die Variablen nicht.

### Die drei Bremsen

| Bremse | Wirkung |
|---|---|
| `LAB_IBKR_TRADE` fehlt oder ≠ `1` | Es wird **keine einzige Order** gesendet |
| Konto-ID ist nicht `DU…`/`DF…` | Agent bricht laut ab, handelt nicht |
| `LAB_IBKR_KILL=1` | Sofortiger Stopp, ohne Code-Änderung |

Der Kill-Switch ist dein Notaus:

```powershell
[Environment]::SetEnvironmentVariable("LAB_IBKR_KILL", "1", "User")
```

---

## Schritt 7 — Testlauf

```powershell
cd C:\Users\gilap\Documents\GitHub\mmmxcix-quant
node scripts/lab-agent.mjs
```

Was du sehen willst:

```
IBKR paper account DU1234567 armed
  ⇄ IBKR SPY: BUY 10 (0 → 10)
paper run complete: 3 strategies, combined 30412 → pushed 2104 bytes
```

Häufige Meldungen und was sie bedeuten:

| Meldung | Bedeutung | Lösung |
|---|---|---|
| `gateway unreachable` | Gateway läuft nicht | Schritt 3 |
| `gateway is up but not authenticated` | Session abgelaufen | Schritt 4 |
| `account … is not an IBKR paper account` | Live-Konto eingeloggt | Schritt 5 |
| `not a stock symbol` | Crypto-Strategie | Erwartet, siehe Schritt 8 |
| `no conid for XYZ` | Ticker nicht auflösbar | Anderes Symbol |

Kontrolle im Browser: **https://localhost:5000** → Portfolio. Dort müssen die
Positionen stehen.

---

## Schritt 8 — Damit auch wirklich etwas gehandelt wird

Wenn `not a stock symbol` bei allem steht, enthält dein Paper-Portfolio nur
Crypto. Zwei Wege:

**A. Aktien-Strategie von Hand publizieren** — Registry → eine Strategie mit
Markt „stock" und Symbol z. B. `SPY` → *Publish to agent*.

**B. Warten** — der Nacht-Agent testet inzwischen über 10 Märkte (inkl. SPY,
QQQ, AAPL, TSLA, EUR/USD) und befördert automatisch für den Markt, auf dem eine
Strategie tatsächlich funktioniert. Sobald eine Aktien-Variante durchkommt,
spiegelt IBKR sie von selbst.

---

## Schritt 9 — Status im Blick behalten

Auf der Website: **Cortex → RiskGate**, Abschnitt „IBKR paper mirroring". Dort
steht, ob das Konto scharf ist und was schiefging.

---

## Wie die Stückzahl bestimmt wird

**Fix**, standardmäßig 10 Aktien pro Strategie — nicht abgeleitet vom simulierten
Konto.

Absicht: Simulator und Paper-Konto haben unterschiedliche Stände und driften ab
dem ersten Fill auseinander. Verglichen werden soll das **Signal**, nicht die
Positionsgröße. Wer beide Zahlen deckungsgleich halten will, jagt einem
Rundungsfehler hinterher.

Ändern über `LAB_IBKR_SHARES`.

---

## Grenzen, ehrlich benannt

- **Kein Slippage-Vergleich.** Der Simulator rechnet mit geschätzten Kosten,
  IBKR füllt real. Genau diese Differenz zu sehen ist der Sinn der Übung.
- **Nur Market-Orders.** Keine Limits, keine Brackets, keine Stops beim Broker.
  Der Ausstieg kommt vom Signal beim nächsten 15-Minuten-Lauf.
- **Kein Intraday-Nachlauf.** Zwischen zwei Läufen liegen 15 Minuten. Für
  Strategien auf 15-Minuten-Kerzen ist das grenzwertig.
- **Tägliches Neu-Login.** IBKR-Vorgabe.

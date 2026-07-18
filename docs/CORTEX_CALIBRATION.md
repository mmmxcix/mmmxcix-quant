# Cortex — Kalibrierung der Schwellen

Warum die Zahlen in `src/lib/profiles.js` so sind, wie sie sind. Gemessen, nicht geraten.

## Das Problem, das ich gefunden habe

Die ursprüngliche Version verlangte **DSR ≥ 95 %** (privat) bzw. **97 %** (prop) und
fütterte den Deflated-Sharpe-Test mit dem **lebenslangen** Versuchszähler
(`st.attempts`). Dieser Zähler wächst für immer.

Das ist selbstzerstörend. Gemessen an echten Marktdaten (10 Jahre, echte Kosten):

| Strategie | Sharpe | t=1 | t=10 | t=30 | t=50 | t=90 | t=150 | t=300 | t=600 |
|---|---|---|---|---|---|---|---|---|---|
| QQQ 1d, Long-only Trend 50 | 1.05 | 99.7 % | 87.3 % | 73.9 % | 66.9 % | **58.7 %** | 51.7 % | 42.8 % | 34.7 % |
| TSLA 1d, Long-only Trend 50 | 0.87 | 98.9 % | 76.1 % | 58.3 % | 50.3 % | **41.7 %** | 34.9 % | 27.0 % | 20.5 % |
| SPY 1d, Long-only Trend 50 | 0.82 | 98.3 % | 70.5 % | 51.6 % | 43.6 % | **35.2 %** | 28.9 % | 21.7 % | 16.0 % |
| BTC 4h, RSI Mean-Reversion | 0.54 | 81.5 % | 24.9 % | 12.0 % | 8.4 % | **5.5 %** | 3.8 % | 2.3 % | 1.4 % |

Eine 95-%-Schwelle ist nur bei **t ≈ 1–5** erreichbar. Nach wenigen Dutzend
gelesenen Papers hätte der Agent **nie wieder** irgendetwas befördert — egal wie
gut es war. Das ist kein strenges System, das ist ein kaputtes.

## Die drei Korrekturen

### 1. Gefensterter statt lebenslanger Zähler

Die Multiple-Testing-Korrektur gehört zu dem Auswahlprozess, der **diesen**
Kandidaten hervorgebracht hat. Strategien, die vor sechs Monaten aus völlig
anderen Papers entstanden, waren nicht Teil dieser Auswahl.

`LAB_TRIAL_WINDOW_DAYS=30` (Standard), gedeckelt bei `LAB_TRIAL_WINDOW_CAP=60`.
Der Deckel, weil die DSR-Kurve jenseits einiger hundert Versuche abflacht: jeder
weitere Versuch senkt die Hürde, liefert aber praktisch keine Information mehr.

### 2. Märkte als Cluster, nicht einzeln

Beim Test über 10 Märkte wäre `trials × 10` die naive Rechnung. Aber SPY und QQQ
sind zu ~0.9 korreliert — sie als zwei unabhängige Versuche zu zählen,
überschätzt die Strafe erheblich.

Gezählt werden die **verschiedenen Asset-Klassen** (crypto / stock / forex),
also maximal 3. Bei 30 Versuchen im Fenster × 3 Cluster = 90 effektive Trials.

### 3. Schwellen dorthin, wo sie trennen

| | prop | privat |
|---|---|---|
| DSR bei Entdeckung | 70 % | 50 % |
| DSR bei Re-Validierung | 60 % | 40 % |

Bei 90 effektiven Trials heißt das:

- QQQ-Trend (58.7 %) → **privat ja**, prop nein
- TSLA (41.7 %), SPY (35.2 %) → abgelehnt
- RSI-Rauschen (5.5 %) → klar abgelehnt

Das ist die Trennschärfe, die die Messung hergibt.

## Was das für dich bedeutet

**Erwarte ein bis zwei beförderte Strategien pro Monat, nicht Dutzende.**

Das ist der Deflated Sharpe bei der Arbeit: wer hunderte Ideen durchprobiert,
darf nur noch ein außergewöhnliches Ergebnis für echt halten. Der eigentliche
Filter ist die strukturelle Suite — k-Fold, Noise-Test, Out-of-Sample-Holdout,
Multi-Markt-Übereinstimmung. Der DSR ist das letzte Qualitätstor darüber.

Wenn dir das zu streng oder zu locker ist: alles steht an **einer** Stelle in
`src/lib/profiles.js`. Diese Tabelle sagt dir, was eine Änderung bewirkt.

## Kosten pro Markt

Der alte Code rechnete überall mit pauschal 10 bps. Das schmeichelt genau den
Intraday-Strategien, die am ehesten Rauschen sind — eine 15-Minuten-Strategie
zahlt den Spread ungleich häufiger als eine Tagesstrategie.

Jetzt (`src/lib/markets.js`): Gebühr nach Asset-Klasse (crypto 10, stock 5,
forex 2 bps) **plus** Slippage nach Zeitrahmen (1m 12 → 1d 2 bps).

## Reproduzieren

Die Messungen oben stammen aus Skripten im Scratchpad dieser Session. Zum
Nachrechnen: `runBacktest` über die Märkte aus `UNIVERSE` laufen lassen und
`deflatedSharpe(equityReturns(equity), t)` für verschiedene `t` auswerten.

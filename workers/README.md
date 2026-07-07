# Newsletter / Daily Digest — Setup (Cloudflare + Resend)

Kurzanleitung, um den MMMXCIX Daily Digest scharf zu schalten. Alles im Cloudflare-Dashboard, kein CLI nötig.

## 1) KV-Namespace erstellen

- Cloudflare Dashboard → **Workers & Pages** → **KV** → **Create namespace**
- Name: `quant-subscribers` → **Add**

## 2) KV im Pages-Projekt binden (für `/api/subscribe`)

- Dashboard → **Workers & Pages** → Pages-Projekt (quant) öffnen
- **Settings** → **Functions** → **KV namespace bindings** → **Add binding**
- Variable name: `SUBSCRIBERS`, Namespace: `quant-subscribers` → **Save**
- Danach einmal neu deployen (oder nächsten Deploy abwarten), damit das Binding aktiv ist.
- Ohne dieses Binding antwortet `/api/subscribe` mit `503 { "error": "kv_not_configured" }`.

### Optional aber empfohlen: Bestätigungsmail sofort verschicken

Der Newsletter nutzt **Double-Opt-In**: Nach der Anmeldung muss der Nutzer einen
Link in einer Bestätigungsmail anklicken, bevor er Digests erhält (rechtlich sauber).
Damit die Bestätigungsmail **sofort** rausgeht (statt erst beim nächsten Cron-Lauf
des Workers), gib der **Pages-Funktion** ebenfalls die Resend-Zugangsdaten:

- Pages-Projekt → **Settings** → **Variables and Secrets** (Environment Production) →
  zwei **Secrets** anlegen: `RESEND_API_KEY` (aus Schritt 3) und `DIGEST_FROM`
  (z. B. `MMMXCIX Quant <digest@mmmxcix.com>`).
- Ohne diese zwei Secrets funktioniert alles trotzdem — die Bestätigungsmail
  verschickt dann der Digest-Worker beim nächsten Lauf (bis zu 24 h Verzögerung).

## 3) Resend einrichten (Mail-Versand, gratis 100 Mails/Tag)

- Account auf [resend.com](https://resend.com) anlegen (Free-Plan reicht: 100 Mails/Tag)
- **Domains** → **Add Domain** → `mmmxcix.com` eintragen
- Die angezeigten DNS-Records (SPF/TXT, DKIM, ggf. MX für Bounces) im Cloudflare-DNS von
  `mmmxcix.com` anlegen und in Resend auf **Verify** klicken
- **API Keys** → **Create API Key** → Key kopieren (wird gleich als Secret gesetzt)

## 4) Digest-Worker erstellen

- Dashboard → **Workers & Pages** → **Create** → **Create Worker** → Name z. B. `quant-digest` → **Deploy**
- **Edit code** → kompletten Inhalt von `workers/digest-worker.js` einfügen → **Deploy**
- Worker → **Settings** → **Bindings** → **Add**:
  - **KV namespace**: Variable `SUBSCRIBERS` → Namespace `quant-subscribers`
- Worker → **Settings** → **Variables and Secrets** → **Add** (Typ: Secret):
  - `RESEND_API_KEY` — der API-Key aus Schritt 3
  - `DIGEST_FROM` — Absender, z. B. `MMMXCIX Quant <digest@mmmxcix.com>`
  - `DIGEST_TEST_TOKEN` — beliebiger langer Zufallsstring (für manuelle Testläufe)

## 5) Cron Trigger setzen

- Worker → **Settings** → **Triggers** → **Cron Triggers** → **Add Cron Trigger**
- Schedule: `0 6 * * *` (täglich 06:00 UTC = 08:00 MESZ / 07:00 MEZ) → **Save**

## 6) Testlauf

- Im Browser (oder per curl) aufrufen:

  ```
  https://quant-digest.<dein-account>.workers.dev/?token=<DIGEST_TEST_TOKEN>
  ```

- Antwort ist eine JSON-Zusammenfassung, z. B.
  `{ "status": "ok", "subscribers": 3, "sent": 3, "failed": 0, "items": 12 }`
- Vorher zum Testen die eigene Adresse über die News-Seite
  ([quant.mmmxcix.com/news](https://quant.mmmxcix.com/news) → Newsletter → Abonnieren) eintragen.

## Abmelden

- `DELETE https://quant.mmmxcix.com/api/subscribe?email=adresse@example.com`
  entfernt eine Adresse (Antwort: `{ "status": "removed" }`).

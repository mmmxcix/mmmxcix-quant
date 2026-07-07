import LegalLayout, { H2 } from "@/components/LegalLayout";

// Privacy policy. Framed against the Swiss revDSG and, because the site is
// reachable from the EU, the GDPR. Covers: hosting (Cloudflare), the newsletter
// (email in Cloudflare KV + Resend as processor + symbol data), local storage,
// and third-party market-data/news fetches from the visitor's browser.
export default function Datenschutz() {
  return (
    <LegalLayout title="Datenschutzerklärung" updated="7. Juli 2026">
      <p>
        Der Schutz deiner Daten ist uns wichtig. Diese Erklärung informiert dich gemäss dem revidierten
        Schweizer Datenschutzgesetz (revDSG) und – soweit anwendbar – der EU-Datenschutz-Grundverordnung
        (DSGVO) darüber, welche Daten wir bei der Nutzung von <strong className="text-text">quant.mmmxcix.com</strong>{" "}
        bearbeiten.
      </p>

      <H2>1. Verantwortlicher</H2>
      <p>
        Gil Buholzer, Obere Egg 6, 4312 Magden, Schweiz<br />
        E-Mail: <a href="mailto:admin@mmmxcix.com" className="text-accent hover:underline">admin@mmmxcix.com</a>
      </p>

      <H2>2. Hosting &amp; Server-Logs</H2>
      <p>
        Die Seite wird über <strong className="text-text">Cloudflare Pages</strong> (Cloudflare, Inc., USA)
        gehostet. Beim Aufruf verarbeitet Cloudflare technisch notwendige Verbindungsdaten (u. a. IP-Adresse,
        Zeitpunkt, aufgerufene Ressource, Browser-Typ), um die Seite auszuliefern und vor Angriffen zu
        schützen. Rechtsgrundlage ist unser berechtigtes Interesse am sicheren, stabilen Betrieb
        (Art. 6 Abs. 1 lit. f DSGVO). Cloudflare ist unter geeigneten Garantien (Standardvertragsklauseln)
        tätig. Wir selbst führen keine serverseitigen Zugriffsprotokolle.
      </p>

      <H2>3. Marktdaten &amp; Nachrichten</H2>
      <p>
        Kurse und Charts werden teils <em>direkt aus deinem Browser</em> von Drittanbietern geladen
        (insbesondere Binance für Kryptokurse). Dabei wird deine IP-Adresse technisch bedingt an den jeweiligen
        Anbieter übermittelt. Aktienkurse und Nachrichten laufen über unsere eigene Server-Funktion als Proxy,
        sodass hierbei keine direkte Verbindung zwischen deinem Browser und dem Datenanbieter entsteht. Auf die
        Datenverarbeitung der Drittanbieter haben wir keinen Einfluss; es gelten deren Datenschutzbestimmungen.
      </p>

      <H2>4. Lokale Speicherung (Local Storage)</H2>
      <p>
        Deine Einstellungen sowie deine Watchlist und dein (simuliertes) Portfolio werden ausschliesslich
        <strong className="text-text"> lokal in deinem Browser</strong> gespeichert (Local Storage). Diese Daten
        verlassen dein Gerät nicht und werden nicht an uns übertragen – ausser du abonnierst den Newsletter mit
        Watchlist-/Portfolio-Bezug (siehe Ziffer 5). Es werden keine Tracking- oder Werbe-Cookies gesetzt.
      </p>

      <H2>5. Newsletter (Daily Digest)</H2>
      <p>
        Wenn du den Digest abonnierst, speichern wir deine <strong className="text-text">E-Mail-Adresse</strong>{" "}
        sowie deine gewählten Einstellungen (Kategorien, Quellen). Hast du „Meine Watchlist" oder „Mein
        Portfolio" gewählt, werden zusätzlich die <strong className="text-text">Symbole</strong> (z. B. AAPL,
        BTC) aus deinem Browser übermittelt und gespeichert, damit wir passende Nachrichten filtern können –
        <em> nicht</em> jedoch Stückzahlen, Kaufpreise oder Depotwerte.
      </p>
      <p>
        Die Anmeldung erfolgt im <strong className="text-text">Double-Opt-In-Verfahren</strong>: Du erhältst
        erst eine Bestätigungsmail; ohne Klick auf den Bestätigungslink versenden wir nichts. Rechtsgrundlage
        ist deine Einwilligung (Art. 6 Abs. 1 lit. a DSGVO), die du jederzeit über den Abmeldelink in jeder
        E-Mail oder per Mail an uns widerrufen kannst. Nach Abmeldung wird dein Datensatz gelöscht.
      </p>
      <p>
        <strong className="text-text">Auftragsverarbeiter:</strong> Die Speicherung erfolgt in{" "}
        <em>Cloudflare KV</em> (Cloudflare, Inc.); der Mailversand über <em>Resend</em> (Resend, Inc., USA).
        Beide verarbeiten die Daten ausschliesslich in unserem Auftrag zum Zweck des Newsletter-Versands.
      </p>

      <H2>6. KI-Funktion (Strategie-Generator)</H2>
      <p>
        Der optionale KI-Strategie-Generator ist zugangsbeschränkt. Nutzt du ihn, wird dein eingegebener Text
        über unsere Server-Funktion an einen KI-Anbieter (Google Gemini bzw. Anthropic) übermittelt, um Code zu
        erzeugen. Gib dort keine personenbezogenen oder vertraulichen Daten ein.
      </p>

      <H2>7. Deine Rechte</H2>
      <p>
        Du hast das Recht auf Auskunft, Berichtigung, Löschung und Einschränkung der Bearbeitung deiner Daten
        sowie auf Datenübertragbarkeit und Widerspruch. Wende dich dazu an{" "}
        <a href="mailto:admin@mmmxcix.com" className="text-accent hover:underline">admin@mmmxcix.com</a>. Zudem
        besteht ein Beschwerderecht bei der zuständigen Aufsichtsbehörde (in der Schweiz: EDÖB; in der EU: deine
        nationale Datenschutzbehörde).
      </p>

      <H2>8. Änderungen</H2>
      <p>
        Wir passen diese Erklärung an, wenn sich die Funktionen der Seite ändern. Es gilt jeweils die hier
        veröffentlichte Fassung.
      </p>
    </LegalLayout>
  );
}

import LegalLayout, { H2 } from "@/components/LegalLayout";

// Provider identification. Operator is a private individual in Switzerland;
// the site is internationally reachable, so the notice is framed against the
// strictest realistically relevant standard (§ 5 DDG / § 18 MStV via the
// German-reachable audience) while also satisfying Swiss UWG Art. 3 lit. s.
export default function Impressum() {
  return (
    <LegalLayout title="Impressum" updated="7. Juli 2026">
      <H2>Angaben gemäss § 5 DDG / UWG Art. 3 lit. s</H2>
      <p>
        Gil Buholzer<br />
        Obere Egg 6<br />
        4312 Magden<br />
        Aargau, Schweiz
      </p>
      <p className="text-dim">
        Privates, nicht-kommerzielles Angebot einer natürlichen Person. Es besteht kein
        Handelsregistereintrag und keine Mehrwertsteuer-Nummer.
      </p>

      <H2>Kontakt</H2>
      <p>
        E-Mail: <a href="mailto:admin@mmmxcix.com" className="text-accent hover:underline">admin@mmmxcix.com</a><br />
        Telefon: <a href="tel:+41774321718" className="text-accent hover:underline">+41 77 432 17 18</a>
      </p>

      <H2>Verantwortlich für den Inhalt</H2>
      <p>
        Gil Buholzer<br />
        Obere Egg 6, 4312 Magden, Aargau, Schweiz
      </p>

      <H2>Über dieses Angebot</H2>
      <p>
        MMMXCIX Quant ist ein Werkzeug für Recherche, Backtesting und Marktbeobachtung. Es dient
        ausschliesslich Informations- und Bildungszwecken und stellt <strong className="text-text">keine
        Anlageberatung, Finanzanalyse oder Kauf-/Verkaufsempfehlung</strong> dar. Details siehe{" "}
        <a href="/nutzung" className="text-accent hover:underline">Nutzung &amp; Haftung</a>.
      </p>

      <H2>Haftung für Inhalte und Links</H2>
      <p>
        Für eigene Inhalte auf diesen Seiten sind wir nach den allgemeinen Gesetzen verantwortlich. Für
        verlinkte externe Seiten sind ausschliesslich deren Betreiber verantwortlich; bei Bekanntwerden von
        Rechtsverletzungen entfernen wir solche Links umgehend. Marktdaten und Nachrichten stammen von Dritten
        (u. a. Binance, Yahoo Finance, diverse RSS-Quellen) und werden ohne Gewähr auf Richtigkeit,
        Vollständigkeit oder Aktualität wiedergegeben.
      </p>
    </LegalLayout>
  );
}

import LegalLayout, { H2 } from "@/components/LegalLayout";

// Terms of use + financial disclaimer. The disclaimer is the important part:
// it keeps the tool clearly on the "information/education" side of Swiss FIDLEG
// so it is not mistaken for regulated investment advice.
export default function Nutzung() {
  return (
    <LegalLayout title="Nutzung & Haftung" updated="7. Juli 2026">
      <H2>1. Keine Anlageberatung</H2>
      <p>
        MMMXCIX Quant stellt Werkzeuge zur Marktbeobachtung, zum Backtesting und zur Recherche bereit. Sämtliche
        Inhalte, Kennzahlen, Charts, Backtest-Ergebnisse, Vergleiche, Simulationen und generierten Strategien
        dienen ausschliesslich <strong className="text-text">Informations- und Bildungszwecken</strong>. Sie
        stellen <strong className="text-text">keine Anlageberatung, keine Finanzanalyse und keine
        Empfehlung</strong> zum Kauf, Verkauf oder Halten von Finanzinstrumenten dar und berücksichtigen weder
        deine persönlichen Verhältnisse noch deine Anlageziele oder Risikofähigkeit. Es besteht keine
        Kundenbeziehung im Sinne des Schweizer Finanzdienstleistungsgesetzes (FIDLEG).
      </p>

      <H2>2. Keine Gewähr auf Daten</H2>
      <p>
        Marktdaten und Nachrichten stammen von Drittanbietern und können verzögert, unvollständig oder
        fehlerhaft sein. Wir übernehmen keine Gewähr für Richtigkeit, Vollständigkeit oder Aktualität.
        Historische Kursverläufe und Backtest-Resultate sind <strong className="text-text">keine Garantie für
        zukünftige Entwicklungen</strong>; simulierte Ergebnisse unterliegen nicht den Risiken echten Handels.
      </p>

      <H2>3. Simuliertes Portfolio</H2>
      <p>
        Das Portfolio-Werkzeug ist eine reine Simulation mit fiktiven Positionen. Es findet kein echter Handel
        statt, es wird kein Geld bewegt und es besteht keine Verbindung zu einem Broker oder Depot.
      </p>

      <H2>4. Eigenverantwortung &amp; Risiko</H2>
      <p>
        Anlageentscheidungen triffst du eigenverantwortlich und auf eigenes Risiko. Der Handel mit
        Finanzinstrumenten, insbesondere mit Kryptowährungen, ist mit erheblichen Risiken bis zum Totalverlust
        verbunden. Ziehe bei Bedarf eine qualifizierte, unabhängige Fachperson bei.
      </p>

      <H2>5. Haftungsausschluss</H2>
      <p>
        Soweit gesetzlich zulässig, haften wir nicht für Schäden, die aus der Nutzung oder Nichtverfügbarkeit
        des Angebots, aus fehlerhaften Daten oder aus Entscheidungen entstehen, die auf Grundlage der
        bereitgestellten Inhalte getroffen wurden. Das Angebot wird „wie besehen" und ohne Zusicherung
        ununterbrochener Verfügbarkeit bereitgestellt.
      </p>

      <H2>6. Nutzung der KI-Funktion</H2>
      <p>
        Von der KI generierter Code wird ohne Gewähr bereitgestellt und kann Fehler enthalten. Prüfe erzeugten
        Code vor jeder Verwendung selbst. Eine missbräuchliche Nutzung der Funktion ist untersagt.
      </p>

      <H2>7. Anwendbares Recht</H2>
      <p>
        Es gilt Schweizer Recht. Gerichtsstand ist – soweit gesetzlich zulässig – der Wohnsitz des Betreibers.
      </p>
    </LegalLayout>
  );
}

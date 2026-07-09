import LegalLayout, { H2 } from "@/components/LegalLayout";

// Provider identification. Operator is a private individual in Switzerland;
// the site is internationally reachable, so the notice is framed against the
// strictest realistically relevant standard (§ 5 DDG / § 18 MStV via the
// German-reachable audience) while also satisfying Swiss UWG Art. 3 lit. s.
export default function Impressum() {
  return (
    <LegalLayout title="Legal Notice" updated="July 7, 2026">
      <H2>Information pursuant to § 5 DDG / UWG Art. 3 lit. s</H2>
      <p>
        Gil Buholzer<br />
        Obere Egg 6<br />
        4312 Magden<br />
        Aargau, Switzerland
      </p>
      <p className="text-dim">
        Private, non-commercial offering by a natural person. There is no commercial register entry and
        no VAT identification number.
      </p>

      <H2>Contact</H2>
      <p>
        Email: <a href="mailto:admin@mmmxcix.com" className="text-accent hover:underline">admin@mmmxcix.com</a><br />
        Phone: <a href="tel:+41774321718" className="text-accent hover:underline">+41 77 432 17 18</a>
      </p>

      <H2>Responsible for content</H2>
      <p>
        Gil Buholzer<br />
        Obere Egg 6, 4312 Magden, Aargau, Switzerland
      </p>

      <H2>About this offering</H2>
      <p>
        MMMXCIX Quant is a tool for research, backtesting and market monitoring. It serves informational and
        educational purposes only and does <strong className="text-text">not constitute investment advice,
        financial analysis, or a buy/sell recommendation</strong>. See{" "}
        <a href="/nutzung" className="text-accent hover:underline">Terms &amp; Liability</a> for details.
      </p>

      <H2>Liability for content and links</H2>
      <p>
        We are responsible for our own content on these pages under general law. The operators of linked
        external sites are solely responsible for their content; we will remove such links promptly upon
        becoming aware of any legal violations. Market data and news come from third parties (including
        Binance, Yahoo Finance, and various RSS sources) and are provided without warranty as to accuracy,
        completeness, or timeliness.
      </p>
    </LegalLayout>
  );
}

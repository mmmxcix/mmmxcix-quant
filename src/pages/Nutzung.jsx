import LegalLayout, { H2 } from "@/components/LegalLayout";

// Terms of Use (AGB) + financial disclaimer. Two jobs: (1) the disclaimer keeps the
// tool clearly on the "information/education" side of Swiss FinSA/FIDLEG so it is not
// mistaken for regulated investment advice; (2) the contract clauses govern the free
// accounts (Better Auth) and the newsletter. Not legal advice — have a lawyer review
// before a commercial launch.
export default function Nutzung() {
  return (
    <LegalLayout title="Terms & Liability" updated="August 8, 2026">
      <p className="rounded-lg border border-line bg-accent/5 px-4 py-3 text-dim">
        Plain-language summary: this is a free, browser-based research and backtesting tool. It is
        <strong className="text-text"> not investment advice</strong>, all trading is
        <strong className="text-text"> simulated (paper only)</strong>, and results are hypothetical.
        Use it at your own risk. The full terms below govern accounts and the newsletter.
      </p>

      <H2>1. Agreement</H2>
      <p>
        These Terms govern your use of <strong className="text-text">quant.mmmxcix.com</strong> (the "Service").
        By using the Service, creating an account, or subscribing to the newsletter, you agree to these Terms
        and to the <a href="/datenschutz" className="text-accent hover:underline">Privacy Policy</a>. If you do
        not agree, please do not use the Service.
      </p>

      <H2>2. Eligibility</H2>
      <p>
        You must be at least 18 years old, or the age of majority in your jurisdiction, and have the legal
        capacity to enter into these Terms. If you use the Service on behalf of an organisation, you confirm you
        are authorised to bind it.
      </p>

      <H2>3. The service</H2>
      <p>
        The Service provides tools for market monitoring, backtesting, machine-learning research and educational
        simulation. It is offered <strong className="text-text">free of charge and on a best-effort basis</strong>,
        currently in beta. There is no guarantee of availability, and we may add, change, suspend, or discontinue
        features at any time. Paid plans, if introduced, will be governed by additional terms shown at purchase.
      </p>

      <H2>4. Accounts</H2>
      <p>
        Some features require an account. You are responsible for the accuracy of your details, for keeping your
        password confidential, and for all activity under your account. Tell us promptly of any unauthorised use.
        We may suspend or close accounts that breach these Terms or are used abusively. You can delete your
        account at any time (see the <a href="/datenschutz" className="text-accent hover:underline">Privacy Policy</a>).
      </p>

      <H2>5. Acceptable use</H2>
      <p>
        You agree not to: use the Service unlawfully or for market manipulation; scrape, overload, or abuse the
        free data and AI endpoints, or attempt to circumvent access controls, rate limits, or security; probe or
        attack the infrastructure without authorisation; reverse-engineer, resell, or redistribute the Service;
        or use it in a way that infringes the rights of others.
      </p>

      <H2>6. Not investment advice</H2>
      <p>
        All content, metrics, charts, backtest results, comparisons, simulations and generated strategies serve
        <strong className="text-text"> informational and educational purposes only</strong>. They do
        <strong className="text-text"> not constitute investment advice, financial analysis, tax advice, or a
        recommendation</strong> to buy, sell, or hold any financial instrument, and take into account neither your
        personal circumstances nor your objectives or risk capacity. No client relationship within the meaning of
        the Swiss Financial Services Act (FinSA/FIDLEG) or any comparable regime is established.
      </p>

      <H2>7. No warranty on data</H2>
      <p>
        Market data and news come from third parties and may be delayed, incomplete, or inaccurate. We give no
        warranty as to accuracy, completeness, or timeliness. Historical price movements and backtest results are
        <strong className="text-text"> no guarantee of future performance</strong>; simulated results are not
        subject to the risks, costs, and liquidity of real trading.
      </p>

      <H2>8. Simulated trading only</H2>
      <p>
        The portfolio and the autonomous "Argus" agent are <strong className="text-text">pure simulations using
        fictitious positions and virtual money</strong>. No real trading takes place, no money is moved, and
        there is no connection to any broker or brokerage account. Any equity, P&amp;L, or track record shown is
        hypothetical.
      </p>

      <H2>9. AI features</H2>
      <p>
        Optional AI features generate strategy code and written analysis using third-party models (currently
        Anthropic Claude, Mistral, Groq/Llama and Google Gemini). AI output is
        <strong className="text-text"> probabilistic and may be wrong, incomplete, or misleading</strong>; you
        must review and validate it before relying on it. The model providers' own terms also apply to that use.
        Do not enter personal or confidential data into AI features.
      </p>

      <H2>10. Intellectual property</H2>
      <p>
        The Service, its design, brand, and source presentation are protected and remain ours or our licensors'.
        We grant you a limited, revocable, non-exclusive right to use the Service for your own,
        non-commercial research. Strategies you write or generate are yours to use, but note that AI-generated
        output may not qualify for copyright and may resemble other material; you are responsible for how you use
        it.
      </p>

      <H2>11. Your responsibility &amp; risk</H2>
      <p>
        You make all investment decisions on your own responsibility and at your own risk. Trading financial
        instruments, and cryptocurrencies in particular, carries substantial risk up to total loss. Consult a
        qualified, independent professional where appropriate.
      </p>

      <H2>12. Disclaimer of warranties</H2>
      <p>
        The Service is provided <strong className="text-text">"as is" and "as available", without warranties of
        any kind</strong>, express or implied, including fitness for a particular purpose and non-infringement, to
        the fullest extent permitted by law.
      </p>

      <H2>13. Limitation of liability</H2>
      <p>
        To the extent permitted by law, we are not liable for any damages arising from the use or unavailability
        of the Service, from faulty or delayed data, or from decisions made on the basis of the content provided,
        including lost profits or trading losses. Some jurisdictions do not allow certain limitations, so parts of
        this section may not apply to you; nothing here limits liability that cannot be limited by law (including
        mandatory consumer-protection rights).
      </p>

      <H2>14. Termination</H2>
      <p>
        You may stop using the Service and delete your account at any time. We may suspend or terminate access if
        you breach these Terms or to protect the Service. Sections that by their nature should survive
        (disclaimers, liability, intellectual property, governing law) continue to apply after termination.
      </p>

      <H2>15. Changes to these terms</H2>
      <p>
        We may update these Terms as the Service evolves. Material changes will be reflected in the "last updated"
        date above. Your continued use after changes are posted constitutes acceptance of the updated Terms.
      </p>

      <H2>16. Governing law &amp; jurisdiction</H2>
      <p>
        Swiss law applies, excluding its conflict-of-law rules and the CISG. The place of jurisdiction is — to
        the extent permitted by law — the operator's place of residence in Switzerland. Mandatory consumer
        protections of your country of residence remain unaffected.
      </p>

      <H2>17. Contact</H2>
      <p>
        Questions, or copyright/abuse notices:{" "}
        <a href="mailto:admin@mmmxcix.com" className="text-accent hover:underline">admin@mmmxcix.com</a>. See the{" "}
        <a href="/impressum" className="text-accent hover:underline">Legal Notice</a> for operator details.
      </p>
    </LegalLayout>
  );
}

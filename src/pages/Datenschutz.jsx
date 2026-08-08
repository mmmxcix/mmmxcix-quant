import LegalLayout, { H2 } from "@/components/LegalLayout";

// Privacy policy. Framed against the Swiss revDSG and, because the site is
// reachable from the EU, the GDPR. Covers: hosting (Cloudflare), the newsletter
// (email in Cloudflare KV + Resend as processor + symbol data), local storage,
// and third-party market-data/news fetches from the visitor's browser.
export default function Datenschutz() {
  return (
    <LegalLayout title="Privacy Policy" updated="August 8, 2026">
      <p>
        Protecting your data matters to us. This policy explains, in accordance with the revised Swiss Data
        Protection Act (revDSG) and — where applicable — the EU General Data Protection Regulation (GDPR),
        which data we process when you use <strong className="text-text">quant.mmmxcix.com</strong>.
      </p>

      <H2>1. Controller</H2>
      <p>
        Gil Buholzer, Obere Egg 6, 4312 Magden, Switzerland<br />
        Email: <a href="mailto:admin@mmmxcix.com" className="text-accent hover:underline">admin@mmmxcix.com</a>
      </p>

      <H2>2. Hosting &amp; server logs</H2>
      <p>
        The site is hosted via <strong className="text-text">Cloudflare Pages</strong> (Cloudflare, Inc., USA).
        When you load the site, Cloudflare processes technically necessary connection data (including IP
        address, timestamp, requested resource, browser type) to deliver the site and protect it against
        attacks. The legal basis is our legitimate interest in secure, stable operation (Art. 6(1)(f) GDPR).
        Cloudflare operates under appropriate safeguards (Standard Contractual Clauses). We ourselves keep no
        server-side access logs.
      </p>

      <H2>3. Market data &amp; news</H2>
      <p>
        Prices and charts are partly loaded <em>directly from your browser</em> from third parties (in
        particular Binance for crypto prices). For technical reasons your IP address is transmitted to the
        respective provider in the process. Stock prices and news run through our own server function acting as
        a proxy, so no direct connection is made between your browser and the data provider. We have no
        influence over how these third parties process data; their privacy terms apply.
      </p>

      <H2>4. Local storage</H2>
      <p>
        Your settings as well as your watchlist and your (simulated) portfolio are stored
        <strong className="text-text"> only locally in your browser</strong> (local storage). This data does
        not leave your device and is not transmitted to us — unless you subscribe to the newsletter with a
        watchlist/portfolio focus (see section 5). No tracking or advertising cookies are set.
      </p>

      <H2>5. Newsletter (Daily Digest)</H2>
      <p>
        If you subscribe to the digest, we store your <strong className="text-text">email address</strong> and
        your chosen preferences (categories, sources). If you selected "My watchlist" or "My portfolio", the
        <strong className="text-text"> symbols</strong> (e.g. AAPL, BTC) from your browser are additionally
        transmitted and stored so we can filter relevant news — but <em>not</em> quantities, buy prices, or
        portfolio values.
      </p>
      <p>
        Sign-up uses a <strong className="text-text">double opt-in</strong> process: you first receive a
        confirmation email; without clicking the confirmation link we send nothing. The legal basis is your
        consent (Art. 6(1)(a) GDPR), which you can withdraw at any time via the unsubscribe link in every
        email or by contacting us. After unsubscribing, your record is deleted.
      </p>
      <p>
        <strong className="text-text">Processors:</strong> Storage uses <em>Cloudflare KV</em> (Cloudflare,
        Inc.); email delivery uses <em>Resend</em> (Resend, Inc., USA). Both process the data solely on our
        behalf for the purpose of sending the newsletter.
      </p>

      <H2>6. User accounts</H2>
      <p>
        If you create an account, we process your <strong className="text-text">email address</strong>, an
        optional display name, and your password — which is <strong className="text-text">stored only as a
        salted hash</strong> (scrypt), never in plain text. We also store your login session (a strictly
        necessary, HttpOnly cookie), an optional two-factor secret and backup codes if you enable 2FA, and your
        theme preference. This data is held in <em>Cloudflare D1</em> (a database on Cloudflare's infrastructure)
        and is processed to provide and secure the account — the legal basis is performance of a contract
        (Art. 6(1)(b) GDPR) and the corresponding revDSG provisions. We keep it until you delete your account,
        after which it is removed. The session cookie is essential for login and is not used for tracking or
        advertising.
      </p>

      <H2>7. AI features</H2>
      <p>
        The optional AI features are access-restricted. If you use them, the text you enter is sent through our
        server function to a third-party AI provider (currently Anthropic, Mistral, Groq, or Google Gemini) to
        generate code or analysis. Prompts are not used by us to train models; the providers process them under
        their own terms. Please do not enter any personal or confidential data there.
      </p>

      <H2>8. Your rights</H2>
      <p>
        You have the right to access, rectify, erase, and restrict the processing of your data, as well as the
        rights to data portability and objection. To exercise them, contact{" "}
        <a href="mailto:admin@mmmxcix.com" className="text-accent hover:underline">admin@mmmxcix.com</a>. You
        also have the right to lodge a complaint with the competent supervisory authority (in Switzerland: the
        FDPIC; in the EU: your national data protection authority).
      </p>

      <H2>9. Changes</H2>
      <p>
        We update this policy when the site's features change. The version published here applies at any given
        time.
      </p>
    </LegalLayout>
  );
}

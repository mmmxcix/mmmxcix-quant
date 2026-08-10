import LegalLayout, { H2 } from "@/components/LegalLayout";

// Accessibility statement. Written to the structure the European Accessibility
// Act / EN 301 549 expects: which standard is targeted, what the CURRENT state
// actually is, the known gaps by name, how to report a barrier, and how the
// assessment was made.
//
// Deliberately NOT a blanket "this site is accessible" claim. A statement is a
// declaration you can be held to — claiming conformance you do not have is
// worse than claiming none, and it is the part most generated statements get
// wrong. Everything below is backed by `node scripts/a11y.mjs`, which is run
// against the real build.
export default function Barrierefreiheit() {
  return (
    <LegalLayout title="Accessibility" updated="August 10, 2026">
      <p>
        This statement describes how accessible MMMXCIX Quant (quant.mmmxcix.com) currently is,
        where it falls short, and how to tell me about a barrier you hit. It is written for the
        European Accessibility Act and EN 301 549; the target standard is
        <strong className="text-text"> WCAG 2.2, level AA</strong>.
      </p>

      <H2>Current status: partially conformant</H2>
      <p>
        Partially conformant means most of the site meets the standard, but some parts do not
        (listed below). I would rather name the gaps than claim a conformance I cannot prove.
      </p>
      <p>What is in place today:</p>
      <ul className="list-disc list-inside space-y-1">
        <li>Every page can be operated by keyboard alone, with a visible focus ring.</li>
        <li>A “Skip to main content” link is the first tab stop on every page.</li>
        <li>Semantic landmarks (<code>main</code>, <code>nav</code>, <code>header</code>, <code>footer</code>) and a page language.</li>
        <li>Icon-only buttons and form controls carry accessible names for screen readers.</li>
        <li>Text meets the AA contrast ratios in both the light and the dark theme.</li>
        <li>Animation, including the animated background, is disabled when your system asks for reduced motion.</li>
        <li>The layout reflows to a phone screen and stays usable at 200% zoom.</li>
      </ul>

      <H2>Known limitations</H2>
      <p>
        These are real and I am not going to paper over them:
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          <strong className="text-text">Charts and the world map</strong> are drawn to a canvas. A screen
          reader cannot read the candles, drawings or map markers. The underlying numbers are available
          as text elsewhere (quotes, backtest metrics, tables), but the charts themselves are visual.
        </li>
        <li>
          <strong className="text-text">The strategy code editor</strong> is a plain text area. It is
          reachable and labelled, but it offers none of the affordances of a real accessible code editor.
        </li>
        <li>
          <strong className="text-text">A few controls are smaller than the 24 × 24 px target size</strong>
          {" "}WCAG 2.2 asks for — mostly checkboxes and dense toolbar rows on the chart and backtest pages.
        </li>
        <li>
          <strong className="text-text">Dense data tables</strong> (screener, correlation matrix, option
          chains) are hard to follow with a screen reader even where the markup is correct.
        </li>
        <li>
          Third-party content (embedded charting library, Pyodide) is not fully under my control.
        </li>
      </ul>

      <H2>Feedback — and what happens with it</H2>
      <p>
        If something here blocks you, please write to{" "}
        <a href="mailto:admin@mmmxcix.com" className="text-accent hover:underline">admin@mmmxcix.com</a>.
        Tell me the page and what you were trying to do; if you use assistive technology, naming it helps.
        I read every message myself and aim to reply within a few working days. If a barrier can be fixed,
        I will fix it and say so here.
      </p>

      <H2>How this was assessed</H2>
      <p>
        Self-assessment, not an external audit. The site is checked with an automated pass
        (<code>scripts/a11y.mjs</code> in the source: page language, image alternatives, accessible names,
        form labels, landmarks, skip link, heading order and target sizes across the main routes) plus
        manual keyboard testing. Automated checks catch a minority of accessibility problems, so the
        absence of findings is not proof of conformance — which is exactly why the limitations above are
        listed by name.
      </p>
      <p className="text-dim">
        Last reviewed: August 10, 2026. This statement is updated whenever the assessment is repeated.
      </p>

      <H2>Legal context</H2>
      <p>
        The operator is a private individual in Switzerland. Swiss law currently imposes no general
        accessibility obligation on private websites; the European Accessibility Act has applied to
        services offered on the EU market since 28 June 2025 and is written to be market-based rather
        than seat-based. This statement is published because the standard is worth meeting, not because
        a specific authority demanded it — and it is a description of the real state of the site, not a
        liability shield.
      </p>
    </LegalLayout>
  );
}

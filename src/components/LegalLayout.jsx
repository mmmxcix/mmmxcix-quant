import { Link } from "react-router-dom";

// Standalone shell for the public legal pages. Uses the quant design tokens.
export default function LegalLayout({ title, updated, children }) {
  return (
    <div className="min-h-screen">
      <div className="ambient-bg" aria-hidden="true" />
      <header className="border-b border-line">
        <div className="max-w-3xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link to="/" className="text-sm font-bold tracking-[0.25em] uppercase text-text hover:text-accent transition-colors">
            MMMXCIX <span className="text-dim">Quant</span>
          </Link>
          <Link to="/" className="text-xs font-medium text-dim hover:text-text transition-colors">
            To the app →
          </Link>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-12">
        <h1 className="text-3xl font-bold mb-1 text-text">{title}</h1>
        {updated && <p className="text-xs text-dim mb-8">Stand: {updated}</p>}
        <div className="space-y-5 text-sm leading-relaxed text-dim">{children}</div>
      </main>

      <footer className="border-t border-line mt-16">
        <div className="max-w-3xl mx-auto px-6 py-6 flex flex-wrap items-center gap-4 text-xs text-dim">
          <Link to="/impressum" className="hover:text-text transition-colors">Legal Notice</Link>
          <Link to="/datenschutz" className="hover:text-text transition-colors">Privacy</Link>
          <Link to="/nutzung" className="hover:text-text transition-colors">Terms</Link>
          <span className="ml-auto">© {new Date().getFullYear()} MMMXCIX</span>
        </div>
      </footer>
    </div>
  );
}

export function H2({ children }) {
  return <h2 className="text-base font-semibold text-text pt-4">{children}</h2>;
}

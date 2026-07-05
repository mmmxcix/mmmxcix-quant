import { Building2, Database, LineChart, GraduationCap, Users, ExternalLink } from 'lucide-react';

const SECTIONS = [
  {
    title: 'Broker & Ausführung',
    icon: Building2,
    links: [
      {
        name: 'Interactive Brokers',
        href: 'https://www.interactivebrokers.com/',
        desc: 'Profi-Broker mit globalem Marktzugang und mächtiger API.',
      },
      {
        name: 'Alpaca',
        href: 'https://alpaca.markets/',
        desc: 'Kommissionsfreier API-First-Broker für Aktien & Krypto, ideal fürs Algo-Trading.',
      },
    ],
  },
  {
    title: 'Daten',
    icon: Database,
    links: [
      {
        name: 'Yahoo Finance',
        href: 'https://finance.yahoo.com/',
        desc: 'Kostenlose Kurse, Fundamentaldaten und historische Daten.',
      },
      {
        name: 'Stooq',
        href: 'https://stooq.com/',
        desc: 'Kostenlose historische EOD-Daten als CSV-Download.',
      },
      {
        name: 'Binance API Docs',
        href: 'https://developers.binance.com/docs/binance-spot-api-docs',
        desc: 'Offizielle Dokumentation der Binance Spot-API für Krypto-Daten und -Handel.',
      },
      {
        name: 'FRED (Makrodaten)',
        href: 'https://fred.stlouisfed.org/',
        desc: 'Makroökonomische Zeitreihen der Federal Reserve — Zinsen, Inflation, BIP.',
      },
      {
        name: 'Polygon.io',
        href: 'https://polygon.io/',
        desc: 'Professionelle Markt-APIs für Aktien, Optionen, Forex und Krypto.',
      },
    ],
  },
  {
    title: 'Charts & Screening',
    icon: LineChart,
    links: [
      {
        name: 'TradingView',
        href: 'https://www.tradingview.com/',
        desc: 'Charting-Standard mit Pine Script, Screenern und Community-Ideen.',
      },
      {
        name: 'Finviz',
        href: 'https://finviz.com/',
        desc: 'Schneller Aktien-Screener mit Heatmaps und Insider-Daten.',
      },
      {
        name: 'Portfolio Visualizer',
        href: 'https://www.portfoliovisualizer.com/',
        desc: 'Backtesting, Faktoranalyse und Portfolio-Optimierung im Browser.',
      },
    ],
  },
  {
    title: 'Lernen & Research',
    icon: GraduationCap,
    links: [
      {
        name: 'QuantStart',
        href: 'https://www.quantstart.com/',
        desc: 'Tutorials und Artikel zu quantitativem Trading und Backtesting.',
      },
      {
        name: 'Quantpedia',
        href: 'https://quantpedia.com/',
        desc: 'Enzyklopädie akademisch belegter Handelsstrategien.',
      },
      {
        name: 'SSRN (q-fin)',
        href: 'https://www.ssrn.com/index.cfm/en/fen/',
        desc: 'Preprints und Working Papers aus der Finanzforschung.',
      },
      {
        name: 'arXiv q-fin',
        href: 'https://arxiv.org/archive/q-fin',
        desc: 'Open-Access-Paper zu Quantitative Finance.',
      },
      {
        name: 'Investopedia',
        href: 'https://www.investopedia.com/',
        desc: 'Nachschlagewerk für Finanzbegriffe und Grundlagen.',
      },
      {
        name: 'Advances in Financial Machine Learning',
        href: 'https://books.google.com/books?id=oU9KDwAAQBAJ',
        desc: 'Standardwerk von Marcos López de Prado zu ML im Quant-Trading.',
      },
    ],
  },
  {
    title: 'Community',
    icon: Users,
    links: [
      {
        name: 'r/algotrading',
        href: 'https://www.reddit.com/r/algotrading/',
        desc: 'Reddit-Community rund um algorithmisches Trading.',
      },
      {
        name: 'QuantConnect Forum',
        href: 'https://www.quantconnect.com/forum/',
        desc: 'Diskussionen zu Strategien und der LEAN-Engine.',
      },
      {
        name: 'Elite Trader',
        href: 'https://www.elitetrader.com/et/',
        desc: 'Traditionsreiches Forum für professionelle Trader.',
      },
    ],
  },
];

export default function Resources() {
  return (
    <div className="space-y-8">
      <div>
        <div className="text-xs uppercase tracking-widest text-dim">Werkzeugkasten</div>
        <h1 className="text-2xl font-semibold text-text mt-1">Ressourcen</h1>
        <p className="text-sm text-dim mt-2">
          Kuratierte Links — alles, was ein Quant Trader braucht.
        </p>
      </div>

      {SECTIONS.map((section) => {
        const Icon = section.icon;
        return (
          <section key={section.title} className="space-y-3">
            <div className="flex items-center gap-2">
              <Icon size={16} className="text-accent" />
              <h2 className="text-sm font-semibold uppercase tracking-widest text-dim">
                {section.title}
              </h2>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {section.links.map((link) => (
                <a
                  key={link.name}
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group rounded-xl border border-line lg-glass p-4 hover:border-accent/40 transition-colors"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-text group-hover:text-accent transition-colors">
                      {link.name}
                    </span>
                    <ExternalLink
                      size={14}
                      className="shrink-0 text-dim group-hover:text-accent transition-colors"
                    />
                  </div>
                  <p className="mt-1.5 text-sm text-dim leading-relaxed">{link.desc}</p>
                </a>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

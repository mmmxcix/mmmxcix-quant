import { Building2, Database, LineChart, GraduationCap, Users, ExternalLink } from 'lucide-react';

const SECTIONS = [
  {
    title: 'Brokers & Execution',
    icon: Building2,
    links: [
      {
        name: 'Interactive Brokers',
        href: 'https://www.interactivebrokers.com/',
        desc: 'Professional broker with global market access and a powerful API.',
      },
      {
        name: 'Alpaca',
        href: 'https://alpaca.markets/',
        desc: 'Commission-free, API-first broker for stocks & crypto, ideal for algo trading.',
      },
    ],
  },
  {
    title: 'Data',
    icon: Database,
    links: [
      {
        name: 'Yahoo Finance',
        href: 'https://finance.yahoo.com/',
        desc: 'Free quotes, fundamentals, and historical data.',
      },
      {
        name: 'Stooq',
        href: 'https://stooq.com/',
        desc: 'Free historical EOD data as a CSV download.',
      },
      {
        name: 'Binance API Docs',
        href: 'https://developers.binance.com/docs/binance-spot-api-docs',
        desc: 'Official Binance Spot API documentation for crypto data and trading.',
      },
      {
        name: 'FRED (macro data)',
        href: 'https://fred.stlouisfed.org/',
        desc: 'Macroeconomic time series from the Federal Reserve — rates, inflation, GDP.',
      },
      {
        name: 'Polygon.io',
        href: 'https://polygon.io/',
        desc: 'Professional market APIs for stocks, options, forex, and crypto.',
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
        desc: 'The charting standard with Pine Script, screeners, and community ideas.',
      },
      {
        name: 'Finviz',
        href: 'https://finviz.com/',
        desc: 'Fast stock screener with heatmaps and insider data.',
      },
      {
        name: 'Portfolio Visualizer',
        href: 'https://www.portfoliovisualizer.com/',
        desc: 'Backtesting, factor analysis, and portfolio optimization in the browser.',
      },
    ],
  },
  {
    title: 'Learning & Research',
    icon: GraduationCap,
    links: [
      {
        name: 'QuantStart',
        href: 'https://www.quantstart.com/',
        desc: 'Tutorials and articles on quantitative trading and backtesting.',
      },
      {
        name: 'Quantpedia',
        href: 'https://quantpedia.com/',
        desc: 'Encyclopedia of academically documented trading strategies.',
      },
      {
        name: 'SSRN (q-fin)',
        href: 'https://www.ssrn.com/index.cfm/en/fen/',
        desc: 'Preprints and working papers from finance research.',
      },
      {
        name: 'arXiv q-fin',
        href: 'https://arxiv.org/archive/q-fin',
        desc: 'Open-access papers on quantitative finance.',
      },
      {
        name: 'Investopedia',
        href: 'https://www.investopedia.com/',
        desc: 'Reference for financial terms and fundamentals.',
      },
      {
        name: 'Advances in Financial Machine Learning',
        href: 'https://books.google.com/books?id=oU9KDwAAQBAJ',
        desc: 'The standard reference by Marcos López de Prado on ML in quant trading.',
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
        desc: 'Reddit community focused on algorithmic trading.',
      },
      {
        name: 'QuantConnect Forum',
        href: 'https://www.quantconnect.com/forum/',
        desc: 'Discussions on strategies and the LEAN engine.',
      },
      {
        name: 'Elite Trader',
        href: 'https://www.elitetrader.com/et/',
        desc: 'Long-standing forum for professional traders.',
      },
    ],
  },
];

export default function Resources() {
  return (
    <div className="space-y-8">
      <div>
        <div className="text-xs font-medium text-dim">Toolbox</div>
        <h1 className="text-2xl font-semibold text-text mt-1">Resources</h1>
        <p className="text-sm text-dim mt-2">
          Curated links — everything a quant trader needs.
        </p>
      </div>

      {SECTIONS.map((section) => {
        const Icon = section.icon;
        return (
          <section key={section.title} className="space-y-3">
            <div className="flex items-center gap-2">
              <Icon size={16} className="text-accent" />
              <h2 className="text-sm font-semibold font-medium text-dim">
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

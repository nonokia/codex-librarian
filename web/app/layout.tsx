import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Codex Librarian',
  description: 'コードベースを図書館にする — graph-first code knowledge (Phase 3)',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <header className="masthead">
          <div className="masthead-inner">
            <h1>
              Codex <em>Librarian</em>
            </h1>
            <nav>
              <Link href="/">蔵書目録</Link>
              <Link href="/graph">書架を歩く</Link>
              <Link href="/ask">司書に聞く</Link>
            </nav>
            <span className="dbnote">LIBRARIAN_DB → knowledge store</span>
          </div>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}

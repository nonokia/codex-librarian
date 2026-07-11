import EvalChart from '@/components/EvalChart';
import { openLibrarian } from '@/lib/librarian';

export const dynamic = 'force-dynamic';

export default function Dashboard() {
  let data;
  try {
    data = openLibrarian();
  } catch (err) {
    return (
      <div className="card" style={{ marginTop: 24 }}>
        <h2 style={{ marginTop: 0 }}>インデックスが見つかりません</h2>
        <p className="muted">{(err as Error).message}</p>
        <pre className="source">{`# 使い方
node bin/librarian.js index <repo> --db idx.db   # リポジトリ側で
LIBRARIAN_DB=/path/to/idx.db npm run dev          # web/ で`}</pre>
      </div>
    );
  }
  const { store, dbPath, root } = data;
  const stats = store.stats();
  const history = store.evalHistory() as {
    id: number; micro_recall: number; macro_recall: number; perfect: number;
    cases: number; used_cache: number; note: string | null;
  }[];
  const patterns = store.listPatterns() as {
    signature: string; source: string; score: number; baseline: number; uses: number;
  }[];
  const retrievals = store.listRetrievals(8) as {
    id: number; ts: number; source: string; signature: string; from_cache: number;
    item_count: number; used_chars: number; grounded_findings: number | null;
    total_findings: number | null; feedback: number | null;
  }[];

  return (
    <>
      <h2 style={{ marginTop: 18 }}>
        蔵書目録 <span className="sub">{root}</span>
      </h2>
      <div className="tiles">
        <div className="tile"><div className="label">files</div><div className="value">{stats.files}</div></div>
        <div className="tile"><div className="label">symbols</div><div className="value">{stats.symbols}</div></div>
        <div className="tile"><div className="label">edges(解決済み)</div><div className="value">{stats.edges - stats.unresolvedEdges}</div><div className="hint">unresolved {stats.unresolvedEdges} は隔離済み</div></div>
        <div className="tile"><div className="label">学習済みパターン</div><div className="value">{patterns.length}</div><div className="hint">PatternCache(§4-⑤)</div></div>
      </div>

      <h2>
        retrieval match 率の推移 <span className="sub">micro recall / ADR-4 — ホバーで詳細</span>
      </h2>
      <div className="card">
        <EvalChart rows={history} />
        {history.length > 0 && (
          <table className="ledger" style={{ marginTop: 10 }}>
            <thead><tr><th>run</th><th>micro</th><th>macro</th><th>perfect</th><th>cache</th><th>note</th></tr></thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <td>{h.id}</td>
                  <td>{(h.micro_recall * 100).toFixed(1)}%</td>
                  <td>{(h.macro_recall * 100).toFixed(1)}%</td>
                  <td>{h.perfect}/{h.cases}</td>
                  <td>{h.used_cache ? '✓' : ''}</td>
                  <td className="muted">{h.note ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2>PatternCache <span className="sub">diff シグネチャ → 学習済み戦略</span></h2>
      <div className="card">
        {patterns.length === 0 ? (
          <p className="muted">まだ空です。`librarian learn` が勝った戦略だけを昇格させます。</p>
        ) : (
          <table className="ledger">
            <thead><tr><th>signature</th><th>score</th><th>baseline</th><th>uses</th><th>source</th></tr></thead>
            <tbody>
              {patterns.map((p) => (
                <tr key={p.signature}>
                  <td className="mono">{p.signature}</td>
                  <td>{(p.score * 100).toFixed(0)}%</td>
                  <td className="muted">{(p.baseline * 100).toFixed(0)}%</td>
                  <td>{p.uses}</td>
                  <td><span className="pill">{p.source}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2>最近のリトリーバル <span className="sub">retrieval_log — フィードバック信号の蓄積</span></h2>
      <div className="card">
        {retrievals.length === 0 ? (
          <p className="muted">まだ記録がありません。`librarian pack` / `review` が実行されるたびに溜まります。</p>
        ) : (
          <table className="ledger">
            <thead><tr><th>id</th><th>source</th><th>signature</th><th>items</th><th>chars</th><th>grounded</th><th>👍/👎</th></tr></thead>
            <tbody>
              {retrievals.map((r) => (
                <tr key={r.id}>
                  <td>{r.id}</td>
                  <td>{r.source}{r.from_cache ? <span className="pill" style={{ marginLeft: 6 }}>cached</span> : null}</td>
                  <td className="mono">{r.signature}</td>
                  <td>{r.item_count}</td>
                  <td>{r.used_chars}</td>
                  <td>{r.total_findings !== null ? `${r.grounded_findings}/${r.total_findings}` : <span className="muted">—</span>}</td>
                  <td>{r.feedback === 1 ? '👍' : r.feedback === -1 ? '👎' : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
          db: <span className="mono">{dbPath}</span>
        </p>
      </div>
    </>
  );
}

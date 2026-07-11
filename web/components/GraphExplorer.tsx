'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

interface Sym {
  id: string;
  kind: string;
  name: string;
  file: string;
  container: string | null;
  spanStart: number;
  spanEnd: number;
}
interface GraphData {
  seed: string;
  nodes: (Sym & { depth?: number })[];
  links: { source: string; target: string; kind: string }[];
}

const KIND_COLOR: Record<string, string> = {
  // categorical slots in fixed order (validated palette); identity also
  // carried by the label text, so color is never the only channel
  function: 'var(--accent)',
  module: 'var(--shelf)',
  testblock: 'var(--accent-2)',
  variable: '#9576d9',
  class: '#e5657a',
  method: '#e5657a',
};

/** tiny deterministic force layout: depth rings + repulsion + springs */
function layout(data: GraphData, W: number, H: number): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  const cx = W / 2;
  const cy = H / 2;
  data.nodes.forEach((n, i) => {
    if (n.id === data.seed) {
      pos.set(n.id, { x: cx, y: cy });
      return;
    }
    const ring = (n.depth ?? 1) * 130;
    const angle = (i / Math.max(1, data.nodes.length - 1)) * Math.PI * 2;
    pos.set(n.id, { x: cx + ring * Math.cos(angle), y: cy + ring * Math.sin(angle) });
  });
  const ids = data.nodes.map((n) => n.id);
  for (let iter = 0; iter < 200; iter++) {
    // repulsion
    for (let a = 0; a < ids.length; a++) {
      for (let b = a + 1; b < ids.length; b++) {
        const pa = pos.get(ids[a])!;
        const pb = pos.get(ids[b])!;
        let dx = pa.x - pb.x;
        let dy = pa.y - pb.y;
        const d2 = Math.max(100, dx * dx + dy * dy);
        const f = 2600 / d2;
        const d = Math.sqrt(d2);
        dx /= d; dy /= d;
        pa.x += dx * f; pa.y += dy * f;
        pb.x -= dx * f; pb.y -= dy * f;
      }
    }
    // springs
    for (const l of data.links) {
      const pa = pos.get(l.source);
      const pb = pos.get(l.target);
      if (!pa || !pb) continue;
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const f = (d - 110) * 0.02;
      pa.x += (dx / d) * f; pa.y += (dy / d) * f;
      pb.x -= (dx / d) * f; pb.y -= (dy / d) * f;
    }
    // keep the seed centered, everything on canvas
    pos.get(data.seed)!.x = cx;
    pos.get(data.seed)!.y = cy;
    for (const id of ids) {
      const p = pos.get(id)!;
      p.x = Math.min(W - 30, Math.max(30, p.x));
      p.y = Math.min(H - 24, Math.max(24, p.y));
    }
  }
  return pos;
}

export default function GraphExplorer() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Sym[]>([]);
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [selected, setSelected] = useState<{ symbol: Sym; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const search = useCallback(async (q: string) => {
    setQuery(q);
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    const res = await fetch(`/api/symbols?q=${encodeURIComponent(q)}`);
    setResults(await res.json());
  }, []);

  const openGraph = useCallback(async (id: string) => {
    setBusy(true);
    try {
      const [g, s] = await Promise.all([
        fetch(`/api/graph?id=${id}&hops=2`).then((r) => r.json()),
        fetch(`/api/source?id=${id}`).then((r) => r.json()),
      ]);
      setGraph(g);
      setSelected(s);
      setResults([]);
    } finally {
      setBusy(false);
    }
  }, []);

  const W = 680;
  const H = 480;
  const pos = useMemo(() => (graph ? layout(graph, W, H) : null), [graph]);

  useEffect(() => {
    // deep-link: /graph?q=App opens the top match directly
    const q = new URLSearchParams(window.location.search).get('q');
    if (!q) return;
    void (async () => {
      setQuery(q);
      const res = await fetch(`/api/symbols?q=${encodeURIComponent(q)}`);
      const syms: Sym[] = await res.json();
      if (syms.length > 0) await openGraph(syms[0].id);
    })();
  }, [openGraph]);

  return (
    <>
      <input
        type="text"
        placeholder="シンボル名で検索(例: App, getFlightDetails)…"
        value={query}
        onChange={(e) => void search(e.target.value)}
        aria-label="シンボル検索"
      />
      {results.length > 0 && (
        <div className="card" style={{ marginTop: 8 }}>
          <table className="ledger">
            <tbody>
              {results.map((s) => (
                <tr key={s.id} style={{ cursor: 'pointer' }} onClick={() => void openGraph(s.id)}>
                  <td><span style={{ color: KIND_COLOR[s.kind] ?? 'var(--ink-2)' }}>●</span> {s.container ? `${s.container}.` : ''}{s.name}</td>
                  <td className="muted">{s.kind}</td>
                  <td className="mono muted">{s.file}:{s.spanStart}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {busy && <p className="muted">読み込み中…</p>}

      {graph && pos && (
        <div className="split" style={{ marginTop: 16 }}>
          <div className="card" style={{ padding: 8 }}>
            <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }} role="img" aria-label="コードグラフ近傍">
              {graph.links.map((l, i) => {
                const a = pos.get(l.source);
                const b = pos.get(l.target);
                if (!a || !b) return null;
                return (
                  <line
                    key={i}
                    x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                    stroke="var(--ink-3)"
                    strokeWidth={l.kind === 'calls' ? 1.6 : 1}
                    strokeDasharray={l.kind === 'calls' ? undefined : l.kind === 'imports' ? '2 4' : '5 4'}
                    opacity={0.55}
                  />
                );
              })}
              {graph.nodes.map((n) => {
                const p = pos.get(n.id)!;
                const isSeed = n.id === graph.seed;
                return (
                  <g key={n.id} style={{ cursor: 'pointer' }} onClick={() => void openGraph(n.id)}>
                    <circle
                      cx={p.x} cy={p.y}
                      r={isSeed ? 11 : 7}
                      fill={KIND_COLOR[n.kind] ?? 'var(--ink-2)'}
                      stroke="var(--surface-1)"
                      strokeWidth={2}
                    >
                      <title>{`${n.name} (${n.kind}) — ${n.file}:${n.spanStart}-${n.spanEnd}`}</title>
                    </circle>
                    <text x={p.x} y={p.y - (isSeed ? 15 : 11)} textAnchor="middle" fontSize={isSeed ? 12 : 10.5} fontWeight={isSeed ? 600 : 400} fill="var(--ink)">
                      {n.name.length > 26 ? n.name.slice(0, 24) + '…' : n.name}
                    </text>
                  </g>
                );
              })}
            </svg>
            <p className="muted" style={{ fontSize: 12, margin: '4px 8px' }}>
              実線 = calls / 破線 = references·extends / 点線 = imports。ノードをクリックで再中心化。
            </p>
          </div>
          <div>
            {selected && (
              <>
                <h2 style={{ marginTop: 0 }}>
                  {selected.symbol.name} <span className="sub">{selected.symbol.kind}</span>
                </h2>
                <p className="mono muted" style={{ fontSize: 12 }}>
                  {selected.symbol.file}:{selected.symbol.spanStart}-{selected.symbol.spanEnd}
                </p>
                <pre className="source">{selected.text}</pre>
              </>
            )}
          </div>
        </div>
      )}

      {!graph && !busy && (
        <p className="muted" style={{ marginTop: 16 }}>
          シンボルを検索して選ぶと、その 2-hop 近傍(呼び出し関係・参照・import)が書架のように広がります。
        </p>
      )}
    </>
  );
}

/**
 * Eval-accuracy time series (ADR-4 の「自分の数字」) — server-rendered SVG.
 * Single series: 2px line, 8px markers with <title> hovers, direct label on
 * the latest point, recessive grid, no legend (the title names the series).
 * A table view accompanies it on the page for accessibility.
 */
interface Row {
  id: number;
  micro_recall: number;
  used_cache: number;
  note: string | null;
}

export default function EvalChart({ rows }: { rows: Row[] }) {
  if (rows.length === 0) {
    return <p className="muted">まだ計測がありません。`librarian eval` を実行すると時系列が育ちます。</p>;
  }
  const W = 640;
  const H = 220;
  const PAD = { l: 44, r: 96, t: 14, b: 28 };
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;

  const ys = rows.map((r) => r.micro_recall);
  const yMin = Math.max(0, Math.floor((Math.min(...ys) - 0.05) * 10) / 10);
  const yMax = 1;
  const x = (i: number) => PAD.l + (rows.length === 1 ? iw / 2 : (i / (rows.length - 1)) * iw);
  const y = (v: number) => PAD.t + (1 - (v - yMin) / (yMax - yMin)) * ih;

  const ticks: number[] = [];
  for (let t = yMin; t <= yMax + 1e-9; t += 0.1) ticks.push(Math.round(t * 10) / 10);
  const path = rows.map((r, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(r.micro_recall).toFixed(1)}`).join(' ');
  const last = rows[rows.length - 1];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="retrieval match 率の時系列" style={{ width: '100%', height: 'auto' }}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--rule)" strokeWidth={1} />
          <text x={PAD.l - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--ink-3)">
            {Math.round(t * 100)}%
          </text>
        </g>
      ))}
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" />
      {rows.map((r, i) => (
        <circle key={r.id} cx={x(i)} cy={y(r.micro_recall)} r={4} fill="var(--accent)" stroke="var(--surface-1)" strokeWidth={2}>
          <title>{`run ${r.id}: ${(r.micro_recall * 100).toFixed(1)}%${r.used_cache ? ' (PatternCache)' : ''}${r.note ? ` — ${r.note}` : ''}`}</title>
        </circle>
      ))}
      <text x={x(rows.length - 1) + 10} y={y(last.micro_recall) + 4} fontSize={12.5} fontWeight={600} fill="var(--ink)">
        {(last.micro_recall * 100).toFixed(1)}%
      </text>
      {rows.map((r, i) => (
        <text key={r.id} x={x(i)} y={H - 8} textAnchor="middle" fontSize={10.5} fill="var(--ink-3)">
          {r.id}
        </text>
      ))}
      <text x={8} y={H - 8} fontSize={10.5} fill="var(--ink-3)">run</text>
    </svg>
  );
}

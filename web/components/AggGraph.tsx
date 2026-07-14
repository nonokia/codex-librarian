'use client';

import { useMemo } from 'react';
import { type AggGraph as AggGraphData, edgeDash, forceLayout } from '@/lib/graph';

/**
 * A collapsed node-link graph (repo / directory / file nodes, rolled-up edges).
 * Node radius scales with symbol count, edge width with the bundle size, so a
 * dense area reads as a few thick lines instead of a black mat of edges (#28).
 */
export default function AggGraph({
  data,
  onOpen,
  emptyNote,
}: {
  data: AggGraphData;
  onOpen?: (id: string) => void;
  emptyNote?: string;
}) {
  const W = 680;
  const H = 480;
  const pos = useMemo(() => forceLayout(data.nodes, data.links, W, H), [data]);
  const maxSym = Math.max(1, ...data.nodes.map((n) => n.symbols));
  const maxCount = Math.max(1, ...data.links.map((l) => l.count));

  if (data.nodes.length === 0) {
    return <p className="muted">{emptyNote ?? '表示できるノードがありません。'}</p>;
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }} role="img" aria-label="集約コードグラフ">
      {data.links.map((l, i) => {
        const a = pos.get(l.source);
        const b = pos.get(l.target);
        if (!a || !b) return null;
        return (
          <line
            key={i}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke="var(--ink-3)"
            strokeWidth={1 + (l.count / maxCount) * 3}
            strokeDasharray={edgeDash(l.kind)}
            opacity={0.5}
          >
            <title>{`${l.kind} ×${l.count}`}</title>
          </line>
        );
      })}
      {data.nodes.map((n) => {
        const p = pos.get(n.id)!;
        const r = 6 + (n.symbols / maxSym) * 10;
        return (
          <g
            key={n.id}
            style={{ cursor: onOpen ? 'pointer' : 'default' }}
            onClick={() => onOpen?.(n.id)}
          >
            <circle cx={p.x} cy={p.y} r={r} fill="var(--accent)" stroke="var(--surface-1)" strokeWidth={2}>
              <title>{`${n.label} — ${n.symbols} symbols${n.files > 1 ? `, ${n.files} files` : ''}${n.unresolved ? `, ${n.unresolved} unresolved` : ''}`}</title>
            </circle>
            {n.unresolved > 0 && (
              <circle cx={p.x + r * 0.7} cy={p.y - r * 0.7} r={3.5} fill="var(--shelf)" stroke="var(--surface-1)" strokeWidth={1}>
                <title>{`${n.unresolved} unresolved out-edges`}</title>
              </circle>
            )}
            <text x={p.x} y={p.y - r - 4} textAnchor="middle" fontSize={10.5} fill="var(--ink)">
              {n.label.length > 28 ? '…' + n.label.slice(-26) : n.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

'use client';

import { useCallback, useEffect, useState } from 'react';
import { KIND_COLOR, type Sym } from '@/lib/graph';
import OverviewPanel from './OverviewPanel';
import NeighborhoodPanel from './NeighborhoodPanel';

/**
 * "書架を歩く" (#28). Default view is the aggregated overview — a
 * repo → directory → file tree beside a level-collapsed graph — so even a large
 * or multi-repo index opens readable instead of as a black mat of edges. Search
 * or drilling into a symbol switches to its k-hop neighborhood.
 */
export default function GraphExplorer() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Sym[]>([]);
  const [seedId, setSeedId] = useState<string | null>(null);

  const search = useCallback(async (q: string) => {
    setQuery(q);
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    const res = await fetch(`/api/symbols?q=${encodeURIComponent(q)}`);
    setResults(await res.json());
  }, []);

  const openSymbol = useCallback((id: string) => {
    setSeedId(id);
    setResults([]);
  }, []);

  useEffect(() => {
    // deep-link: /graph?q=App opens the top match's neighborhood directly
    const q = new URLSearchParams(window.location.search).get('q');
    if (!q) return;
    void (async () => {
      setQuery(q);
      const res = await fetch(`/api/symbols?q=${encodeURIComponent(q)}`);
      const syms: Sym[] = await res.json();
      if (syms.length > 0) openSymbol(syms[0].id);
    })();
  }, [openSymbol]);

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
                <tr key={s.id} style={{ cursor: 'pointer' }} onClick={() => openSymbol(s.id)}>
                  <td>
                    <span style={{ color: KIND_COLOR[s.kind] ?? 'var(--ink-2)' }}>●</span>{' '}
                    {s.container ? `${s.container}.` : ''}
                    {s.name}
                  </td>
                  <td className="muted">{s.kind}</td>
                  <td>
                    <span className="pill">{s.repo}</span>
                  </td>
                  <td className="mono muted">
                    {s.file}:{s.spanStart}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        {seedId ? (
          <NeighborhoodPanel seedId={seedId} onOpenSymbol={openSymbol} onBack={() => setSeedId(null)} />
        ) : (
          <OverviewPanel onOpenSymbol={openSymbol} />
        )}
      </div>
    </>
  );
}

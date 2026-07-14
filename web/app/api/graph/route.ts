import { NextRequest, NextResponse } from 'next/server';
import { openLibrarian } from '@/lib/librarian';

/**
 * k-hop neighborhood as a drawable graph: nodes (seed + neighbors) and the
 * resolved edges among them.
 */
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id');
  const hops = Number(req.nextUrl.searchParams.get('hops') ?? 2);
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const { store } = openLibrarian();
  const seed = store.symbolById(id);
  if (!seed) return NextResponse.json({ error: 'unknown symbol' }, { status: 404 });

  const neighbors = store.neighborhood(id, hops, 120);
  const base = [{ ...seed, depth: 0 }, ...neighbors.map((n) => ({ ...n }))];
  const inSet = new Set(base.map((n) => n.id));
  const links: { source: string; target: string; kind: string }[] = [];
  const seen = new Set<string>();
  // per-node count of unresolved outgoing edges — surfaced as a toggleable
  // badge so the neighborhood can show where the graph runs out (#28).
  const unresolvedOut = new Map<string, number>();
  for (const n of base) {
    const { out } = store.edgesOf(n.id);
    for (const e of out) {
      if (!e.resolved) {
        unresolvedOut.set(n.id, (unresolvedOut.get(n.id) ?? 0) + 1);
        continue;
      }
      if (!e.toId || !inSet.has(e.toId)) continue;
      const key = `${e.fromId}|${e.toId}|${e.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ source: e.fromId, target: e.toId, kind: e.kind });
    }
  }
  const nodes = base.map((n) => ({ ...n, unresolvedOut: unresolvedOut.get(n.id) ?? 0 }));
  return NextResponse.json({ seed: seed.id, nodes, links });
}

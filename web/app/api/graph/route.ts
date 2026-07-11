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
  const nodes = [
    { ...seed, depth: 0 },
    ...neighbors.map((n) => ({ ...n })),
  ];
  const inSet = new Set(nodes.map((n) => n.id));
  const links: { source: string; target: string; kind: string }[] = [];
  const seen = new Set<string>();
  for (const n of nodes) {
    const { out } = store.edgesOf(n.id);
    for (const e of out) {
      if (!e.resolved || !e.toId || !inSet.has(e.toId)) continue;
      const key = `${e.fromId}|${e.toId}|${e.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ source: e.fromId, target: e.toId, kind: e.kind });
    }
  }
  return NextResponse.json({ seed: seed.id, nodes, links });
}

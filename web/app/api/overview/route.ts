import { NextResponse } from 'next/server';
import { openLibrarian } from '@/lib/librarian';

/**
 * The aggregated overview (#28): per-file symbol counts and the code graph
 * collapsed to file granularity. The client folds these into the
 * repo → directory → file tree and the level-collapsed graph — the store hands
 * over primitives only (ADR-5).
 */
export async function GET() {
  const { store } = openLibrarian();
  return NextResponse.json({
    repos: store.listRepos().map((r) => r.name),
    files: store.symbolCountsByFile(),
    edges: store.collapsedEdges(),
  });
}

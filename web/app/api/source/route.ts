import { NextRequest, NextResponse } from 'next/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openLibrarian } from '@/lib/librarian';

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const { store, root } = openLibrarian();
  const sym = store.symbolById(id);
  if (!sym) return NextResponse.json({ error: 'unknown symbol' }, { status: 404 });
  let text = '';
  try {
    const lines = readFileSync(join(root, sym.file), 'utf8').split('\n');
    text = lines.slice(sym.spanStart - 1, sym.spanEnd).join('\n');
  } catch {
    text = '(source unavailable — repo not on this machine)';
  }
  return NextResponse.json({ symbol: sym, text });
}

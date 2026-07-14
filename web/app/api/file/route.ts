import { NextRequest, NextResponse } from 'next/server';
import { openLibrarian } from '@/lib/librarian';

/** Symbols declared in one file — the leaf level of the overview tree (#28). */
export async function GET(req: NextRequest) {
  const path = req.nextUrl.searchParams.get('path');
  const repo = req.nextUrl.searchParams.get('repo') ?? undefined;
  if (!path) return NextResponse.json({ error: 'path required' }, { status: 400 });
  const { store } = openLibrarian();
  return NextResponse.json(store.symbolsInFile(path, repo));
}

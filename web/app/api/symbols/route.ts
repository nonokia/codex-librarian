import { NextRequest, NextResponse } from 'next/server';
import { openLibrarian } from '@/lib/librarian';

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q') ?? '';
  if (q.trim() === '') return NextResponse.json([]);
  const { store } = openLibrarian();
  return NextResponse.json(store.findSymbols(q, 20));
}

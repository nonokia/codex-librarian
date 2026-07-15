import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { openLibrarian, expandContext } from '@/lib/librarian';
import type { SymbolRow, Seed } from '@/lib/librarian';

const MODEL = process.env.LIBRARIAN_MODEL ?? 'claude-opus-4-8';
// Budget + oversized threshold are env-overridable (#41). The budget governs
// *retrieved* context (seeds are free); a candidate over `fraction` of the
// remaining budget demotes to a signature card instead of crowding everyone out.
const BUDGET = Number(process.env.LIBRARIAN_ASK_BUDGET ?? 9000);
const OVERSIZED_FRACTION = Number(process.env.LIBRARIAN_ASK_OVERSIZED_FRACTION ?? 0.4);

const NO_SEEDS_NOTE =
  '質問の語からシンボルを特定できませんでした。関数名・コンポーネント名を含めて聞いてください(意味検索は未実装です)。';

/**
 * A reduced "signature card" — the form a symbol takes when its full source is
 * too big to pass in full (#41). Never silent: the prompt and the response both
 * mark it as a reduction, so the model never mistakes a signature for the body.
 */
function signatureCard(sym: SymbolRow): string {
  const head = sym.container ? `${sym.container}.${sym.name}` : sym.name;
  const lines = [`${sym.kind} ${head}`];
  if (sym.signature) lines.push(sym.signature);
  if (sym.doc) lines.push(sym.doc);
  return lines.join('\n');
}

/**
 * Q&A over the graph (§4-④). Seeds come from lexical symbol matches on the
 * question's terms; the graph neighborhood and its budget allocation are
 * delegated to the shared deterministic pipeline `expandContext()` (ADR-3),
 * the same one `librarian review` uses — so the two no longer maintain rival
 * budget logic, and the seed-starves-retrieval trap review already fixed does
 * not reappear here (#41). Requires ANTHROPIC_API_KEY; degrades to a clear 503
 * without it.
 */
export async function POST(req: NextRequest) {
  const { question } = (await req.json()) as { question?: string };
  if (!question?.trim()) return NextResponse.json({ error: 'question required' }, { status: 400 });

  const { store, rootFor } = openLibrarian();

  // lexical seed selection: try each word of the question against symbol names
  const terms = [...new Set(question.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? [])];
  const seedSyms = new Map<string, SymbolRow>();
  for (const t of terms) {
    for (const s of store.findSymbols(t, 3)) {
      if (s.kind !== 'module') seedSyms.set(s.id, s);
      if (seedSyms.size >= 5) break;
    }
    if (seedSyms.size >= 5) break;
  }

  if (seedSyms.size === 0) {
    return NextResponse.json({ answer: null, cited: [], note: NO_SEEDS_NOTE });
  }

  // Deterministic expansion + budget-aware packing (#41): seeds are not charged,
  // packing is score-ordered by edge weight, and a candidate too large to pass
  // in full is demoted to a signature card rather than vanishing — so every
  // 1-hop-reachable symbol reaches the model as full source or a signature.
  const seeds: Seed[] = [...seedSyms.values()].map((symbol) => ({ symbol, via: 'span-overlap' as const }));
  const pack = expandContext(store, rootFor, seeds, {
    hops: 1,
    budget: BUDGET,
    withSource: true,
    demote: { fraction: OVERSIZED_FRACTION, reducedText: signatureCard },
  });

  const sections: string[] = [];
  const cited: { name: string; file: string; span: [number, number]; reduced?: boolean }[] = [];
  for (const item of [...pack.seeds, ...pack.items]) {
    const text = item.text ?? '';
    if (text.length === 0) continue;
    cited.push({ name: item.name, file: item.file, span: item.span, ...(item.reduced ? { reduced: true } : {}) });
    const label = item.reduced ? ' (シグネチャのみ — 全文は予算超過で省略)' : '';
    sections.push(`### ${item.name} — ${item.file}:${item.span[0]}-${item.span[1]}${label}\n\`\`\`\n${text}\n\`\`\``);
  }

  if (sections.length === 0) {
    return NextResponse.json({ answer: null, cited: [], note: NO_SEEDS_NOTE });
  }

  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      system:
        'あなたはコードベースの司書である。与えられたコード文脈だけを根拠に、簡潔な日本語で質問に答える。' +
        '文脈に無いことは推測せず「文脈に無い」と言う。根拠にしたシンボル名を文中で挙げる。' +
        '「(シグネチャのみ)」と付いた文脈は本体ではなく宣言だけなので、実装の断定には使わない。',
      messages: [
        { role: 'user', content: `質問: ${question}\n\n## コード文脈(グラフ近傍)\n\n${sections.join('\n\n')}` },
      ],
    });
    if (response.stop_reason === 'refusal') {
      return NextResponse.json({ error: 'the model declined this question' }, { status: 502 });
    }
    const answer = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return NextResponse.json({ answer, cited });
  } catch (err) {
    const noCreds =
      err instanceof Anthropic.AuthenticationError ||
      (err instanceof Error && /authentication method/i.test(err.message));
    if (noCreds) {
      return NextResponse.json(
        { error: 'ANTHROPIC_API_KEY が未設定です。サーバ起動時に環境変数で渡してください(文脈の選定までは動いています — 下の「参照した蔵書」参照)。', cited },
        { status: 503 }
      );
    }
    throw err;
  }
}

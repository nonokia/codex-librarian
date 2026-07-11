import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openLibrarian } from '@/lib/librarian';
import type { SymbolRow } from '@/lib/librarian';

const MODEL = process.env.LIBRARIAN_MODEL ?? 'claude-opus-4-8';

/**
 * Q&A over the graph (§4-④). Seeds come from lexical symbol matches on the
 * question's terms, context from the k-hop neighborhood — the semantic
 * (embedding) stage is still absent, and the UI says so. Requires
 * ANTHROPIC_API_KEY on the server; degrades to a clear 503 without it.
 */
export async function POST(req: NextRequest) {
  const { question } = (await req.json()) as { question?: string };
  if (!question?.trim()) return NextResponse.json({ error: 'question required' }, { status: 400 });

  const { store, root } = openLibrarian();

  // lexical seed selection: try each word of the question against symbol names
  const terms = [...new Set(question.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? [])];
  const seeds = new Map<string, SymbolRow>();
  for (const t of terms) {
    for (const s of store.findSymbols(t, 3)) {
      if (s.kind !== 'module') seeds.set(s.id, s);
      if (seeds.size >= 5) break;
    }
    if (seeds.size >= 5) break;
  }

  const sourceOf = (s: SymbolRow) => {
    try {
      return readFileSync(join(root, s.file), 'utf8')
        .split('\n')
        .slice(s.spanStart - 1, s.spanEnd)
        .join('\n');
    } catch {
      return '';
    }
  };

  const sections: string[] = [];
  const cited: { name: string; file: string; span: [number, number] }[] = [];
  let budget = 9000;
  for (const s of seeds.values()) {
    for (const item of [s, ...store.neighborhood(s.id, 1, 8)]) {
      if (cited.some((c) => c.name === item.name && c.file === item.file)) continue;
      const text = sourceOf(item);
      if (text.length === 0 || text.length > budget) continue;
      budget -= text.length;
      cited.push({ name: item.name, file: item.file, span: [item.spanStart, item.spanEnd] });
      sections.push(`### ${item.name} — ${item.file}:${item.spanStart}-${item.spanEnd}\n\`\`\`\n${text}\n\`\`\``);
    }
  }

  if (sections.length === 0) {
    return NextResponse.json({
      answer: null,
      cited: [],
      note: '質問の語からシンボルを特定できませんでした。関数名・コンポーネント名を含めて聞いてください(意味検索は未実装です)。',
    });
  }

  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      system:
        'あなたはコードベースの司書である。与えられたコード文脈だけを根拠に、簡潔な日本語で質問に答える。文脈に無いことは推測せず「文脈に無い」と言う。根拠にしたシンボル名を文中で挙げる。',
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

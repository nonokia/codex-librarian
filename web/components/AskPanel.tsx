'use client';

import { useState } from 'react';

interface Cited {
  name: string;
  file: string;
  span: [number, number];
  /** passed to the model as a signature card, not full source (#41) */
  reduced?: boolean;
}

export default function AskPanel() {
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [cited, setCited] = useState<Cited[]>([]);
  const [note, setNote] = useState<string | null>(null);

  async function ask() {
    if (!question.trim() || busy) return;
    setBusy(true);
    setAnswer(null);
    setNote(null);
    setCited([]);
    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question }),
      });
      const data = await res.json();
      if (!res.ok) {
        setNote(data.error ?? `エラー (${res.status})`);
        setCited(data.cited ?? []);
      } else {
        setAnswer(data.answer);
        setCited(data.cited ?? []);
        setNote(data.note ?? null);
      }
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="text"
          placeholder="このコードベースについて質問(例: getFlightDetails は API キーが無いときどう振る舞う?)"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void ask()}
          aria-label="質問"
        />
        <button onClick={() => void ask()} disabled={busy || !question.trim()}>
          {busy ? '調べ中…' : '聞く'}
        </button>
      </div>
      <p className="muted" style={{ fontSize: 12.5 }}>
        質問の語に一致したシンボルとそのグラフ近傍だけを文脈に渡します(意味検索は未実装 —
        関数名・コンポーネント名を含めると精度が上がります)。サーバ側に ANTHROPIC_API_KEY が必要です。
      </p>

      {note && (
        <div className="card" style={{ marginTop: 12 }}>
          <p style={{ margin: 0 }}>{note}</p>
        </div>
      )}
      {answer && (
        <div className="card answer" style={{ marginTop: 12 }}>{answer}</div>
      )}
      {cited.length > 0 && (
        <>
          <h2>参照した蔵書</h2>
          <div className="card">
            <table className="ledger">
              <tbody>
                {cited.map((c, i) => (
                  <tr key={i}>
                    <td>
                      {c.name}
                      {c.reduced && (
                        <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>
                          (シグネチャのみ)
                        </span>
                      )}
                    </td>
                    <td className="mono muted">{c.file}:{c.span[0]}-{c.span[1]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

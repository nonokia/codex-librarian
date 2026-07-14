'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  aggregate,
  autoLevel,
  buildForest,
  EDGE_KINDS,
  type EdgeKind,
  KIND_COLOR,
  type Level,
  type OverviewData,
  type Sym,
  type TreeNode,
} from '@/lib/graph';
import AggGraph from './AggGraph';

const FILE_THRESHOLD = 40; // above this many files, default to directory rollup

export default function OverviewPanel({ onOpenSymbol }: { onOpenSymbol: (id: string) => void }) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [level, setLevel] = useState<Level | null>(null);
  const [dirDepth, setDirDepth] = useState(2);
  const [kinds, setKinds] = useState<Set<EdgeKind>>(new Set(EDGE_KINDS));
  const [showUnresolved, setShowUnresolved] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    void fetch('/api/overview')
      .then((r) => r.json())
      .then((d: OverviewData) => {
        setData(d);
        const multi = d.repos.length > 1;
        setLevel(autoLevel(d.files, multi, FILE_THRESHOLD));
        // open the repo roots so the first click is always "expand"
        setExpanded(new Set(d.repos));
      });
  }, []);

  const multiRepo = (data?.repos.length ?? 0) > 1;
  const effLevel: Level = level ?? 'file';
  const agg = useMemo(() => {
    if (!data) return null;
    return aggregate(data.files, data.edges, {
      level: effLevel,
      dirDepth,
      kinds,
      showUnresolved,
      multiRepo,
    });
  }, [data, effLevel, dirDepth, kinds, showUnresolved, multiRepo]);
  const forest = useMemo(() => (data ? buildForest(data.files) : []), [data]);

  if (!data) return <p className="muted">読み込み中…</p>;

  const toggleKind = (k: EdgeKind) =>
    setKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const autoNote =
    !multiRepo && data.files.length > FILE_THRESHOLD && effLevel === 'dir'
      ? `${data.files.length} ファイルはそのまま描くと判読不能なため、ディレクトリ単位に自動集約しています。`
      : null;

  return (
    <>
      <div className="toolbar">
        <span className="muted">粒度:</span>
        {(['repo', 'dir', 'file'] as Level[]).map((lv) => (
          <button
            key={lv}
            className={`chip ${effLevel === lv ? 'chip-on' : ''}`}
            disabled={lv === 'repo' && !multiRepo}
            onClick={() => setLevel(lv)}
            title={lv === 'repo' && !multiRepo ? '単一リポジトリでは repo 集約は無意味' : undefined}
          >
            {lv === 'repo' ? 'リポジトリ' : lv === 'dir' ? 'ディレクトリ' : 'ファイル'}
          </button>
        ))}
        {effLevel === 'dir' && (
          <span className="muted" style={{ marginLeft: 6 }}>
            深さ{' '}
            <button className="chip" onClick={() => setDirDepth((d) => Math.max(1, d - 1))}>
              −
            </button>{' '}
            {dirDepth}{' '}
            <button className="chip" onClick={() => setDirDepth((d) => Math.min(5, d + 1))}>
              +
            </button>
          </span>
        )}
      </div>
      <div className="toolbar">
        <span className="muted">エッジ:</span>
        {EDGE_KINDS.map((k) => (
          <label key={k} className="chk">
            <input type="checkbox" checked={kinds.has(k)} onChange={() => toggleKind(k)} /> {k}
          </label>
        ))}
        <label className="chk" style={{ marginLeft: 6 }}>
          <input type="checkbox" checked={showUnresolved} onChange={() => setShowUnresolved((v) => !v)} /> unresolved
        </label>
      </div>

      {autoNote && (
        <p className="muted" style={{ fontSize: 12, margin: '4px 0' }}>
          ⚠ {autoNote}
        </p>
      )}

      <div className="split" style={{ marginTop: 12 }}>
        <div className="card" style={{ padding: 8 }}>
          {agg && (
            <AggGraph
              data={{
                ...agg,
                nodes: showUnresolved ? agg.nodes : agg.nodes.map((n) => ({ ...n, unresolved: 0 })),
              }}
              onOpen={(id) => {
                // clicking a group focuses the tree on it
                setExpanded((prev) => new Set(prev).add(id.includes(' ') ? id.split(' ')[0] : id));
              }}
              emptyNote="選択したエッジ種別に一致する関連がありません。"
            />
          )}
          <p className="muted" style={{ fontSize: 12, margin: '4px 8px' }}>
            ● サイズ = シンボル数 / 線の太さ = 集約されたエッジ数 / 実線=calls 点線=imports 破線=references·extends。
            {showUnresolved && <> 小さな橙点 = 未解決の出力エッジあり。</>}
          </p>
        </div>

        <div className="card" style={{ maxHeight: 520, overflowY: 'auto' }}>
          <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
            展開 → ファイル → シンボルの順にたどると近傍ビューへ。
          </p>
          {forest.map((root) => (
            <Tree key={root.key} node={root} expanded={expanded} setExpanded={setExpanded} onOpenSymbol={onOpenSymbol} />
          ))}
        </div>
      </div>
    </>
  );
}

function Tree({
  node,
  expanded,
  setExpanded,
  onOpenSymbol,
  depth = 0,
}: {
  node: TreeNode;
  expanded: Set<string>;
  setExpanded: (fn: (prev: Set<string>) => Set<string>) => void;
  onOpenSymbol: (id: string) => void;
  depth?: number;
}) {
  const isOpen = expanded.has(node.key);
  const toggle = () =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(node.key)) next.delete(node.key);
      else next.add(node.key);
      return next;
    });

  return (
    <div style={{ marginLeft: depth === 0 ? 0 : 14 }}>
      <div
        className="treerow"
        onClick={node.kind === 'file' ? undefined : toggle}
        style={{ cursor: node.kind === 'file' ? 'default' : 'pointer' }}
      >
        <span className="tw">{node.kind === 'file' ? '·' : isOpen ? '▾' : '▸'}</span>
        <span className={node.kind === 'repo' ? 'pill' : node.kind === 'file' ? 'mono' : ''}>{node.label}</span>
        <span className="muted" style={{ fontSize: 11 }}>
          {node.symbols}
        </span>
      </div>
      {isOpen && node.kind !== 'file' && (
        <div>
          {node.children.map((c) => (
            <Tree key={c.key} node={c} expanded={expanded} setExpanded={setExpanded} onOpenSymbol={onOpenSymbol} depth={depth + 1} />
          ))}
        </div>
      )}
      {node.kind === 'file' && <FileSymbols repo={node.repo} path={node.path} onOpenSymbol={onOpenSymbol} />}
    </div>
  );
}

function FileSymbols({ repo, path, onOpenSymbol }: { repo: string; path: string; onOpenSymbol: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [syms, setSyms] = useState<Sym[] | null>(null);

  const load = () => {
    setOpen((v) => !v);
    if (syms === null) {
      void fetch(`/api/file?path=${encodeURIComponent(path)}&repo=${encodeURIComponent(repo)}`)
        .then((r) => r.json())
        .then(setSyms);
    }
  };

  return (
    <div style={{ marginLeft: 14 }}>
      <div className="treerow" style={{ cursor: 'pointer' }} onClick={load}>
        <span className="tw">{open ? '▾' : '▸'}</span>
        <span className="muted" style={{ fontSize: 12 }}>
          シンボル
        </span>
      </div>
      {open && syms && (
        <div>
          {syms.map((s) => (
            <div
              key={s.id}
              className="treerow"
              style={{ marginLeft: 14, cursor: 'pointer' }}
              onClick={() => onOpenSymbol(s.id)}
            >
              <span style={{ color: KIND_COLOR[s.kind] ?? 'var(--ink-2)' }}>●</span>
              <span>
                {s.container ? `${s.container}.` : ''}
                {s.name}
              </span>
              <span className="muted" style={{ fontSize: 11 }}>
                {s.kind}
              </span>
            </div>
          ))}
          {syms.length === 0 && <p className="muted" style={{ marginLeft: 14, fontSize: 12 }}>シンボルなし</p>}
        </div>
      )}
    </div>
  );
}

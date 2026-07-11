import GraphExplorer from '@/components/GraphExplorer';

export const dynamic = 'force-dynamic';

export default function GraphPage() {
  return (
    <>
      <h2 style={{ marginTop: 18 }}>
        書架を歩く <span className="sub">シンボル検索 → k-hop 近傍のコードグラフ</span>
      </h2>
      <GraphExplorer />
    </>
  );
}

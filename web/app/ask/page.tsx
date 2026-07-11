import AskPanel from '@/components/AskPanel';

export const dynamic = 'force-dynamic';

export default function AskPage() {
  return (
    <>
      <h2 style={{ marginTop: 18 }}>
        司書に聞く <span className="sub">グラフ近傍を文脈にした Q&amp;A</span>
      </h2>
      <AskPanel />
    </>
  );
}

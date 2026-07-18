import { useEffect, useState } from 'react';
import { getSubmissionsByMaterial, type Submission } from '../../lib/db';

export interface SubmissionHistoryProps {
  materialId: string;
  /** この値が変わるたびに一覧を再取得する（提出直後の更新用）。 */
  refreshKey?: number;
}

function formatDateTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes(),
  ).padStart(2, '0')}`;
}

export function SubmissionHistory({ materialId, refreshKey }: SubmissionHistoryProps) {
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void getSubmissionsByMaterial(materialId).then((list) => {
      if (!cancelled) {
        setSubmissions(list);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [materialId, refreshKey]);

  if (loading) {
    return <p className="text-xs text-neutral-400">読み込み中…</p>;
  }
  if (submissions.length === 0) {
    return <p className="text-xs text-neutral-400">まだ提出はありません</p>;
  }

  return (
    <ul className="flex flex-col gap-2">
      {submissions.map((submission) => (
        <SubmissionItem key={submission.id} submission={submission} />
      ))}
    </ul>
  );
}

function SubmissionItem({ submission }: { submission: Submission }) {
  const [url] = useState(() => URL.createObjectURL(submission.audioBlob));
  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  return (
    <li className="flex items-center justify-between gap-2 rounded-md border border-neutral-200 px-3 py-2 text-sm">
      <span className="shrink-0 text-neutral-600">{formatDateTime(submission.createdAt)}</span>
      <audio controls src={url} className="h-8 max-w-[65%]" />
    </li>
  );
}

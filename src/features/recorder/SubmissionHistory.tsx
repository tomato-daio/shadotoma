import { useEffect, useState } from 'react';
import { getSubmissionsByMaterial, type Submission } from '../../lib/db';
import { JudgeResultView } from '../judge/JudgeResultView';

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

  // 前回比表示用: 各提出について、それより前（配列内でより後ろ=古い）の提出のうちjudgeを
  // 持つ直近のものを探す。submissionsは新しい順（createdAt降順）なので、自分より後ろを見る。
  const previousMatchRateOf = (index: number): number | undefined => {
    for (let i = index + 1; i < submissions.length; i++) {
      const judge = submissions[i].judge;
      if (judge) return judge.matchRate;
    }
    return undefined;
  };

  return (
    <ul className="flex flex-col gap-2">
      {submissions.map((submission, i) => (
        <SubmissionItem
          key={submission.id}
          submission={submission}
          previousMatchRate={previousMatchRateOf(i)}
        />
      ))}
    </ul>
  );
}

function SubmissionItem({
  submission,
  previousMatchRate,
}: {
  submission: Submission;
  previousMatchRate?: number;
}) {
  const [url] = useState(() => URL.createObjectURL(submission.audioBlob));
  const [expanded, setExpanded] = useState(false);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  const judge = submission.judge;

  return (
    <li className="rounded-md border border-neutral-200 px-3 py-2 text-sm">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          disabled={!judge}
          className="flex shrink-0 items-center gap-2 text-left text-neutral-600 disabled:cursor-default"
        >
          <span>{formatDateTime(submission.createdAt)}</span>
          {judge ? (
            <span className="rounded-full bg-tomato-100 px-2 py-0.5 text-xs font-semibold text-tomato-700">
              {Math.round(judge.matchRate * 100)}%
            </span>
          ) : (
            <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-400">添削なし</span>
          )}
          {judge ? <span className="text-xs text-neutral-400">{expanded ? '▲' : '▼'}</span> : null}
        </button>
        <audio controls src={url} className="h-8 max-w-[55%]" />
      </div>
      {expanded && judge ? (
        <div className="mt-3 border-t border-neutral-100 pt-3">
          {/* M8: 過去提出でも保存済みtranscriptから「あなたの発話」を表示する（無い提出では非表示） */}
          <JudgeResultView
            judge={judge}
            previousMatchRate={previousMatchRate}
            transcript={submission.transcript}
          />
        </div>
      ) : null}
    </li>
  );
}

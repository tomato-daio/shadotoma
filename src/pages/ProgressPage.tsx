import { useEffect, useMemo, useState } from 'react';
import { MatchRateChart } from '../features/progress/MatchRateChart';
import { PracticeCalendar } from '../features/progress/PracticeCalendar';
import {
  getAllMaterialProgress,
  getAllMaterials,
  getAllPracticedDates,
  getAllSubmissions,
  type Material,
  type MaterialProgress,
  type Submission,
} from '../lib/db';
import { calcStreak, learningDate } from '../lib/dates';

const STATUS_LABEL: Record<MaterialProgress['status'], string> = {
  'not-started': '未開始',
  active: '練習中',
  done: '完了',
};

export function ProgressPage() {
  const [streak, setStreak] = useState(0);
  const [practicedDates, setPracticedDates] = useState<string[]>([]);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [progresses, setProgresses] = useState<MaterialProgress[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([getAllPracticedDates(), getAllSubmissions(), getAllMaterials(), getAllMaterialProgress()]).then(
      ([dates, subs, mats, progs]) => {
        if (cancelled) return;
        setPracticedDates(dates);
        setStreak(calcStreak(dates, learningDate(new Date())));
        setSubmissions(subs);
        setMaterials(mats);
        setProgresses(progs);
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const materialTitleById = useMemo(() => new Map(materials.map((m) => [m.id, m.title])), [materials]);

  const matchRatePoints = useMemo(() => {
    return submissions
      .filter((s): s is Submission & { judge: NonNullable<Submission['judge']> } => Boolean(s.judge))
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((s) => ({ date: s.date, matchRate: s.judge.matchRate }));
  }, [submissions]);

  const sortedProgresses = useMemo(
    () => progresses.slice().sort((a, b) => b.daysPracticed.length - a.daysPracticed.length),
    [progresses],
  );

  if (loading) {
    return <div className="p-6 text-center text-sm text-neutral-400">読み込み中…</div>;
  }

  return (
    <div className="flex flex-col gap-6 p-4 pb-10">
      <h1 className="text-lg font-bold text-neutral-800">進捗</h1>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-neutral-200 p-4 text-center">
          <p className="text-2xl font-bold text-tomato-600">{streak}</p>
          <p className="text-xs text-neutral-400">連続学習日数</p>
        </div>
        <div className="rounded-xl border border-neutral-200 p-4 text-center">
          <p className="text-2xl font-bold text-tomato-600">{submissions.length}</p>
          <p className="text-xs text-neutral-400">提出回数</p>
        </div>
      </div>

      <section className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-4">
        <p className="text-sm font-medium text-neutral-700">練習カレンダー</p>
        <PracticeCalendar practicedDates={practicedDates} />
      </section>

      <section className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-4">
        <p className="text-sm font-medium text-neutral-700">一致率の推移</p>
        <MatchRateChart points={matchRatePoints} />
      </section>

      <section className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-4">
        <p className="text-sm font-medium text-neutral-700">教材ごとの進捗</p>
        {sortedProgresses.length === 0 ? (
          <p className="text-xs text-neutral-400">まだ練習記録がありません</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {sortedProgresses.map((p) => (
              <li
                key={p.materialId}
                className="flex items-center justify-between gap-2 rounded-md border border-neutral-100 px-3 py-2 text-sm"
              >
                <span className="truncate text-neutral-700">{materialTitleById.get(p.materialId) ?? p.materialId}</span>
                <span className="shrink-0 text-xs text-neutral-400">
                  {p.daysPracticed.length}日 ・ {STATUS_LABEL[p.status]}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MatchRateChart } from '../features/progress/MatchRateChart';
import { PracticeCalendar } from '../features/progress/PracticeCalendar';
import { articleHeadingTitle } from '../lib/articleTitle';
import {
  getAllMaterialProgress,
  getAllMaterials,
  getAllPracticedDates,
  getAllSubmissions,
  getRecentQuizResults,
  type Material,
  type MaterialProgress,
  type QuizResult,
  type Submission,
} from '../lib/db';
import { calcStreak, learningDate } from '../lib/dates';

const RECENT_QUIZ_RESULT_LIMIT = 5;

const STATUS_LABEL: Record<MaterialProgress['status'], string> = {
  'not-started': '未開始',
  active: '練習中',
  done: '完了',
};

export function ProgressPage() {
  const navigate = useNavigate();
  const [streak, setStreak] = useState(0);
  const [practicedDates, setPracticedDates] = useState<string[]>([]);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [progresses, setProgresses] = useState<MaterialProgress[]>([]);
  const [quizResults, setQuizResults] = useState<QuizResult[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      getAllPracticedDates(),
      getAllSubmissions(),
      getAllMaterials(),
      getAllMaterialProgress(),
      getRecentQuizResults(RECENT_QUIZ_RESULT_LIMIT),
    ]).then(([dates, subs, mats, progs, quizzes]) => {
      if (cancelled) return;
      setPracticedDates(dates);
      setStreak(calcStreak(dates, learningDate(new Date())));
      setSubmissions(subs);
      setMaterials(mats);
      setProgresses(progs);
      setQuizResults(quizzes);
      setLoading(false);
    }).catch((err: unknown) => {
      // 一部の読み込みに失敗しても「読み込み中…」のまま固まらせない（空表示にフォールバック）
      console.error('進捗データの読み込みに失敗しました', err);
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const materialTitleById = useMemo(() => new Map(materials.map((m) => [m.id, m.title])), [materials]);

  // 確認テスト結果のarticleIdから記事見出しを引く（bundled教材のtitleは"元記事 (n/m)"形式なので剥がす）。
  const articleTitleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of materials) {
      if (m.articleId && !map.has(m.articleId)) {
        map.set(m.articleId, articleHeadingTitle(m.title));
      }
    }
    return map;
  }, [materials]);

  const matchRatePoints = useMemo(() => {
    return submissions
      .filter((s): s is Submission & { judge: NonNullable<Submission['judge']> } => Boolean(s.judge))
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((s) => ({ date: s.date, matchRate: s.judge.matchRate }));
  }, [submissions]);

  const sortedProgresses = useMemo(
    () =>
      progresses
        // 教材の入れ替え（セクション分割等）で本体が削除された進捗は表示しない
        .filter((p) => materialTitleById.has(p.materialId))
        .sort((a, b) => b.daysPracticed.length - a.daysPracticed.length),
    [progresses, materialTitleById],
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

      <section className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-4">
        <p className="text-sm font-medium text-neutral-700">最近のテスト結果</p>
        {quizResults.length === 0 ? (
          <p className="text-xs text-neutral-400">まだ確認テストの記録がありません</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {quizResults.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => navigate(`/quiz/${r.articleId}`)}
                  className="flex w-full items-center justify-between gap-2 rounded-md border border-neutral-100 px-3 py-2 text-left text-sm active:bg-neutral-50"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-neutral-700">{articleTitleById.get(r.articleId) ?? r.articleId}</span>
                    <span className="text-xs text-neutral-400">{r.date}</span>
                  </span>
                  <span className="shrink-0 text-sm font-semibold text-tomato-600">
                    {r.correct}/{r.total}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

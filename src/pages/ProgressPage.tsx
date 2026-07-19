import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { phonemeDisplayName, getPhonemeAdvice } from '../features/judge/phonemeAdvice';
import { MatchRateChart } from '../features/progress/MatchRateChart';
import { PracticeCalendar } from '../features/progress/PracticeCalendar';
import { buildWeaknessProfile, isWeaknessProfileEmpty, type WeaknessProfile } from '../features/insights/weakness';
import { articleHeadingTitle } from '../lib/articleTitle';
import {
  getAllMaterialProgress,
  getAllMaterials,
  getAllPracticedDates,
  getAllQuizResults,
  getAllSubmissions,
  type Material,
  type MaterialProgress,
  type QuizResult,
  type Submission,
} from '../lib/db';
import { calcStreak, learningDate } from '../lib/dates';
import type { PhenomenonType } from '../lib/phenomena';

const RECENT_QUIZ_RESULT_LIMIT = 5;

/** 音声現象タイプの日本語ラベル（JudgeResultView.tsx/feedback.tsと同じ表記に揃える）。 */
const PHENOMENON_LABEL: Record<PhenomenonType, string> = {
  linking: '連結',
  flap: 'フラップ（tの軽い音）',
  elision: '脱落',
  weak: '弱形',
  ending: '語尾(-s/-ed)',
};

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
      getAllQuizResults(),
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
      // DESIGN.md §8c(M9): Azure発音評価を実行した提出のみpronScoreを持つ（未実行の提出はundefined）。
      .map((s) => ({ date: s.date, matchRate: s.judge.matchRate, pronScore: s.judge.azure?.pronScore }));
  }, [submissions]);

  const sortedProgresses = useMemo(
    () =>
      progresses
        // 教材の入れ替え（セクション分割等）で本体が削除された進捗は表示しない
        .filter((p) => materialTitleById.has(p.materialId))
        .sort((a, b) => b.daysPracticed.length - a.daysPracticed.length),
    [progresses, materialTitleById],
  );

  // 最近のテスト結果表示用（新しい順の先頭RECENT_QUIZ_RESULT_LIMIT件。getAllQuizResultsが既に新しい順）。
  const recentQuizResults = useMemo(() => quizResults.slice(0, RECENT_QUIZ_RESULT_LIMIT), [quizResults]);

  // 「苦手分析」セクション（DESIGN.md §8d M13）。
  const weaknessProfile = useMemo(() => buildWeaknessProfile(submissions, quizResults), [submissions, quizResults]);

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
        <p className="text-sm font-medium text-neutral-700">苦手分析</p>
        {isWeaknessProfileEmpty(weaknessProfile) ? (
          <p className="text-xs text-neutral-400">提出が増えると分析が表示されます</p>
        ) : (
          <WeaknessAnalysis profile={weaknessProfile} />
        )}
      </section>

      <section className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-4">
        <p className="text-sm font-medium text-neutral-700">最近のテスト結果</p>
        {recentQuizResults.length === 0 ? (
          <p className="text-xs text-neutral-400">まだ確認テストの記録がありません</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {recentQuizResults.map((r) => (
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

/**
 * 「苦手分析」セクションの中身（DESIGN.md §8d M13）。
 * 苦手音トップ3＋コツ文・苦手現象・繰り返し間違う単語トップ5・克服バッジを表示する。
 * 各カテゴリはデータが無ければ個別に非表示にする（全体が空の場合は呼び出し側でメッセージ表示に切り替える）。
 */
function WeaknessAnalysis({ profile }: { profile: WeaknessProfile }) {
  return (
    <div className="flex flex-col gap-3">
      {profile.weakPhonemes.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-medium text-neutral-500">苦手な音</p>
          <ul className="flex flex-col gap-1.5">
            {profile.weakPhonemes.map((wp) => (
              <li key={wp.phoneme} className="rounded-md border border-neutral-100 bg-neutral-50/60 px-3 py-2 text-xs">
                <p className="font-medium text-neutral-700">
                  {phonemeDisplayName(wp.phoneme)}（{Math.round(wp.score)}点・
                  {wp.trend === 'improving' ? '改善中' : '停滞中'}）
                </p>
                {getPhonemeAdvice(wp.phoneme) ? (
                  <p className="mt-0.5 text-neutral-500">{getPhonemeAdvice(wp.phoneme)?.advice}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {profile.weakPhenomena.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-medium text-neutral-500">苦手な音声現象</p>
          <ul className="flex flex-wrap gap-1.5">
            {profile.weakPhenomena.map((p) => (
              <li key={p.type} className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs text-amber-700">
                {PHENOMENON_LABEL[p.type]}（{p.frequency}回）
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {profile.weakWords.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-medium text-neutral-500">繰り返し間違う単語</p>
          <ul className="flex flex-wrap gap-1.5">
            {profile.weakWords.map((w) => (
              <li key={w.word} className="rounded-full border border-red-200 bg-red-50 px-2.5 py-1 text-xs text-red-700">
                {w.word}（{w.count}回）
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {profile.overcomePhonemes.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-medium text-neutral-500">克服した音</p>
          <ul className="flex flex-wrap gap-1.5">
            {profile.overcomePhonemes.map((phoneme) => (
              <li key={phoneme} className="rounded-full border border-green-200 bg-green-50 px-2.5 py-1 text-xs text-green-700">
                🏅 {phonemeDisplayName(phoneme)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

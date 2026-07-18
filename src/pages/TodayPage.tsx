import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { articleHeadingTitle } from '../lib/articleTitle';
import { getAllMaterialProgress, getAllPracticedDates, type Material } from '../lib/db';
import { calcStreak, learningDate } from '../lib/dates';
import { computeDayNumber, getWizardSteps, latestDate } from '../lib/practiceFlow';
import { useMaterialsStore } from '../stores/useMaterialsStore';

interface ActiveMaterialInfo {
  material: Material;
  dayNumber: number;
  nextStepLabel: string;
}

interface QuizSuggestion {
  articleId: string;
  articleTitle: string;
  doneCount: number;
}

export function TodayPage() {
  const { materials, loaded, refresh } = useMaterialsStore();
  const [streak, setStreak] = useState(0);
  const [activeInfo, setActiveInfo] = useState<ActiveMaterialInfo | null>(null);
  const [quizSuggestion, setQuizSuggestion] = useState<QuizSuggestion | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!loaded) void refresh();
  }, [loaded, refresh]);

  useEffect(() => {
    let cancelled = false;
    void getAllPracticedDates().then((dates) => {
      if (cancelled) return;
      setStreak(calcStreak(dates, learningDate(new Date())));
    });
    return () => {
      cancelled = true;
    };
  }, [materials.length]);

  // 進行中の教材（materialProgress.status='active'のうち直近に練習したもの）と
  // 今日が何日目か・今日の推奨ステップを求める（DESIGN.md §2「今日」タブの仕様）。
  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    void getAllMaterialProgress().then((progresses) => {
      if (cancelled) return;
      const today = learningDate(new Date());
      const active = progresses
        .filter((p) => p.status === 'active')
        .sort((a, b) => latestDate(b.daysPracticed).localeCompare(latestDate(a.daysPracticed)))[0];

      if (!active) {
        setActiveInfo(null);
        setQuizSuggestion(null);
        return;
      }
      const material = materials.find((m) => m.id === active.materialId);
      if (!material) {
        setActiveInfo(null);
        setQuizSuggestion(null);
        return;
      }
      const dayNumber = computeDayNumber(active.daysPracticed, today);
      const nextStepLabel = getWizardSteps(dayNumber)[0]?.label ?? '';
      setActiveInfo({ material, dayNumber, nextStepLabel });

      // 確認テスト提案（DESIGN.md §8b: 記事内doneセクションが3の倍数に達した直後は今日タブでも提案）。
      // 進行中の教材が属する記事を対象に判定する。
      const articleId = material.articleId;
      if (!articleId) {
        setQuizSuggestion(null);
        return;
      }
      const sectionIds = new Set(materials.filter((m) => m.articleId === articleId).map((m) => m.id));
      const doneCount = progresses.filter((p) => sectionIds.has(p.materialId) && p.status === 'done').length;
      setQuizSuggestion(
        doneCount > 0 && doneCount % 3 === 0
          ? { articleId, articleTitle: articleHeadingTitle(material.title), doneCount }
          : null,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [loaded, materials]);

  return (
    <div className="flex flex-col gap-6 p-4">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-neutral-800">シャドとま</h1>
        <span className="rounded-full bg-tomato-100 px-3 py-1 text-sm font-semibold text-tomato-700">
          連続{streak}日
        </span>
      </header>

      {activeInfo ? (
        <section className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4">
          <p className="text-xs text-neutral-400">進行中の教材 ・ {activeInfo.dayNumber}日目</p>
          <p className="text-base font-medium text-neutral-800">{activeInfo.material.title}</p>
          <p className="text-xs text-tomato-600">今日のステップ: {activeInfo.nextStepLabel}</p>
          <button
            type="button"
            onClick={() => navigate(`/practice/${activeInfo.material.id}`)}
            className="rounded-full bg-tomato-500 px-4 py-3 text-sm font-semibold text-white active:bg-tomato-600"
          >
            練習をはじめる
          </button>
        </section>
      ) : materials.length === 0 ? (
        <section className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-neutral-300 p-6 text-center">
          <p className="text-sm text-neutral-500">まだ教材がありません</p>
          <Link to="/materials" className="rounded-full bg-tomato-500 px-4 py-2 text-sm font-semibold text-white">
            教材を追加する
          </Link>
        </section>
      ) : (
        <section className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-neutral-300 p-6 text-center">
          <p className="text-sm text-neutral-500">進行中の教材はありません</p>
          <Link to="/materials" className="rounded-full bg-tomato-500 px-4 py-2 text-sm font-semibold text-white">
            教材を選ぶ
          </Link>
        </section>
      )}

      {quizSuggestion ? (
        <section className="flex flex-col gap-2 rounded-xl border border-tomato-200 bg-tomato-50/50 p-4">
          <p className="text-sm text-tomato-700">
            「{quizSuggestion.articleTitle}」が{quizSuggestion.doneCount}セクション完了しました。確認テストに挑戦してみませんか？
          </p>
          <button
            type="button"
            onClick={() => navigate(`/quiz/${quizSuggestion.articleId}`)}
            className="self-start rounded-full border border-tomato-400 px-4 py-2 text-xs font-semibold text-tomato-700 active:bg-tomato-100"
          >
            確認テストに挑戦する
          </button>
        </section>
      ) : null}
    </div>
  );
}

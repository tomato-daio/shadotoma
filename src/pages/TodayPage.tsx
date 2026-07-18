import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getAllMaterialProgress, getAllPracticedDates, type Material } from '../lib/db';
import { calcStreak, learningDate } from '../lib/dates';
import { computeDayNumber, getWizardSteps, latestDate } from '../lib/practiceFlow';
import { useMaterialsStore } from '../stores/useMaterialsStore';

interface ActiveMaterialInfo {
  material: Material;
  dayNumber: number;
  nextStepLabel: string;
}

export function TodayPage() {
  const { materials, loaded, refresh } = useMaterialsStore();
  const [streak, setStreak] = useState(0);
  const [activeInfo, setActiveInfo] = useState<ActiveMaterialInfo | null>(null);
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
        return;
      }
      const material = materials.find((m) => m.id === active.materialId);
      if (!material) {
        setActiveInfo(null);
        return;
      }
      const dayNumber = computeDayNumber(active.daysPracticed, today);
      const nextStepLabel = getWizardSteps(dayNumber)[0]?.label ?? '';
      setActiveInfo({ material, dayNumber, nextStepLabel });
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
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getAllPracticedDates } from '../lib/db';
import { calcStreak, learningDate } from '../lib/dates';
import { useMaterialsStore } from '../stores/useMaterialsStore';

export function TodayPage() {
  const { materials, loaded, refresh } = useMaterialsStore();
  const [streak, setStreak] = useState(0);
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

  const current = materials[0];

  return (
    <div className="flex flex-col gap-6 p-4">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-neutral-800">シャドとま</h1>
        <span className="rounded-full bg-tomato-100 px-3 py-1 text-sm font-semibold text-tomato-700">
          連続{streak}日
        </span>
      </header>

      {current ? (
        <section className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4">
          <p className="text-xs text-neutral-400">進行中の教材</p>
          <p className="text-base font-medium text-neutral-800">{current.title}</p>
          <button
            type="button"
            onClick={() => navigate(`/practice/${current.id}`)}
            className="rounded-full bg-tomato-500 px-4 py-3 text-sm font-semibold text-white active:bg-tomato-600"
          >
            練習をはじめる
          </button>
        </section>
      ) : (
        <section className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-neutral-300 p-6 text-center">
          <p className="text-sm text-neutral-500">まだ教材がありません</p>
          <Link to="/materials" className="rounded-full bg-tomato-500 px-4 py-2 text-sm font-semibold text-white">
            教材を追加する
          </Link>
        </section>
      )}
    </div>
  );
}

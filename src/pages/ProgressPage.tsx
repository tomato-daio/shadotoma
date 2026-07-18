import { useEffect, useState } from 'react';
import { getAllPracticedDates, getAllSubmissions } from '../lib/db';
import { calcStreak, learningDate } from '../lib/dates';

export function ProgressPage() {
  const [streak, setStreak] = useState(0);
  const [submissionCount, setSubmissionCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([getAllPracticedDates(), getAllSubmissions()]).then(([dates, submissions]) => {
      if (cancelled) return;
      setStreak(calcStreak(dates, learningDate(new Date())));
      setSubmissionCount(submissions.length);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-col gap-4 p-4">
      <h1 className="text-lg font-bold text-neutral-800">進捗</h1>
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-neutral-200 p-4 text-center">
          <p className="text-2xl font-bold text-tomato-600">{streak}</p>
          <p className="text-xs text-neutral-400">連続学習日数</p>
        </div>
        <div className="rounded-xl border border-neutral-200 p-4 text-center">
          <p className="text-2xl font-bold text-tomato-600">{submissionCount}</p>
          <p className="text-xs text-neutral-400">提出回数</p>
        </div>
      </div>
      <p className="text-xs text-neutral-400">カレンダー表示・スコア推移グラフはM3で実装予定です。</p>
    </div>
  );
}

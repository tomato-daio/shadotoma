import { useMemo, useState } from 'react';

export interface PracticeCalendarProps {
  /** 練習した学習日("YYYY-MM-DD")の一覧。 */
  practicedDates: string[];
}

const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatDateKey(year: number, month0: number, day: number): string {
  return `${year}-${pad2(month0 + 1)}-${pad2(day)}`;
}

/**
 * 練習日カレンダー（月表示、DESIGN.md §10 M3）。
 * 練習した学習日をマークする。前月/翌月に移動できるが、未来の月へは移動できない。
 */
export function PracticeCalendar({ practicedDates }: PracticeCalendarProps) {
  const practicedSet = useMemo(() => new Set(practicedDates), [practicedDates]);
  const [monthOffset, setMonthOffset] = useState(0);

  const today = new Date();
  const todayKey = formatDateKey(today.getFullYear(), today.getMonth(), today.getDate());

  const viewDate = new Date(today.getFullYear(), today.getMonth() + monthOffset, 1);
  const year = viewDate.getFullYear();
  const month0 = viewDate.getMonth();

  const firstWeekday = new Date(year, month0, 1).getDay();
  const daysInMonth = new Date(year, month0 + 1, 0).getDate();
  const cells: (number | null)[] = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setMonthOffset((o) => o - 1)}
          aria-label="前の月へ"
          className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-600 active:bg-neutral-100"
        >
          ←
        </button>
        <p className="text-sm font-medium text-neutral-700">
          {year}年{month0 + 1}月
        </p>
        <button
          type="button"
          onClick={() => setMonthOffset((o) => Math.min(0, o + 1))}
          disabled={monthOffset >= 0}
          aria-label="次の月へ"
          className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-600 disabled:opacity-30 active:bg-neutral-100"
        >
          →
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center text-[10px] text-neutral-400">
        {WEEKDAY_LABELS.map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {cells.map((day, i) => {
          if (day === null) return <span key={`empty-${i}`} />;
          const dateKey = formatDateKey(year, month0, day);
          const practiced = practicedSet.has(dateKey);
          const isToday = dateKey === todayKey;
          return (
            <div
              key={dateKey}
              className={`flex aspect-square items-center justify-center rounded-full text-xs ${
                practiced ? 'bg-tomato-500 font-semibold text-white' : 'text-neutral-500'
              } ${isToday && !practiced ? 'border border-tomato-400' : ''}`}
            >
              {day}
            </div>
          );
        })}
      </div>
    </div>
  );
}

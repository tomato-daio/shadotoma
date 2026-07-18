import type { WordMark } from '../../lib/align';
import type { JudgeResult } from '../../lib/db';

export interface JudgeResultViewProps {
  judge: JudgeResult;
  /** 前回提出のmatchRate。指定時は前回比を表示する。 */
  previousMatchRate?: number;
  className?: string;
}

/**
 * 判定結果画面（DESIGN.md §8手順7）。
 * 色分けスクリプト（ok=緑/missed=赤/sub=黄）、matchRate・WPM、Good/Development Points、
 * 前回提出との比較を表示する。
 */
export function JudgeResultView({ judge, previousMatchRate, className = '' }: JudgeResultViewProps) {
  const matchRatePercent = Math.round(judge.matchRate * 100);
  const deltaPercent =
    previousMatchRate !== undefined ? Math.round((judge.matchRate - previousMatchRate) * 100) : null;

  return (
    <div className={`flex flex-col gap-4 ${className}`}>
      <div className="grid grid-cols-2 gap-3">
        <StatCard label="一致率" value={`${matchRatePercent}%`} />
        <StatCard label="速さ" value={`${Math.round(judge.wpm)} WPM`} />
      </div>

      {deltaPercent !== null ? (
        <p
          className={`rounded-md px-3 py-2 text-center text-xs font-medium ${
            deltaPercent >= 0 ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'
          }`}
        >
          前回比 {deltaPercent >= 0 ? `+${deltaPercent}` : deltaPercent}pt
        </p>
      ) : null}

      <section className="flex flex-col gap-2">
        <p className="text-xs font-medium text-neutral-500">
          添削結果（<span className="text-green-700">緑</span>=正解 / <span className="text-red-600">赤</span>
          =聞き取れず / <span className="text-amber-600">黄</span>=別の語）
        </p>
        <ColoredScript wordMarks={judge.wordMarks} />
      </section>

      <PointsList title="Good Points" points={judge.goodPoints} tone="good" />
      <PointsList title="Development Points" points={judge.devPoints} tone="dev" />
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-neutral-200 p-3 text-center">
      <p className="text-xl font-bold text-tomato-600">{value}</p>
      <p className="text-xs text-neutral-400">{label}</p>
    </div>
  );
}

const STATUS_CLASS: Record<WordMark['status'], string> = {
  ok: 'text-green-700',
  missed: 'text-red-600 line-through decoration-red-300',
  sub: 'text-amber-600 font-semibold underline decoration-amber-300',
};

function ColoredScript({ wordMarks }: { wordMarks: WordMark[] }) {
  if (wordMarks.length === 0) {
    return <p className="text-xs text-neutral-400">スクリプトがありません</p>;
  }

  // 文index(si)ごとに改行して読みやすくする
  const bySentence = new Map<number, WordMark[]>();
  for (const mark of wordMarks) {
    const list = bySentence.get(mark.si) ?? [];
    list.push(mark);
    bySentence.set(mark.si, list);
  }

  return (
    <div className="max-h-52 overflow-y-auto rounded-lg bg-neutral-50 p-3 text-sm leading-relaxed">
      {[...bySentence.entries()].map(([si, marks]) => (
        <p key={si} className="mb-1">
          {marks.map((m, i) => (
            <span key={i} className={STATUS_CLASS[m.status]}>
              {m.word}{' '}
            </span>
          ))}
        </p>
      ))}
    </div>
  );
}

function PointsList({ title, points, tone }: { title: string; points: string[]; tone: 'good' | 'dev' }) {
  const toneClass = tone === 'good' ? 'border-green-200 bg-green-50/60' : 'border-amber-200 bg-amber-50/60';
  const titleClass = tone === 'good' ? 'text-green-700' : 'text-amber-700';
  return (
    <section className={`flex flex-col gap-2 rounded-lg border p-3 ${toneClass}`}>
      <p className={`text-sm font-semibold ${titleClass}`}>{title}</p>
      <ul className="flex flex-col gap-1.5 text-xs text-neutral-700">
        {points.map((p, i) => (
          <li key={i} className="flex gap-1.5">
            <span className={titleClass}>・</span>
            <span>{p}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

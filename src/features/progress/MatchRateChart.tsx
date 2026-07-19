export interface MatchRateChartPoint {
  date: string;
  matchRate: number;
  /** Azure発音評価の総合スコア(0-100)。DESIGN.md §8c: 未実行の提出ではundefined。 */
  pronScore?: number;
}

export interface MatchRateChartProps {
  /** 提出日時の昇順(古い→新しい)に並んだ、judge結果を持つ提出のみの一致率推移。 */
  points: MatchRateChartPoint[];
}

const WIDTH = 300;
const HEIGHT = 96;
const PADDING = 10;
/** マンネリ防止の早期提案しきい値（DESIGN.md §4）。参考ラインとして表示する。 */
const SUGGEST_THRESHOLD = 0.85;
const PRON_SCORE_COLOR = '#3b82f6';

/**
 * matchRate推移の簡易折れ線グラフ（DESIGN.md §10 M3: 依存追加禁止のためSVG手書き）。
 * DESIGN.md §8c(M9): Azure発音評価が実行された提出があれば、pronScore(0-100を0-1に換算)を
 * 第2系列として同じx軸(=同じpointsの並び)上に重ねて表示する（凡例付き）。
 */
export function MatchRateChart({ points }: MatchRateChartProps) {
  if (points.length === 0) {
    return <p className="text-xs text-neutral-400">まだ添削結果がありません。提出すると推移が表示されます。</p>;
  }

  if (points.length === 1) {
    return (
      <p className="text-xs text-neutral-500">
        直近の一致率: {Math.round(points[0].matchRate * 100)}%（推移の表示には2回以上の提出が必要です）
      </p>
    );
  }

  const innerW = WIDTH - PADDING * 2;
  const innerH = HEIGHT - PADDING * 2;
  const xAt = (i: number) => PADDING + (i / (points.length - 1)) * innerW;
  const yAtRatio = (ratio: number) => PADDING + (1 - Math.min(1, Math.max(0, ratio))) * innerH;

  const coords = points.map((p, i) => ({ x: xAt(i), y: yAtRatio(p.matchRate) }));
  const pathD = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
  const thresholdY = PADDING + (1 - SUGGEST_THRESHOLD) * innerH;

  const pronCoords = points
    .map((p, i) => (typeof p.pronScore === 'number' ? { x: xAt(i), y: yAtRatio(p.pronScore / 100) } : null))
    .filter((c): c is { x: number; y: number } => c !== null);
  const pronPathD =
    pronCoords.length > 1
      ? pronCoords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ')
      : null;

  return (
    <div className="flex flex-col gap-1">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full" role="img" aria-label="一致率の推移グラフ">
        <line
          x1={PADDING}
          y1={thresholdY}
          x2={WIDTH - PADDING}
          y2={thresholdY}
          stroke="#fca5a5"
          strokeWidth={1}
          strokeDasharray="3,3"
        />
        {pronPathD ? <path d={pronPathD} fill="none" stroke={PRON_SCORE_COLOR} strokeWidth={2} strokeDasharray="4,2" /> : null}
        {pronCoords.map((c, i) => (
          <circle key={`pron-${i}`} cx={c.x} cy={c.y} r={2} fill={PRON_SCORE_COLOR} />
        ))}
        <path d={pathD} fill="none" stroke="#e0473f" strokeWidth={2} />
        {coords.map((c, i) => (
          <circle key={i} cx={c.x} cy={c.y} r={2.5} fill="#e0473f" />
        ))}
      </svg>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3 text-[10px] text-neutral-500">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: '#e0473f' }} />
            一致率
          </span>
          {pronCoords.length > 0 ? (
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: PRON_SCORE_COLOR }} />
              発音スコア(Azure)
            </span>
          ) : null}
        </div>
        <p className="text-right text-[10px] text-neutral-400">点線: 次教材提案の目安（{SUGGEST_THRESHOLD * 100}%）</p>
      </div>
    </div>
  );
}

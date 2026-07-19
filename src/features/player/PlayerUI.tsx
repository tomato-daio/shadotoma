import { useEffect, useState } from 'react';
import { ScriptView } from '../../components/ScriptView';
import { formatTime } from '../../lib/audio';
import type { JudgeResult, Sentence } from '../../lib/db';
import { RATE_MAX, RATE_MIN, RATE_PRESETS, RATE_STEP } from './AudioPlayer';
import { usePlayer } from './usePlayer';

export interface PlayerUIProps {
  src: string;
  sentences: Sentence[];
  /** スクリプトの初期表示状態（ステップに応じて呼び出し側から指定できる）。 */
  initialScriptVisible?: boolean;
  /** ループ回数の目安（例: オーバーラッピング10回）。指定時は「3 / 10回」のように表示する。 */
  loopTarget?: number | null;
  /** ループ完了回数が変化するたびに呼び出す（ウィザード側でステップ完了時の回数を記録するため）。 */
  onLoopCountChange?: (count: number) => void;
  /** この教材の直近の判定結果。指定時はスクリプトに前回のできた/できなかった箇所を重ねる。 */
  previousJudge?: JudgeResult;
  className?: string;
}

export function PlayerUI({
  src,
  sentences,
  initialScriptVisible = true,
  loopTarget = null,
  onLoopCountChange,
  previousJudge,
  className = '',
}: PlayerUIProps) {
  const player = usePlayer(src);
  const [scriptVisible, setScriptVisible] = useState(initialScriptVisible);

  const { a, b } = player.abPoints;

  useEffect(() => {
    onLoopCountChange?.(player.loopCount);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player.loopCount]);

  return (
    <div className={`flex flex-col gap-4 ${className}`}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-tomato-700">
          ループ再生: {player.loopCount}
          {loopTarget ? ` / ${loopTarget}` : ''}回
        </span>
        <button
          type="button"
          onClick={() => setScriptVisible((v) => !v)}
          className="rounded-full border border-tomato-300 px-3 py-1 text-xs font-medium text-tomato-600 active:bg-tomato-50"
        >
          スクリプト{scriptVisible ? 'を隠す' : 'を表示'}
        </button>
      </div>

      {/* 非表示時もアンマウントせずCSSで隠す（ScriptView内の「訳・語彙」「前回の添削」トグル状態を保持するため）。 */}
      <ScriptView sentences={sentences} previousJudge={previousJudge} className={scriptVisible ? '' : 'hidden'} />
      {!scriptVisible ? (
        <div className="rounded-lg bg-neutral-50 p-3 text-center text-sm text-neutral-400">
          スクリプト非表示中（音だけを頼りに聴いてみましょう）
        </div>
      ) : null}

      {/* シークバー */}
      <div className="flex flex-col gap-1">
        <input
          type="range"
          min={0}
          max={player.duration || 0}
          step={0.1}
          value={Math.min(player.currentTime, player.duration || 0)}
          onChange={(e) => player.seek(Number(e.target.value))}
          className="w-full accent-tomato-500"
          aria-label="再生位置"
        />
        <div className="flex justify-between text-xs text-neutral-500">
          <span>{formatTime(player.currentTime)}</span>
          <span>{formatTime(player.duration)}</span>
        </div>
      </div>

      {/* 再生コントロール */}
      <div className="flex items-center justify-center gap-4">
        <button
          type="button"
          onClick={player.rewind}
          className="rounded-full border border-neutral-300 px-4 py-2 text-sm active:bg-neutral-100"
          aria-label="3秒巻き戻し"
        >
          ⟲ 3秒
        </button>
        <button
          type="button"
          onClick={player.toggle}
          className="rounded-full bg-tomato-500 px-6 py-3 text-base font-semibold text-white active:bg-tomato-600"
        >
          {player.isPlaying ? '一時停止' : '再生'}
        </button>
      </div>

      {/* 速度 */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between text-sm text-neutral-600">
          <span>速度</span>
          <span className="font-mono">{player.rate.toFixed(2)}x</span>
        </div>
        <div className="flex gap-2">
          {RATE_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => player.setRate(preset)}
              className={`flex-1 rounded-md border px-2 py-1 text-xs ${
                Math.abs(player.rate - preset) < 0.001
                  ? 'border-tomato-500 bg-tomato-500 text-white'
                  : 'border-neutral-300 text-neutral-600'
              }`}
            >
              {preset}x
            </button>
          ))}
        </div>
        <input
          type="range"
          min={RATE_MIN}
          max={RATE_MAX}
          step={RATE_STEP}
          value={player.rate}
          onChange={(e) => player.setRate(Number(e.target.value))}
          className="w-full accent-tomato-500"
          aria-label="再生速度スライダー"
        />
      </div>

      {/* ABリピート */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between text-sm text-neutral-600">
          <span>ABリピート</span>
          <span className="font-mono text-xs">
            A: {a === null ? '--:--' : formatTime(a)} / B: {b === null ? '--:--' : formatTime(b)}
          </span>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={player.setPointA}
            className="flex-1 rounded-md border border-neutral-300 px-2 py-2 text-sm active:bg-neutral-100"
          >
            A設定
          </button>
          <button
            type="button"
            onClick={player.setPointB}
            className="flex-1 rounded-md border border-neutral-300 px-2 py-2 text-sm active:bg-neutral-100"
          >
            B設定
          </button>
          <button
            type="button"
            onClick={player.clearAB}
            disabled={a === null && b === null}
            className="flex-1 rounded-md border border-neutral-300 px-2 py-2 text-sm text-neutral-500 disabled:opacity-40 active:bg-neutral-100"
          >
            解除
          </button>
        </div>
      </div>
    </div>
  );
}

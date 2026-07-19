import type { JudgeResult } from '../../lib/db';
import { JudgeResultView } from './JudgeResultView';

export type JudgeRunStatus = 'idle' | 'model-download' | 'transcribing' | 'azure-scoring' | 'done' | 'error';

export interface SubmissionResultPanelProps {
  status: JudgeRunStatus;
  /** model-downloadフェーズの進捗（0〜1）。不明な場合はnull。 */
  progress: number | null;
  error: string | null;
  judge: JudgeResult | null;
  previousMatchRate?: number;
  /** Whisperが聴き取った書き起こし（M8: JudgeResultViewの「あなたの発話」表示に渡す）。 */
  transcript?: string;
  onCopyFallback: () => void;
  fallbackCopied: boolean;
  className?: string;
}

const STATUS_LABEL: Record<'model-download' | 'transcribing' | 'azure-scoring', string> = {
  'model-download': 'AIモデルをダウンロード中…（初回のみ・数十MB）',
  transcribing: '文字起こし中…',
  // Azure発音評価（DESIGN.md §8c・M9）: appStateにキーが設定されている場合のみ、
  // Whisper採点の後にこのフェーズへ進む。
  'azure-scoring': '発音スコア取得中…',
};

/**
 * 提出後の添削処理の状態を表示するパネル（DESIGN.md §8）。
 * モデルDL中/文字起こし中の進捗表示、失敗時のフォールバックボタン、完了時の判定結果を出し分ける。
 */
export function SubmissionResultPanel({
  status,
  progress,
  error,
  judge,
  previousMatchRate,
  transcript,
  onCopyFallback,
  fallbackCopied,
  className = '',
}: SubmissionResultPanelProps) {
  if (status === 'idle') return null;

  if (status === 'model-download' || status === 'transcribing' || status === 'azure-scoring') {
    return (
      <div className={`flex flex-col gap-2 rounded-lg border border-neutral-200 p-4 text-center ${className}`}>
        <p className="text-sm text-neutral-600">{STATUS_LABEL[status]}</p>
        {status === 'model-download' ? (
          <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-100" aria-label="モデルダウンロード進捗">
            <div
              className="h-full bg-tomato-500 transition-[width] duration-150"
              style={{ width: `${Math.round((progress ?? 0) * 100)}%` }}
            />
          </div>
        ) : (
          <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-100">
            <div className="h-full w-1/3 animate-pulse bg-tomato-400" />
          </div>
        )}
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className={`flex flex-col gap-3 rounded-lg border border-red-200 bg-red-50 p-4 ${className}`}>
        <p className="text-sm text-red-700">
          添削に失敗しました{error ? `（${error}）` : ''}。録音は保存されています。
        </p>
        <button
          type="button"
          onClick={onCopyFallback}
          className="rounded-md bg-neutral-800 px-3 py-2 text-sm font-semibold text-white active:bg-neutral-700"
        >
          {fallbackCopied ? 'コピーしました' : 'AIに詳しく添削してもらう（プロンプトをコピー）'}
        </button>
      </div>
    );
  }

  if (status === 'done' && judge) {
    return (
      <JudgeResultView
        judge={judge}
        previousMatchRate={previousMatchRate}
        transcript={transcript}
        className={className}
      />
    );
  }

  return null;
}

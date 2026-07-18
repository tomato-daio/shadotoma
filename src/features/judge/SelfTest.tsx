import { useState } from 'react';
import { alignWords, buildScriptWords } from '../../lib/align';
import { decodeToMono16k } from '../../lib/audio';
import type { Material } from '../../lib/db';
import { computeMatchRate } from '../../lib/feedback';
import { transcribeAudio, type WhisperProgressEvent } from './whisper';

/** お手本音声を自己添削した場合の合格ライン（DESIGN.md §10 M3-7: matchRate>0.8が期待値）。 */
export const SELF_TEST_PASS_THRESHOLD = 0.8;

type SelfTestStatus = 'idle' | 'running' | 'done' | 'error';

interface SelfTestState {
  status: SelfTestStatus;
  phase?: WhisperProgressEvent['phase'];
  progress?: number;
  matchRate?: number;
  materialTitle?: string;
  error?: string;
}

export interface SelfTestProps {
  materials: Material[];
}

/**
 * 自己テスト対象の教材を選ぶ: bundled(VOA)教材のうち再生時間が最も短いもの
 * （実行時間を抑えるため）。bundled教材がまだ同期されていない場合はnull。
 */
function pickSelfTestMaterial(materials: Material[]): Material | null {
  const candidates = materials.filter((m) => m.source === 'voa' && m.audioUrl);
  if (candidates.length === 0) return null;
  return candidates.reduce((shortest, m) =>
    (m.durationSec ?? Infinity) < (shortest.durationSec ?? Infinity) ? m : shortest,
  );
}

const PHASE_LABEL: Record<WhisperProgressEvent['phase'], string> = {
  'model-download': 'モデルDL中',
  transcribing: '文字起こし中',
};

/**
 * 添削エンジン自己テスト（DESIGN.md §10 M3-7・検収用）。
 * bundled教材のお手本mp3自体をWhisperにかけ、その教材自身のスクリプトとアラインしてmatchRateを
 * 表示する。お手本音声を対象にしているためmatchRateが高くなるはずで、これが検収の合否基準になる。
 */
export function SelfTest({ materials }: SelfTestProps) {
  const [state, setState] = useState<SelfTestState>({ status: 'idle' });

  const run = async () => {
    const material = pickSelfTestMaterial(materials);
    if (!material || !material.audioUrl) {
      setState({
        status: 'error',
        error: '対象のbundled教材が見つかりません。先に「教材」タブを開いて教材を同期してください。',
      });
      return;
    }

    setState({ status: 'running', materialTitle: material.title });
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}${material.audioUrl}`);
      if (!res.ok) throw new Error(`音声の取得に失敗しました (HTTP ${res.status})`);
      const blob = await res.blob();

      const pcm = await decodeToMono16k(blob);
      const transcript = await transcribeAudio(pcm, (event) => {
        setState((s) => ({ ...s, phase: event.phase, progress: event.progress }));
      });

      const scriptWords = buildScriptWords(material.sentences);
      const recognizedWords = transcript.length > 0 ? transcript.split(/\s+/).filter(Boolean) : [];
      const { wordMarks } = alignWords(scriptWords, recognizedWords);
      const matchRate = computeMatchRate(wordMarks);

      setState({ status: 'done', matchRate, materialTitle: material.title });
    } catch (err) {
      setState({
        status: 'error',
        materialTitle: material.title,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => void run()}
        disabled={state.status === 'running'}
        className="rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-700 disabled:opacity-50"
      >
        {state.status === 'running' ? '実行中…' : '添削エンジン自己テストを実行'}
      </button>
      <p className="text-xs text-neutral-400">
        bundled教材のお手本音声そのものをWhisperで文字起こしし、教材自身のスクリプトとアラインして
        matchRateを表示します。お手本音声なので matchRate &gt; {SELF_TEST_PASS_THRESHOLD * 100}% が期待値です。
      </p>

      {state.status === 'running' ? (
        <p className="text-xs text-neutral-500">
          [{state.materialTitle}]{' '}
          {state.phase
            ? `${PHASE_LABEL[state.phase]}${
                state.phase === 'model-download' && state.progress !== undefined
                  ? ` ${Math.round(state.progress * 100)}%`
                  : ''
              }`
            : '準備中…'}
        </p>
      ) : null}

      {state.status === 'done' && state.matchRate !== undefined ? (
        <p
          className={`text-sm font-semibold ${
            state.matchRate > SELF_TEST_PASS_THRESHOLD ? 'text-green-700' : 'text-red-600'
          }`}
        >
          [{state.materialTitle}] matchRate = {(state.matchRate * 100).toFixed(1)}% (
          {state.matchRate > SELF_TEST_PASS_THRESHOLD ? '合格' : '要確認'})
        </p>
      ) : null}

      {state.status === 'error' ? <p className="text-xs text-red-600">エラー: {state.error}</p> : null}
    </div>
  );
}

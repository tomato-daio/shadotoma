import { useState } from 'react';
import { alignWords, buildScriptWords } from '../../lib/align';
import { decodeToMono16k, WHISPER_SAMPLE_RATE } from '../../lib/audio';
import type { Material } from '../../lib/db';
import { transcribeAudio, type WhisperProgressEvent } from './whisper';

/** 自己テストで文字起こしする冒頭部分の長さ（秒）。実行時間短縮のため全音声ではなくここだけを使う。 */
const SELF_TEST_CLIP_SEC = 60;

/**
 * 自己テストの合否閾値（DESIGN.md §10 M3-7: precision>0.8が期待値）。
 * 冒頭60秒だけを文字起こしするため、スクリプト全体に対するmatchRate（recall）は使えない
 * （後半が丸ごとmissed扱いになり必ず低く出てしまう）。代わりに「認識できた語のうち、
 * スクリプトと正しく整列した語の割合」= precision（sub含めず: ok数/認識語数）を使う。
 */
export const SELF_TEST_PASS_THRESHOLD = 0.8;

type SelfTestStatus = 'idle' | 'running' | 'done' | 'error';

interface SelfTestState {
  status: SelfTestStatus;
  phase?: WhisperProgressEvent['phase'];
  progress?: number;
  precision?: number;
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
 * bundled教材のお手本mp3自体の冒頭60秒（SELF_TEST_CLIP_SEC）だけをWhisperにかけ、その教材自身の
 * スクリプトとアラインしてprecision（認識できた語のうちスクリプトと正しく整列した割合）を表示する。
 * お手本音声を対象にしているためprecisionが高くなるはずで、これが検収の合否基準になる。
 * 全音声（数分）を処理すると自己テストだけで数分かかるため、冒頭部分のみに絞って実行時間を抑えている。
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

      const fullPcm = await decodeToMono16k(blob);
      // 冒頭SELF_TEST_CLIP_SEC秒だけを文字起こし対象にする（実行時間短縮のため）。
      const clipLength = Math.min(fullPcm.length, WHISPER_SAMPLE_RATE * SELF_TEST_CLIP_SEC);
      const pcm = fullPcm.slice(0, clipLength);

      const transcript = await transcribeAudio(pcm, (event) => {
        setState((s) => ({ ...s, phase: event.phase, progress: event.progress }));
      });

      const scriptWords = buildScriptWords(material.sentences);
      const recognizedWords = transcript.length > 0 ? transcript.split(/\s+/).filter(Boolean) : [];
      // 冒頭部分だけの文字起こしなのでスクリプト全体に対するmatchRate（recall）は使えない
      // （後半は必ずmissedになり不当に低く出る）。認識語数を分母にしたprecisionを使う。
      const { matchedCount } = alignWords(scriptWords, recognizedWords);
      const precision = recognizedWords.length > 0 ? matchedCount / recognizedWords.length : 0;

      setState({ status: 'done', precision, materialTitle: material.title });
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
        bundled教材のお手本音声の冒頭{SELF_TEST_CLIP_SEC}秒だけをWhisperで文字起こしし、教材自身の
        スクリプトとアラインしてprecision（認識語のうちスクリプトと整列一致した割合）を表示します。
        冒頭{SELF_TEST_CLIP_SEC}秒で判定するため、お手本音声なら precision &gt; {SELF_TEST_PASS_THRESHOLD * 100}% が期待値です。
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

      {state.status === 'done' && state.precision !== undefined ? (
        <p
          className={`text-sm font-semibold ${
            state.precision > SELF_TEST_PASS_THRESHOLD ? 'text-green-700' : 'text-red-600'
          }`}
        >
          [{state.materialTitle}] precision(冒頭{SELF_TEST_CLIP_SEC}秒) = {(state.precision * 100).toFixed(1)}% (
          {state.precision > SELF_TEST_PASS_THRESHOLD ? '合格' : '要確認'})
        </p>
      ) : null}

      {state.status === 'error' ? <p className="text-xs text-red-600">エラー: {state.error}</p> : null}
    </div>
  );
}

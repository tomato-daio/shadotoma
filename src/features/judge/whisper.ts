/**
 * transformers.js（@huggingface/transformers）を用いたWhisper文字起こしラッパー
 * （DESIGN.md §8手順2）。
 *
 * - モデル: `onnx-community/whisper-tiny.en`（量子化版）
 * - デバイス: 常にWASM（下記コメント参照）
 * - モデルは初回ダウンロード後、transformers.jsが内部でCache APIへキャッシュするため、
 *   2回目以降はネットワークアクセスなしで読み込める
 *
 * モデルのロード・実行はブラウザ環境専用（Web Audio API・WebGPU等に依存する箇所は無いが、
 * transformers.jsのONNX Runtime WebバックエンドはNode環境では別バックエンドを使うため、
 * このモジュール自体はブラウザでの動作を前提とする）。
 */

import { env, pipeline, type AutomaticSpeechRecognitionPipeline, type ProgressInfo } from '@huggingface/transformers';

export const WHISPER_MODEL_ID = 'onnx-community/whisper-tiny.en';

export type WhisperProgressPhase = 'model-download' | 'transcribing';

export interface WhisperProgressEvent {
  phase: WhisperProgressPhase;
  /** model-downloadの場合のみ、0〜1のおおよその進捗（複数ファイルの合算はしない簡易実装）。 */
  progress?: number;
}

export type WhisperProgressCallback = (event: WhisperProgressEvent) => void;

let cachedPipelinePromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null;

function toProgressEvent(info: ProgressInfo): WhisperProgressEvent | null {
  if (info.status === 'progress' && 'progress' in info && typeof info.progress === 'number') {
    // transformers.jsのprogressは0-100（%）。UI側は0-1で扱う。
    return { phase: 'model-download', progress: Math.min(1, Math.max(0, info.progress / 100)) };
  }
  return null;
}

/**
 * Whisperパイプラインを取得する（プロセス内で1回だけ構築し、以降は使い回す）。
 * モデルダウンロードの進捗は `onProgress` へ通知する。
 */
async function getPipeline(onProgress?: WhisperProgressCallback): Promise<AutomaticSpeechRecognitionPipeline> {
  if (!cachedPipelinePromise) {
    // device判定は行わず常に'wasm'+'q8'を使う。
    // WebGPU選択時もdtype:'q8'固定になってしまい、onnxruntime-webのWebGPU実行プロバイダには
    // int8量子化カーネル（MatMulInteger等）が実装されていないため、webgpuデバイスは
    // モデル構築・推論が失敗し続ける（wasmへの自動フォールバックも存在しない）。
    // 将来WebGPUを使う場合は、量子化なし（dtype:'fp32'）またはfp16版モデルとセットで
    // 別途対応すること（q8のままdeviceだけwebgpuに変えても動かない）。
    cachedPipelinePromise = pipeline('automatic-speech-recognition', WHISPER_MODEL_ID, {
      device: 'wasm',
      dtype: 'q8',
      progress_callback: (info: ProgressInfo) => {
        const event = toProgressEvent(info);
        if (event) onProgress?.(event);
      },
    }).catch((err: unknown) => {
      // 失敗時は次回リトライできるようキャッシュをクリアする
      cachedPipelinePromise = null;
      throw err;
    });
  }
  return cachedPipelinePromise;
}

/**
 * 16kHzモノラルのFloat32Array音声をWhisperで文字起こしする。
 * 60秒を超える音声にも対応できるよう、内部でチャンク分割（chunk_length_s）を行う。
 */
export async function transcribeAudio(pcm: Float32Array, onProgress?: WhisperProgressCallback): Promise<string> {
  const transcriber = await getPipeline(onProgress);
  onProgress?.({ phase: 'transcribing' });

  const output = await transcriber(pcm, { chunk_length_s: 30, stride_length_s: 5 });
  const result = Array.isArray(output) ? output[0] : output;
  return result?.text?.trim() ?? '';
}

/** テスト・エラーリカバリ用: キャッシュ済みパイプラインを破棄する。 */
export function resetWhisperPipeline(): void {
  cachedPipelinePromise = null;
}

/** モデルの状態確認用。env経由でCache APIの利用可否などを外部公開する（デバッグ表示に使う）。 */
export function isBrowserCacheAvailable(): boolean {
  return env.useBrowserCache !== false && typeof caches !== 'undefined';
}

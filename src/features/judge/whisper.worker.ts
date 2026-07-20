/**
 * Whisper文字起こしを実行するmodule worker（DESIGN.md §8手順2）。
 *
 * transformers.js（onnxruntime-web/WASM）でのモデル構築・推論は数分間メインスレッドを
 * ブロックしうるため、このワーカー内だけで完結させる。DOM/windowには一切触れない
 * （transformers.jsのenv設定が必要になった場合もこのファイル内で行うこと）。
 *
 * UIスレッド側とのやり取りは whisper.protocol.ts の型に従ったpostMessageのみ。
 * whisper.ts（クライアント）が1リクエスト=1id で呼び出し、進捗は複数回・結果/エラーは
 * 最後に1回だけ返す。
 */

import { pipeline, type AutomaticSpeechRecognitionPipeline, type ProgressInfo } from '@huggingface/transformers';
import type { WhisperProgressEvent, WhisperWorkerRequest, WhisperWorkerResponse } from './whisper.protocol';

let cachedPipelinePromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null;
/** 現在キャッシュ中のパイプラインが対応するモデルID（M8: モデル切替時の再構築判定に使う）。 */
let cachedModelId: string | null = null;

function toProgressEvent(info: ProgressInfo): WhisperProgressEvent | null {
  if (info.status === 'progress' && 'progress' in info && typeof info.progress === 'number') {
    // transformers.jsのprogressは0-100（%）。UI側は0-1で扱う。
    return { phase: 'model-download', progress: Math.min(1, Math.max(0, info.progress / 100)) };
  }
  return null;
}

/**
 * Whisperパイプラインを取得する（同一モデルIDの間はワーカーのプロセス内で1回だけ構築し、使い回す）。
 * M8: モデルIDが前回と異なる場合はパイプラインを作り直す（設定ページでのモデル切替に対応）。
 * 旧モデルのパイプラインは破棄してメモリを解放する。モデルダウンロードの進捗は `onProgress` へ通知する。
 */
async function getPipeline(
  modelId: string,
  onProgress: (event: WhisperProgressEvent) => void,
): Promise<AutomaticSpeechRecognitionPipeline> {
  if (!cachedPipelinePromise || cachedModelId !== modelId) {
    // モデル切替: 旧パイプラインは参照を手放す前にdisposeする（8GB RAM端末でbase+tinyの
    // 二重保持を避けるため）。dispose失敗は無視してよい（新パイプライン構築を妨げない）。
    if (cachedPipelinePromise) {
      void cachedPipelinePromise.then((p) => p.dispose()).catch(() => {});
    }
    // device: 'wasm' 固定。dtype: 'q4' 固定（q8を使わない理由の詳細は whisper.ts のコメント参照）。
    // WebGPU選択時もdtype:'q4'固定になってしまい、onnxruntime-webのWebGPU実行プロバイダには
    // 対応する量子化カーネルが無いため、webgpuデバイスはモデル構築・推論が失敗し続ける
    // （wasmへの自動フォールバックも存在しない）。将来WebGPUを使う場合は、量子化なし
    // （dtype:'fp32'）またはfp16版モデルとセットで別途対応すること。
    cachedModelId = modelId;
    cachedPipelinePromise = pipeline('automatic-speech-recognition', modelId, {
      device: 'wasm',
      dtype: 'q4',
      progress_callback: (info: ProgressInfo) => {
        const event = toProgressEvent(info);
        if (event) onProgress(event);
      },
    }).catch((err: unknown) => {
      // 失敗時は次回リトライできるようキャッシュをクリアする
      // （このリクエストの後に別モデルへ切り替わっていた場合は、そちらのキャッシュを消さない）
      if (cachedModelId === modelId) {
        cachedPipelinePromise = null;
        cachedModelId = null;
      }
      throw err;
    });
  }
  return cachedPipelinePromise;
}

/** transcribeリクエストを直列に処理するためのキュー（同一パイプラインの同時実行を避ける）。 */
let queue: Promise<void> = Promise.resolve();

function postResponse(response: WhisperWorkerResponse): void {
  self.postMessage(response);
}

/** return_timestamps:'word' 指定時にtransformers.jsが返すchunkの形（型定義が緩いため自前で受ける）。 */
interface RecognizedChunk {
  text?: string;
  timestamp?: [number | null, number | null];
}

async function handleTranscribe(
  id: number,
  pcm: Float32Array,
  modelId: string,
  wordTimestamps: boolean,
): Promise<void> {
  try {
    const transcriber = await getPipeline(modelId, (event) => postResponse({ type: 'progress', id, event }));
    postResponse({ type: 'progress', id, event: { phase: 'transcribing' } });

    if (wordTimestamps) {
      try {
        // chunk_length_s: 28 — transformers.js issue #1358（30秒ちょうどのチャンク境界で
        // wordタイムスタンプが壊れる）の回避。'word' はcross-attention(DTW)対応の
        // _timestamped モデルが必要（whisperModels.ts参照）。
        const output = await transcriber(pcm, { chunk_length_s: 28, stride_length_s: 5, return_timestamps: 'word' });
        const result = Array.isArray(output) ? output[0] : output;
        const chunks = (result as { chunks?: RecognizedChunk[] } | undefined)?.chunks;
        const words = Array.isArray(chunks)
          ? chunks
              .map((c) => ({
                word: (c.text ?? '').trim(),
                startSec: c.timestamp?.[0] ?? Number.NaN,
                endSec: c.timestamp?.[1] ?? c.timestamp?.[0] ?? Number.NaN,
              }))
              .filter((w) => w.word.length > 0)
          : undefined;
        postResponse({ type: 'result', id, text: result?.text?.trim() ?? '', words });
        return;
      } catch {
        // タイムスタンプ付き推論に失敗した場合は、下のタイムスタンプなし推論で1回だけ再試行する
        // （静かな縮退。呼び出し側はwords無しとして扱う）。
      }
    }

    // 60秒を超える音声にも対応できるよう、内部でチャンク分割（chunk_length_s）を行う。
    const output = await transcriber(pcm, { chunk_length_s: 30, stride_length_s: 5 });
    const result = Array.isArray(output) ? output[0] : output;
    postResponse({ type: 'result', id, text: result?.text?.trim() ?? '' });
  } catch (err) {
    postResponse({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
  }
}

self.onmessage = (ev: MessageEvent<WhisperWorkerRequest>) => {
  const msg = ev.data;
  if (msg.type === 'transcribe') {
    // 直前のリクエストの完了を待ってから処理する（結果が返る順序も呼び出し順のまま維持される）。
    queue = queue.then(() => handleTranscribe(msg.id, msg.pcm, msg.modelId, msg.wordTimestamps === true));
  }
};

/**
 * transformers.js（@huggingface/transformers）を用いたWhisper文字起こしのクライアント側ラッパー
 * （DESIGN.md §8手順2）。
 *
 * - モデル: `onnx-community/whisper-tiny.en`（量子化版）
 * - デバイス: 常にWASM。dtype: 'q4' 固定（理由は下記コメント参照）
 * - モデルは初回ダウンロード後、transformers.jsが内部でCache APIへキャッシュするため、
 *   2回目以降はネットワークアクセスなしで読み込める
 *
 * 実際のモデル構築・推論は `whisper.worker.ts`（module worker）内で行われる。
 * ONNX Runtime WebのWASM実行は数分間ブロッキングになりうるため、メインスレッド
 * （UIスレッド）で直接実行するとページ全体がフリーズし、iPhone Safari等では
 * 無応答ページとして強制終了されることがあった。そのため文字起こし処理一式を
 * ワーカーへ隔離し、このファイルはワーカーとのpostMessageベースの通信のみを担う
 * （UIスレッドをブロックしないことを、処理そのものが別スレッドで動くことによって保証する）。
 *
 * 公開APIは従来のメインスレッド直接実行版と同じ（transcribeAudio / resetWhisperPipeline等）で、
 * 呼び出し元（runJudge.ts / SelfTest.tsx）は変更不要。
 */

import type { WhisperProgressEvent, WhisperWorkerRequest, WhisperWorkerResponse } from './whisper.protocol';

export const WHISPER_MODEL_ID = 'onnx-community/whisper-tiny.en';

export type { WhisperProgressPhase, WhisperProgressEvent } from './whisper.protocol';
export type WhisperProgressCallback = (event: WhisperProgressEvent) => void;

interface PendingRequest {
  resolve: (text: string) => void;
  reject: (err: unknown) => void;
  onProgress?: WhisperProgressCallback;
}

let worker: Worker | null = null;
let requestSeq = 0;
const pending = new Map<number, PendingRequest>();

/** ワーカーを破棄し、進行中の全リクエストを失敗させる（再試行は呼び出し側の責務）。 */
function terminateWorker(reason: string): void {
  worker?.terminate();
  worker = null;
  const failures = Array.from(pending.values());
  pending.clear();
  for (const req of failures) {
    req.reject(new Error(reason));
  }
}

/** ワーカーをシングルトンで取得する。存在しない場合のみ新規生成する。 */
function getWorker(): Worker {
  if (worker) return worker;

  // Vite標準のmodule worker生成パターン（追加の依存なしでバンドル対応される）。
  const w = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' });

  w.onmessage = (ev: MessageEvent<WhisperWorkerResponse>) => {
    const msg = ev.data;
    const req = pending.get(msg.id);
    if (!req) return; // 既にterminate等でクリアされたリクエスト

    if (msg.type === 'progress') {
      req.onProgress?.(msg.event);
      return;
    }

    if (msg.type === 'result') {
      pending.delete(msg.id);
      req.resolve(msg.text);
    } else {
      // ワーカー内でのエラー（モデルDL失敗・推論エラー等）。
      // ここではpending.deleteしない: このリクエスト自身もterminateWorker内のreject対象に
      // 含める必要があるため（先に消してしまうとこのリクエストのPromiseが永遠に解決しなくなる）。
      // ワーカーごと破棄し、次回呼び出し時に再生成させることでリトライ可能にする。
      terminateWorker(msg.message);
    }
  };

  w.onerror = (ev: ErrorEvent) => {
    // postMessageによるエラー通知を経由しない、ワーカー自体の異常終了（読み込み失敗等）。
    terminateWorker(ev.message || 'Whisperワーカーで不明なエラーが発生しました');
  };

  worker = w;
  return w;
}

/**
 * 16kHzモノラルのFloat32Array音声をWhisperで文字起こしする。
 * 実処理はワーカーに委譲され、完了・進捗はpostMessage経由で受け取る。
 * pcmはtransferable（ArrayBuffer所有権譲渡）で渡すため、呼び出し後にpcmを再利用しないこと。
 */
export function transcribeAudio(pcm: Float32Array, onProgress?: WhisperProgressCallback): Promise<string> {
  const w = getWorker();
  const id = ++requestSeq;

  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    const message: WhisperWorkerRequest = { type: 'transcribe', id, pcm };
    try {
      w.postMessage(message, [pcm.buffer]);
    } catch (err) {
      pending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** テスト・エラーリカバリ用: ワーカーごと破棄し、次回呼び出し時に再生成させる。 */
export function resetWhisperPipeline(): void {
  terminateWorker('resetWhisperPipelineによりリセットされました');
}

/** モデルの状態確認用。Cache APIの利用可否を外部公開する（デバッグ表示に使う）。 */
export function isBrowserCacheAvailable(): boolean {
  return typeof caches !== 'undefined';
}

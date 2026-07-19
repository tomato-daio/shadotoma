/**
 * whisper.ts（UIスレッド側クライアント）と whisper.worker.ts（Web Worker側）の間で
 * やり取りするメッセージ型。DOM/window/ワーカー固有APIに依存しない純粋な型のみを置く
 * （どちらの側からも安全にimportできるようにするため）。
 */

export type WhisperProgressPhase = 'model-download' | 'transcribing';

export interface WhisperProgressEvent {
  phase: WhisperProgressPhase;
  /** model-downloadの場合のみ、0〜1のおおよその進捗（複数ファイルの合算はしない簡易実装）。 */
  progress?: number;
}

/** UIスレッド → ワーカー */
export interface WhisperTranscribeRequest {
  type: 'transcribe';
  /** リクエストごとの連番。ワーカーからの応答をどのリクエストに紐付けるかの識別に使う。 */
  id: number;
  /** 16kHzモノラルPCM。呼び出し側からtransferable（ArrayBuffer所有権譲渡）で受け渡される想定。 */
  pcm: Float32Array;
  /**
   * 使用するWhisperモデルID（M8: 設定ページで切替可能。whisperModels.tsのWHISPER_MODEL_IDSの値）。
   * ワーカーはappState/IndexedDBに触れないため、UIスレッド側で解決済みの文字列を必ず渡す。
   */
  modelId: string;
}

export type WhisperWorkerRequest = WhisperTranscribeRequest;

/** ワーカー → UIスレッド */
export type WhisperWorkerResponse =
  | { type: 'progress'; id: number; event: WhisperProgressEvent }
  | { type: 'result'; id: number; text: string }
  | { type: 'error'; id: number; message: string };

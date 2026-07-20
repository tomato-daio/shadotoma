/**
 * Whisperモデル選択（DESIGN.md §8手順2「モデル選択（M8）」）。
 *
 * 設定ページで「高精度（base.en・初期値）/ 標準（tiny.en・高速）」を切り替え、選択値は
 * appState（key: 'whisperModel'）へ保存する。判定（runJudge）と自己テスト（SelfTest）の
 * 双方がここを参照してワーカーへモデルIDを渡す。
 *
 * whisper.worker.ts はDOM/IndexedDBに触れない設計のため、appStateの解決は必ず
 * UIスレッド側（このモジュールの関数）で行い、ワーカーへは解決済みのモデルID文字列だけを渡す。
 */

import { getAppState, setAppState } from '../../lib/db';

export type WhisperModelKey = 'high' | 'fast';

export const WHISPER_MODEL_IDS: Record<WhisperModelKey, string> = {
  high: 'onnx-community/whisper-base.en',
  fast: 'onnx-community/whisper-tiny.en',
};

/**
 * word timestamps対応版（cross-attention出力付きエクスポート。M15: お手本解析専用）。
 * return_timestamps:'word' はDTWアライン用のattentionメタデータを持つこのエクスポートが必要で、
 * 通常版とは別モデルとして追加ダウンロードされる（初回のみ・Cache APIにキャッシュ）。
 */
export const WHISPER_TIMESTAMPED_MODEL_IDS: Record<WhisperModelKey, string> = {
  high: 'onnx-community/whisper-base.en_timestamped',
  fast: 'onnx-community/whisper-tiny.en_timestamped',
};

/** 初期値は高精度（base.en）。DESIGN.md §8手順2の指定どおり。 */
export const DEFAULT_WHISPER_MODEL_KEY: WhisperModelKey = 'high';

/** appStateの保存キー。 */
export const WHISPER_MODEL_APP_STATE_KEY = 'whisperModel';

export interface WhisperModelOption {
  key: WhisperModelKey;
  label: string;
  description: string;
}

/** 設定ページの表示用。 */
export const WHISPER_MODEL_OPTIONS: WhisperModelOption[] = [
  {
    key: 'high',
    label: '高精度（推奨・初期値）',
    description: '認識ミスが目に見えて減ります。処理時間は標準の約2倍で、初回に大きめのモデルダウンロードがあります。',
  },
  {
    key: 'fast',
    label: '標準（高速）',
    description: '軽量で速く動きますが、認識ミスがやや増えます。',
  },
];

export function isWhisperModelKey(value: unknown): value is WhisperModelKey {
  return value === 'high' || value === 'fast';
}

export function whisperModelIdFor(key: WhisperModelKey): string {
  return WHISPER_MODEL_IDS[key];
}

/** word timestamps対応モデルのID（M15: お手本解析用）。 */
export function whisperTimestampedModelIdFor(key: WhisperModelKey): string {
  return WHISPER_TIMESTAMPED_MODEL_IDS[key];
}

/** 保存済みのモデル選択を取得する。未設定・不正値の場合は初期値（高精度）。 */
export async function getSelectedWhisperModelKey(): Promise<WhisperModelKey> {
  const value = await getAppState(WHISPER_MODEL_APP_STATE_KEY);
  return isWhisperModelKey(value) ? value : DEFAULT_WHISPER_MODEL_KEY;
}

/** モデル選択を保存する。次回の文字起こし（判定・自己テスト）から反映される。 */
export async function setSelectedWhisperModelKey(key: WhisperModelKey): Promise<void> {
  await setAppState(WHISPER_MODEL_APP_STATE_KEY, key);
}

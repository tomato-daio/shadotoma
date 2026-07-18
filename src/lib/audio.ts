/**
 * プレーヤー・レコーダー共通の音声ユーティリティ。
 */

/** 秒数を "m:ss" 形式に整形する（10分未満想定のシャドーイング教材用）。 */
export function formatTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00';
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * 録音に使うMediaRecorderのmimeTypeを環境に応じて選ぶ。
 * iPhone Safari は audio/mp4(aac)、Chrome/Edgeは audio/webm(opus) を優先的にサポートする。
 * 実際にサポートされているBlobのmimeTypeをそのまま保存・再生に使い、変換は行わない。
 */
const RECORDER_MIME_CANDIDATES = [
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
] as const;

export function pickRecorderMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return undefined;
  }
  return RECORDER_MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type));
}

/** Blobまたは音声URLから再生時間(秒)を取得する。 */
export function loadAudioDuration(src: Blob | string): Promise<number> {
  return new Promise((resolve, reject) => {
    const audio = new Audio();
    const isBlob = typeof src !== 'string';
    const url = isBlob ? URL.createObjectURL(src) : src;
    const cleanup = () => {
      if (isBlob) URL.revokeObjectURL(url);
    };
    audio.addEventListener('loadedmetadata', () => {
      const duration = audio.duration;
      cleanup();
      resolve(Number.isFinite(duration) ? duration : 0);
    });
    audio.addEventListener('error', () => {
      cleanup();
      reject(new Error('音声の読み込みに失敗しました'));
    });
    audio.src = url;
  });
}

/** 英文の単語数をカウントする（Materialのメタ情報用の簡易実装）。 */
export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

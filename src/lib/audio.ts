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

/** Whisper文字起こしが要求する入力サンプルレート(Hz)。 */
export const WHISPER_SAMPLE_RATE = 16000;

interface WindowWithWebkitAudioContext extends Window {
  webkitAudioContext?: typeof AudioContext;
}

/**
 * 提出音声Blobを、Whisper文字起こし用に16kHzモノラルのFloat32Arrayへデコード・リサンプルする
 * （DESIGN.md §8手順1）。
 *
 * 手順:
 * 1. `AudioContext.decodeAudioData` でBlobを元のサンプルレート・チャンネル数のAudioBufferへデコード
 * 2. サンプルレート16000・チャンネル数1の`OfflineAudioContext`にそのAudioBufferを再生させ、
 *    レンダリング結果を取得する。Web Audio APIはOfflineAudioContextのサンプルレート・
 *    チャンネル数に合わせて自動的にリサンプル・ダウンミックスするため、明示的な実装は不要。
 */
export async function decodeToMono16k(blob: Blob): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer();

  const w = window as WindowWithWebkitAudioContext;
  const AudioContextCtor = window.AudioContext ?? w.webkitAudioContext;
  if (!AudioContextCtor) {
    throw new Error('このブラウザはWeb Audio APIに対応していません');
  }

  const decodeCtx = new AudioContextCtor();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuffer);
  } finally {
    void decodeCtx.close();
  }

  const targetLength = Math.max(1, Math.ceil(decoded.duration * WHISPER_SAMPLE_RATE));
  const offlineCtx = new OfflineAudioContext(1, targetLength, WHISPER_SAMPLE_RATE);
  const source = offlineCtx.createBufferSource();
  source.buffer = decoded;
  source.connect(offlineCtx.destination);
  source.start(0);

  const rendered = await offlineCtx.startRendering();
  return rendered.getChannelData(0);
}

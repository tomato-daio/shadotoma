/**
 * Azure Speechの発音評価（Pronunciation Assessment）実行（DESIGN.md §8c・M9・任意機能）。
 *
 * 完全に付加的な機能。呼び出し元（runJudge.ts）は、この関数が失敗しても例外を捕まえて
 * Whisper採点結果には一切影響を与えないこと（judge.azureErrorに一行メッセージを入れるのみ）。
 *
 * SDK本体（microsoft-cognitiveservices-speech-sdk）はこのファイル内でのみ動的importする。
 * 静的importするとAzureキー未設定のユーザーが開く判定結果画面のバンドルにも常に含まれて
 * しまうため、実際にキーが設定され採点が実行されるときだけ読み込む（バンドル分割）。
 * このファイルの純関数群（toPhraseAssessment/aggregatePhraseAssessments/worstWords/
 * describeAzureError）はSDKに依存しないため、SDK無しでVitestテストできる。
 */

import type { AzurePronunciationResult, AzureWordScore } from '../../lib/db';
import { encodeWavPcm16 } from '../../lib/wav';

export interface RunAzurePronunciationAssessmentParams {
  /** decodeToMono16kの結果（16kHzモノラルFloat32）。 */
  pcm: Float32Array;
  /** セクション全文（PronunciationAssessmentConfigのreferenceText）。 */
  referenceText: string;
  apiKey: string;
  region: string;
}

/** 1回のcontinuous recognitionフレーズぶんのスコア（音声長で加重統合する前の単位）。 */
export interface PhraseAssessment {
  /** 100ns単位（Azure SDKの RecognitionResult.duration と同じ単位）。0以下は等重み扱いにフォールバックする。 */
  durationTicks: number;
  pronScore: number;
  accuracyScore: number;
  fluencyScore: number;
  completenessScore: number;
  prosodyScore: number;
  words: AzureWordScore[];
}

/**
 * Azure Speech SDKの `PronunciationAssessmentResult.detailResult` の必要部分だけを表す型。
 * SDKの型（distrib/lib/src/sdk/PronunciationAssessmentResult.d.ts の DetailResult）と同じ形。
 * SDKに依存せずテストできるよう、このファイル内で独自定義する。
 */
export interface AzureDetailResultLike {
  Words?: {
    Word: string;
    PronunciationAssessment?: { AccuracyScore?: number; ErrorType?: string };
  }[];
  PronunciationAssessment?: {
    AccuracyScore?: number;
    FluencyScore?: number;
    CompletenessScore?: number;
    PronScore?: number;
    ProsodyScore?: number;
  };
}

/** SDKのdetailResult(1フレーズぶん)を、統合前のPhraseAssessmentへ変換する純関数。 */
export function toPhraseAssessment(detail: AzureDetailResultLike, durationTicks: number): PhraseAssessment {
  const pa = detail.PronunciationAssessment ?? {};
  const words: AzureWordScore[] = (detail.Words ?? []).map((w) => ({
    word: w.Word,
    accuracyScore: w.PronunciationAssessment?.AccuracyScore ?? 0,
    errorType: w.PronunciationAssessment?.ErrorType,
  }));
  return {
    durationTicks: Math.max(0, durationTicks),
    pronScore: pa.PronScore ?? 0,
    accuracyScore: pa.AccuracyScore ?? 0,
    fluencyScore: pa.FluencyScore ?? 0,
    completenessScore: pa.CompletenessScore ?? 0,
    prosodyScore: pa.ProsodyScore ?? 0,
    words,
  };
}

/**
 * 複数フレーズ結果を音声長(duration)で加重平均し、1つのJudgeResult['azure']へ統合する純関数
 * （DESIGN.md §8c: 60秒超対応のcontinuous recognitionで複数結果が返るため「音声長加重でスコア統合」）。
 * phrasesが空の場合はnullを返す（呼び出し側は「結果ゼロ」エラーとして扱う）。
 */
export function aggregatePhraseAssessments(phrases: PhraseAssessment[]): AzurePronunciationResult | null {
  if (phrases.length === 0) return null;

  const totalDuration = phrases.reduce((sum, p) => sum + p.durationTicks, 0);
  // 全フレーズのdurationが取得できない(0)場合は等重みにフォールバックする（0除算防止）。
  const useEqualWeight = totalDuration <= 0;
  const weightOf = (p: PhraseAssessment) => (useEqualWeight ? 1 : p.durationTicks);
  const weightTotal = useEqualWeight ? phrases.length : totalDuration;

  const weightedAverage = (pick: (p: PhraseAssessment) => number): number =>
    phrases.reduce((sum, p) => sum + pick(p) * weightOf(p), 0) / weightTotal;

  return {
    pronScore: weightedAverage((p) => p.pronScore),
    accuracyScore: weightedAverage((p) => p.accuracyScore),
    fluencyScore: weightedAverage((p) => p.fluencyScore),
    prosodyScore: weightedAverage((p) => p.prosodyScore),
    completenessScore: weightedAverage((p) => p.completenessScore),
    words: phrases.flatMap((p) => p.words),
  };
}

/** スコアの低い順に単語を並べ、上位n件を返す（判定結果画面「スコアの低い単語ワースト5」用）。 */
export function worstWords(words: AzureWordScore[], limit = 5): AzureWordScore[] {
  return [...words].sort((a, b) => a.accuracyScore - b.accuracyScore).slice(0, limit);
}

// ---- エラー種別（DESIGN.md §8c: 「タイムアウトとエラーを丁寧に（キー無効/401、ネットワーク、結果ゼロ）」） ----

export class AzurePronunciationTimeoutError extends Error {
  constructor() {
    super('発音スコアの取得がタイムアウトしました。');
    this.name = 'AzurePronunciationTimeoutError';
  }
}

export class AzurePronunciationNoResultError extends Error {
  constructor() {
    super('発音の認識結果が得られませんでした（無音、または短すぎる可能性があります）。');
    this.name = 'AzurePronunciationNoResultError';
  }
}

export class AzurePronunciationAuthError extends Error {
  constructor() {
    super('Azure APIキーが無効です。設定を確認してください。');
    this.name = 'AzurePronunciationAuthError';
  }
}

export class AzurePronunciationNetworkError extends Error {
  constructor(detail?: string) {
    super(`Azure Speechへの接続に失敗しました${detail ? `（${detail}）` : ''}。`);
    this.name = 'AzurePronunciationNetworkError';
  }
}

/** 判定結果画面に出す一行メッセージへ変換する純関数（DESIGN.md §8c: 「エラー時は1行メッセージ」）。 */
export function describeAzureError(err: unknown): string {
  if (
    err instanceof AzurePronunciationTimeoutError ||
    err instanceof AzurePronunciationNoResultError ||
    err instanceof AzurePronunciationAuthError ||
    err instanceof AzurePronunciationNetworkError
  ) {
    return err.message;
  }
  const raw = err instanceof Error ? err.message : String(err);
  return `発音スコアの取得に失敗しました（${raw}）。`;
}

/** continuous recognitionの終了待ちタイムアウト（60秒超音声も考慮した余裕のある値）。 */
const RECOGNITION_TIMEOUT_MS = 120_000;

/**
 * Azure Speechで発音評価を実行する（DESIGN.md §8c）。
 *
 * 手順:
 * 1. pcmをWAV(16kHz mono PCM16)へエンコードし、push streamへ書き込む
 * 2. PronunciationAssessmentConfig（referenceText/HundredMark/Phoneme/enableMiscue/
 *    enableProsodyAssessment）を適用したSpeechRecognizerでcontinuous recognitionを実行し、
 *    60秒超の音声でも最後まで処理する
 * 3. 各フレーズの結果を音声長加重で統合し、AzurePronunciationResultを返す
 *
 * 失敗時は AzurePronunciation*Error を投げる（呼び出し側は describeAzureError で一行メッセージ化する）。
 */
export async function runAzurePronunciationAssessment(
  params: RunAzurePronunciationAssessmentParams,
): Promise<AzurePronunciationResult> {
  const { pcm, referenceText, apiKey, region } = params;

  // SDK本体は実際に採点を実行するときだけ読み込む（バンドル分割。ファイル冒頭コメント参照）。
  const SpeechSDK = await import('microsoft-cognitiveservices-speech-sdk');

  const wavBuffer = encodeWavPcm16(pcm, { sampleRate: 16000 });

  const speechConfig = SpeechSDK.SpeechConfig.fromSubscription(apiKey, region);
  speechConfig.speechRecognitionLanguage = 'en-US';

  const pushStream = SpeechSDK.AudioInputStream.createPushStream();
  pushStream.write(wavBuffer);
  pushStream.close();

  const audioConfig = SpeechSDK.AudioConfig.fromStreamInput(pushStream);
  const recognizer = new SpeechSDK.SpeechRecognizer(speechConfig, audioConfig);

  const pronunciationConfig = new SpeechSDK.PronunciationAssessmentConfig(
    referenceText,
    SpeechSDK.PronunciationAssessmentGradingSystem.HundredMark,
    SpeechSDK.PronunciationAssessmentGranularity.Phoneme,
    true, // enableMiscue
  );
  pronunciationConfig.enableProsodyAssessment = true;
  pronunciationConfig.applyTo(recognizer);

  const phrases: PhraseAssessment[] = [];

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        recognizer.stopContinuousRecognitionAsync(
          () => reject(new AzurePronunciationTimeoutError()),
          () => reject(new AzurePronunciationTimeoutError()),
        );
      }, RECOGNITION_TIMEOUT_MS);

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        fn();
      };

      recognizer.recognized = (_sender, e) => {
        if (e.result.reason !== SpeechSDK.ResultReason.RecognizedSpeech) return;
        try {
          const detail = SpeechSDK.PronunciationAssessmentResult.fromResult(e.result).detailResult;
          phrases.push(toPhraseAssessment(detail, e.result.duration));
        } catch {
          // 個々のフレーズのパース失敗は無視して継続する（他のフレーズの結果は活かす）。
        }
      };

      recognizer.canceled = (_sender, e) => {
        if (e.reason !== SpeechSDK.CancellationReason.Error) {
          // EndOfStream（正常終了）はここでは何もしない。後続のsessionStoppedで解決する。
          return;
        }
        finish(() => {
          if (e.errorCode === SpeechSDK.CancellationErrorCode.AuthenticationFailure) {
            reject(new AzurePronunciationAuthError());
          } else if (
            e.errorCode === SpeechSDK.CancellationErrorCode.ConnectionFailure ||
            e.errorCode === SpeechSDK.CancellationErrorCode.ServiceTimeout
          ) {
            reject(new AzurePronunciationNetworkError(e.errorDetails));
          } else {
            reject(new Error(e.errorDetails || 'Azure Speechでキャンセルされました。'));
          }
        });
      };

      recognizer.sessionStopped = () => {
        finish(() => {
          recognizer.stopContinuousRecognitionAsync(
            () => resolve(),
            (err) => reject(new Error(err)),
          );
        });
      };

      recognizer.startContinuousRecognitionAsync(
        () => {
          // 開始成功時は何もしない（結果はrecognized/canceled/sessionStoppedイベントで受け取る）。
        },
        (err) => finish(() => reject(new AzurePronunciationNetworkError(err))),
      );
    });
  } finally {
    recognizer.close();
    audioConfig.close();
    speechConfig.close();
  }

  const aggregated = aggregatePhraseAssessments(phrases);
  if (!aggregated) {
    throw new AzurePronunciationNoResultError();
  }
  return aggregated;
}

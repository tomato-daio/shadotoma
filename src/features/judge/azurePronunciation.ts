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
 * describeAzureError/truncateDetail）はSDKに依存しないため、SDK無しでVitestテストできる。
 *
 * プロソディ・フォールバック（DESIGN.md §8c M10）: 韻律（プロソディ）採点はリージョンにより
 * 未対応の場合があり（東日本で失敗報告あり）、その場合は韻律有効でのcontinuous recognitionが
 * cancellation/エラー/結果ゼロのいずれかで失敗する。runAzurePronunciationAssessmentは、
 * 韻律有効での実行が失敗した場合に韻律なし設定で1回だけ自動リトライし、成功したら
 * prosodyScoreをundefinedにして返す（型・表示の後方互換のためAzurePronunciationResult.
 * prosodyScoreはoptional）。両方失敗した場合のみ例外を投げる。
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
    super(`Azure Speechへの接続に失敗しました${detail ? `（${truncateDetail(detail)}）` : ''}。`);
    this.name = 'AzurePronunciationNetworkError';
  }
}

/** 汎用エラーメッセージに含めるSDK詳細情報の最大文字数（DESIGN.md §8c M10:「先頭120字程度」）。 */
const ERROR_DETAIL_MAX_LENGTH = 120;

/**
 * 詳細文字列を指定長で切り詰める純関数（DESIGN.md §8c M10）。
 * SDKのcancellation errorDetailsは長い場合があり、そのままだと判定結果画面の
 * 「エラー時は1行メッセージ」を壊すため、azureErrorへ含める前に切り詰める。
 * 切り詰めた場合は末尾に…を付ける。console.errorへは（呼び出し側で）切り詰めない全文を渡すこと。
 */
export function truncateDetail(detail: string, maxLength: number = ERROR_DETAIL_MAX_LENGTH): string {
  const trimmed = detail.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}…`;
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
  return `発音スコアの取得に失敗しました: ${truncateDetail(raw)}`;
}

/** continuous recognitionの終了待ちタイムアウト（60秒超音声も考慮した余裕のある値）。 */
const RECOGNITION_TIMEOUT_MS = 120_000;

/** このファイル内でのみ使う、動的importしたSDKモジュール名前空間の型。 */
type AzureSpeechSDK = typeof import('microsoft-cognitiveservices-speech-sdk');

/**
 * 1回ぶんのcontinuous recognitionを実行し、フレーズ結果配列を返す内部ヘルパー。
 * プロソディ・フォールバック（DESIGN.md §8c M10）のため、runAzurePronunciationAssessmentから
 * enableProsodyを切り替えて最大2回（韻律あり→失敗時のみ韻律なしで1回）呼ばれる。
 *
 * 手順:
 * 1. wavBuffer（16kHz mono PCM16）をpush streamへ書き込む
 * 2. PronunciationAssessmentConfig（referenceText/HundredMark/Phoneme/enableMiscue/
 *    enableProsodyAssessment）を適用したSpeechRecognizerでcontinuous recognitionを実行し、
 *    60秒超の音声でも最後まで処理する
 *
 * cancellation/エラー/タイムアウト時は AzurePronunciation*Error（またはSDK詳細を含むError）を
 * 投げる。結果0件（無音等）でも例外は投げず空配列を返す（呼び出し側が「結果ゼロ」として扱う）。
 */
async function recognizeOnce(
  SpeechSDK: AzureSpeechSDK,
  wavBuffer: ArrayBuffer,
  referenceText: string,
  apiKey: string,
  region: string,
  enableProsody: boolean,
): Promise<PhraseAssessment[]> {
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
  pronunciationConfig.enableProsodyAssessment = enableProsody;
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
            // 韻律採点未対応リージョン等での失敗は多くの場合ここに来る（BadRequest等）。
            // e.errorDetailsをそのままError.messageに持たせ、呼び出し側のdescribeAzureErrorで
            // 判定結果画面向けに切り詰める（console.errorには全文を出す。DESIGN.md §8c M10）。
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

  return phrases;
}

/**
 * Azure Speechで発音評価を実行する（DESIGN.md §8c、プロソディ・フォールバックはM10）。
 *
 * 1. まず韻律（プロソディ）ありで実行する
 * 2. cancellation/エラー/結果ゼロのいずれかで失敗したら、韻律なし設定で1回だけ自動リトライする
 *    （東日本リージョン等での韻律未対応が疑われるケースを、採点そのものは諦めずに救済する）
 * 3. リトライも失敗したら例外を投げる（呼び出し側は describeAzureError で一行メッセージ化する）
 * 4. 韻律なしで成功した場合は prosodyScore を undefined にして返す（カードの韻律欄は「―」表示）
 *
 * 接続テスト成功→提出時に失敗、という切り分けの手掛かりとして、リトライの有無を
 * console.infoに残す（失敗の詳細は console.error に全文を残す）。
 */
export async function runAzurePronunciationAssessment(
  params: RunAzurePronunciationAssessmentParams,
): Promise<AzurePronunciationResult> {
  const { pcm, referenceText, apiKey, region } = params;

  // SDK本体は実際に採点を実行するときだけ読み込む（バンドル分割。ファイル冒頭コメント参照）。
  const SpeechSDK = await import('microsoft-cognitiveservices-speech-sdk');
  const wavBuffer = encodeWavPcm16(pcm, { sampleRate: 16000 });

  let phrases: PhraseAssessment[];
  let usedProsody = true;
  let retried = false;

  try {
    phrases = await recognizeOnce(SpeechSDK, wavBuffer, referenceText, apiKey, region, true);
    if (phrases.length === 0) {
      throw new AzurePronunciationNoResultError();
    }
  } catch (firstErr) {
    console.error(
      '[azurePronunciation] 韻律ありでの発音評価に失敗しました。韻律なしで1回だけ自動リトライします。',
      firstErr,
    );
    retried = true;
    usedProsody = false;
    try {
      phrases = await recognizeOnce(SpeechSDK, wavBuffer, referenceText, apiKey, region, false);
      if (phrases.length === 0) {
        throw new AzurePronunciationNoResultError();
      }
    } catch (retryErr) {
      console.error('[azurePronunciation] 韻律なしでの自動リトライも失敗しました。', retryErr);
      console.info('[azurePronunciation] リトライ実施: あり（韻律あり失敗→韻律なしで再試行→こちらも失敗）');
      throw retryErr;
    }
  }

  console.info(
    retried
      ? '[azurePronunciation] リトライ実施: あり（韻律ありが失敗したため韻律なしで再試行し成功しました）'
      : '[azurePronunciation] リトライ実施: なし（韻律ありで成功しました）',
  );

  const aggregated = aggregatePhraseAssessments(phrases);
  if (!aggregated) {
    throw new AzurePronunciationNoResultError();
  }
  if (!usedProsody) {
    // 韻律なしでの実行結果はProsodyScoreが常に既定値(0)になるため、誤解を招かないよう
    // undefinedにする（DESIGN.md §8c M10:「成功したらprosodyScoreなしで保存・表示」）。
    aggregated.prosodyScore = undefined;
  }
  return aggregated;
}

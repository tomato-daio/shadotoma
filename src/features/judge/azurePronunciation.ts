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
 * describeAzureError/truncateDetail/resolveRecognitionOutcome）はSDKに依存しないため、
 * SDK無しでVitestテストできる。
 *
 * iOS Safari(WebKit)の後片付けバグ対策（M10追補）: SDKには、認識終了時の後片付け
 * （stopContinuousRecognitionAsync/close周辺のprivSource.turnOff）で
 * 「undefined is not an object (evaluating 'this.privSource.turnOff().then')」という内部例外が
 * 出る既知のバグがある（iPhone実機で確認）。このとき認識結果自体は取得済みのことが多いため、
 * 後片付けの失敗は採点の成否に影響させず（console.warnに全文を残すのみ）、成否は
 * 「フレーズ結果を1件以上収集できたか」で判定する（resolveRecognitionOutcome）。
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
 * SDKの後片付け（stop/close）呼び出しの同期例外を握りつぶす（M10追補: iOS Safari対策）。
 * WebKitではSDK内部の既知バグ（privSource.turnOff周辺）により後片付けで例外が出ることがあるが、
 * その時点で認識結果は取得済みのことが多い。後片付けの成否は採点の成否に影響させず、
 * console.warnに全文を残すだけにする（ファイル冒頭コメント参照）。
 */
function swallowTeardownError(label: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.warn(
      `[azurePronunciation] ${label}で例外が発生しました（後片付けの失敗は採点の成否に影響させません）。`,
      err,
    );
  }
}

/**
 * 認識セッション終了後の成否判定（M10追補: iOS Safari後片付けバグ対策の純関数）。
 * 成否は「フレーズ結果を1件以上収集できたか」で決める:
 * - 1件以上: 認識中・後片付けでエラーが発生していても成功として返す（エラーはconsole.warnに残す）
 * - 0件でエラーあり: そのエラーを投げる（後片付けバグ以外の別原因の切り分けに使う）
 * - 0件でエラーなし: 空配列を返す（呼び出し側が「結果ゼロ」として扱う）
 */
export function resolveRecognitionOutcome(
  phrases: PhraseAssessment[],
  recognitionError: Error | null,
): PhraseAssessment[] {
  if (phrases.length > 0) {
    if (recognitionError) {
      console.warn(
        '[azurePronunciation] 認識中にエラーが発生しましたが、フレーズ結果を取得済みのため成功として扱います。',
        recognitionError,
      );
    }
    return phrases;
  }
  if (recognitionError) throw recognitionError;
  return phrases;
}

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
 * 成否判定（M10追補・resolveRecognitionOutcome参照）: 認識中のエラーはrejectせず記録だけして
 * Promiseは常にresolveし、フレーズ結果を1件以上収集できていれば（後片付け例外が出ても）
 * 成功として返す。0件かつエラーありの場合のみそのエラーを投げる。0件かつエラーなし（無音等）は
 * 空配列を返す（呼び出し側が「結果ゼロ」として扱う）。
 * stopContinuousRecognitionAsync/closeの失敗はconsole.warnに残すだけで握りつぶす
 * （iOS SafariのprivSource.turnOff既知バグ対策。ファイル冒頭コメント参照）。
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
  /**
   * 認識中に発生した最初のエラー（cancellation・開始失敗・タイムアウト・後片付け例外の伝播等）。
   * フレーズを1件も収集できなかった場合のみ、失敗としてresolveRecognitionOutcomeが投げる。
   */
  let recognitionError: Error | null = null;

  try {
    await new Promise<void>((resolve) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      /**
       * 二重解決防止のガード（M10追補）: タイムアウト・canceled・sessionStopped・
       * stopのエラーコールバック・同期例外がどの順序・組み合わせで発生しても、
       * 最初の1回だけがこのPromiseを解決する。エラーはrejectせずrecognitionErrorへ
       * 記録して常にresolveし、成否はフレーズ収集数ベースで後段が判定する。
       */
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        if (err && !recognitionError) recognitionError = err;
        resolve();
      };

      timeoutId = setTimeout(() => {
        // タイムアウト時も停止は試みるが、stop自体の失敗（iOS Safariの既知バグ等）は握りつぶし、
        // 停止の完了を待たずにタイムアウトとして確定する。
        swallowTeardownError('stopContinuousRecognitionAsync（タイムアウト時）', () => {
          recognizer.stopContinuousRecognitionAsync(
            () => {},
            (err) =>
              console.warn('[azurePronunciation] タイムアウト時の停止呼び出しがエラーを返しました。', err),
          );
        });
        finish(new AzurePronunciationTimeoutError());
      }, RECOGNITION_TIMEOUT_MS);

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
        if (e.errorCode === SpeechSDK.CancellationErrorCode.AuthenticationFailure) {
          finish(new AzurePronunciationAuthError());
        } else if (
          e.errorCode === SpeechSDK.CancellationErrorCode.ConnectionFailure ||
          e.errorCode === SpeechSDK.CancellationErrorCode.ServiceTimeout
        ) {
          finish(new AzurePronunciationNetworkError(e.errorDetails));
        } else {
          // 韻律採点未対応リージョン等での失敗は多くの場合ここに来る（BadRequest等）。
          // e.errorDetailsをそのままError.messageに持たせ、呼び出し側のdescribeAzureErrorで
          // 判定結果画面向けに切り詰める（console.errorには全文を出す。DESIGN.md §8c M10）。
          finish(new Error(e.errorDetails || 'Azure Speechでキャンセルされました。'));
        }
      };

      recognizer.sessionStopped = () => {
        // 認識セッションは終了済みで、フレーズ結果は収集済み。ここからは後片付けのみのため、
        // stopの同期例外・エラーコールバック（iOS SafariのprivSource.turnOff既知バグが出る箇所）
        // はどちらもエラー扱いにせず、warnを残してresolveする（成否はフレーズ収集数で判定）。
        try {
          recognizer.stopContinuousRecognitionAsync(
            () => finish(),
            (err) => {
              console.warn(
                '[azurePronunciation] stopContinuousRecognitionAsyncがエラーを返しました（後片付けの失敗は採点の成否に影響させません）。',
                err,
              );
              finish();
            },
          );
        } catch (err) {
          console.warn(
            '[azurePronunciation] stopContinuousRecognitionAsyncの呼び出しで例外が発生しました（後片付けの失敗は採点の成否に影響させません）。',
            err,
          );
          finish();
        }
      };

      recognizer.startContinuousRecognitionAsync(
        () => {
          // 開始成功時は何もしない（結果はrecognized/canceled/sessionStoppedイベントで受け取る）。
        },
        (err) => finish(new AzurePronunciationNetworkError(err)),
      );
    });
  } finally {
    // close群の同期例外（iOS SafariのprivSource.turnOff内部バグ等）も採点の成否に影響させない。
    swallowTeardownError('recognizer.close', () => recognizer.close());
    swallowTeardownError('audioConfig.close', () => audioConfig.close());
    swallowTeardownError('speechConfig.close', () => speechConfig.close());
  }

  // フレーズ1件以上なら（エラーが記録されていても）成功。0件かつエラーありなら投げる。
  return resolveRecognitionOutcome(phrases, recognitionError);
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

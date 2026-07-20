/**
 * 添削エンジンの一連の処理をまとめたオーケストレーション関数（DESIGN.md §8）。
 *
 * 提出音声Blob → 16kHzモノラルへリサンプル → Whisper文字起こし → スクリプトとアライン →
 * matchRate/WPM算出 → Good/Development Point生成、までを一気通貫で行う。
 * 失敗時（モデルDL/実行エラー）は例外をそのまま投げるので、呼び出し側でフォールバックUI
 * （clipboardFallback.ts）に切り替える。
 *
 * お手本比較（DESIGN.md §8f・M15）: お手本音声の解析（referenceAnalysis.ts。教材ごと初回のみ・
 * キャッシュあり）を行い、速度・間・抑揚の比較（referenceComparison）と、単語タイムスタンプに
 * よる連結実現の確認（issuesへのreferenceLinked付与）を追加する。お手本解析の失敗は握りつぶし、
 * 従来どおりの判定へ縮退する。
 *
 * Azure発音評価（DESIGN.md §8c・M9・任意機能）: appStateにAzureキーが設定されている場合のみ、
 * Whisper採点の後に追加で実行する。完全に付加的な機能のため、失敗しても例外を外へ投げず
 * judge.azureErrorに一行メッセージを残すだけで、Whisper採点の結果には一切影響させない。
 */

import { alignWords, buildScriptWords } from '../../lib/align';
import { decodeToMono16k, WHISPER_SAMPLE_RATE } from '../../lib/audio';
import type { JudgeResult, Material } from '../../lib/db';
import { computeMatchRate, computeWpm, generateFeedback, LOW_RECOGNITION_RATIO } from '../../lib/feedback';
import { annotateIssuesWithLinking } from '../../lib/linkingRealization';
import { comparePreviousIssues, detectPhenomena, type PhenomenonIssue } from '../../lib/phenomena';
import { buildReferenceComparison, buildSpeechProfile } from '../../lib/referenceComparison';
import { describeAzureError, runAzurePronunciationAssessment } from './azurePronunciation';
import { getAzureSpeechKey, getAzureSpeechRegion } from './azureSpeechConfig';
import { ensureReferenceAnalysis } from './referenceAnalysis';
import { transcribeAudio } from './whisper';
import type { WhisperProgressPhase } from './whisper.protocol';
import { getSelectedWhisperModelKey, whisperModelIdFor } from './whisperModels';

/**
 * Whisperの進捗フェーズに「お手本音声を解析中…」（M15）と「発音スコア取得中…」（Azure）を
 * 加えた、判定処理全体の進捗フェーズ。
 */
export type JudgeProgressPhase = WhisperProgressPhase | 'reference-analysis' | 'azure-scoring';

export interface JudgeProgressEvent {
  phase: JudgeProgressPhase;
  /** model-downloadの場合のみ、0〜1のおおよその進捗。 */
  progress?: number;
}

export type JudgeProgressCallback = (event: JudgeProgressEvent) => void;

export interface RunJudgeParams {
  audioBlob: Blob;
  /** 対象教材（スクリプト・お手本音声・再生時間をここから参照する。M15でsentences等の個別渡しから変更）。 */
  material: Material;
  /**
   * 提出音声（録音全体）の長さ（秒）。
   * WPM算出は発話区間ベース（DESIGN.md §8手順4・M10、lib/audio.ts speechBounds）が基本で、
   * これは無音のみ等で発話区間が取れなかった場合のフォールバック用の分母としてのみ使う。
   */
  recordingDurationSec: number;
  /** 直近の提出のmatchRate（前回比コメント用）。 */
  previousMatchRate?: number;
  /** 同一教材の前回提出（judge付き最新）のissues。指定時のみ前回比較を行う（DESIGN.md §8 5b）。 */
  previousIssues?: PhenomenonIssue[];
  onProgress?: JudgeProgressCallback;
}

export interface RunJudgeOutput {
  transcript: string;
  judge: JudgeResult;
}

export async function runJudge(params: RunJudgeParams): Promise<RunJudgeOutput> {
  const { audioBlob, material, recordingDurationSec, previousMatchRate, previousIssues, onProgress } = params;
  const sentences = material.sentences;

  const [pcm, azureKey, azureRegion] = await Promise.all([
    decodeToMono16k(audioBlob),
    getAzureSpeechKey(),
    getAzureSpeechRegion(),
  ]);
  const azureEnabled = Boolean(azureKey) && sentences.length > 0;
  // transcribeAudio は pcm.buffer を transferable で worker へ渡し、呼び出し後にpcmを
  // 再利用できなくする（whisper.ts参照）。Azure採点でも同じPCMを使うため、渡す前に複製する。
  const pcmForAzure = azureEnabled ? pcm.slice() : null;
  // DESIGN.md §8手順4・M10/M15: WPM分母（発話区間長）と、お手本比較用のプロファイル
  // （間・抑揚）を、pcmがtransferableで転送され使えなくなる前に計算しておく。
  const userProfile = buildSpeechProfile(pcm, WHISPER_SAMPLE_RATE);

  // M8: 設定ページで選択したモデル（appState 'whisperModel'）を毎回解決して使う。
  // 切替後の最初の判定からワーカー内でパイプラインが再構築され、新モデルが反映される。
  const modelKey = await getSelectedWhisperModelKey();
  const { text: transcript } = await transcribeAudio(pcm, whisperModelIdFor(modelKey), undefined, onProgress);

  const scriptWords = buildScriptWords(sentences);
  const recognizedWords = transcript.length > 0 ? transcript.split(/\s+/).filter(Boolean) : [];
  const { wordMarks, insertions } = alignWords(scriptWords, recognizedWords);

  const matchRate = computeMatchRate(wordMarks);
  // DESIGN.md §8手順4・M10: WPMは発話区間（無音を除いた「最初に声が出た時刻〜最後に声が出た時刻」）
  // の長さを分母にする。発話区間が取れない（無音のみ等）場合のみ、録音全体の長さを使う。
  const speechDurationSec = userProfile?.speechSpanSec ?? recordingDurationSec;
  const wpm = computeWpm(recognizedWords.length, speechDurationSec);

  // M15: お手本音声の解析（教材ごと初回のみ実行・キャッシュあり）。失敗時はnullで縮退。
  const refRecord = await ensureReferenceAnalysis({ material, modelKey, onProgress });

  // referenceWpm: お手本の発話区間ベース（M15で録音側と同じ土俵に統一）。お手本解析が
  // 無い場合は従来どおり無音込み全尺（Material.durationSec）ベースへ縮退する。
  const referenceWpm = refRecord?.profile
    ? computeWpm(scriptWords.length, refRecord.profile.speechSpanSec)
    : material.durationSec && material.durationSec > 0
      ? computeWpm(scriptWords.length, material.durationSec)
      : undefined;

  // 認識がほぼゼロ（マイク不調・雑音のみ等）の録音では、速度・間・抑揚の比較値がすべて無意味
  // （「100倍ゆっくり」等の極端表示）になるため、比較ごと縮退する。referenceWpm=0（空スクリプト）も同様。
  const recognitionRatio = scriptWords.length > 0 ? recognizedWords.length / scriptWords.length : 0;
  const referenceComparison =
    userProfile &&
    refRecord?.profile &&
    referenceWpm !== undefined &&
    referenceWpm > 0 &&
    recognitionRatio >= LOW_RECOGNITION_RATIO
      ? buildReferenceComparison({
          userProfile,
          referenceProfile: refRecord.profile,
          userWpm: wpm,
          referenceWpm,
        })
      : undefined;

  // DESIGN.md §8 5b: 音声現象の検出と、前回提出issuesとの比較（該当語が今回okになったか）。
  let detectedIssues = detectPhenomena(sentences, wordMarks);
  // M15: お手本の単語タイムスタンプが取れていれば、ペア指摘に「お手本では連結している」印を付ける。
  if (refRecord?.words && refRecord.words.length > 0) {
    const refMarks = alignWords(
      scriptWords,
      refRecord.words.map((w) => w.word),
    ).wordMarks;
    detectedIssues = annotateIssuesWithLinking({ issues: detectedIssues, refMarks, refWords: refRecord.words });
  }
  const previousIssueOutcomes = previousIssues ? comparePreviousIssues(previousIssues, wordMarks) : undefined;

  const {
    goodPoints,
    devPoints,
    issues,
  } = generateFeedback({
    wordMarks,
    sentences,
    insertions,
    wpm,
    referenceWpm,
    previousMatchRate,
    issues: detectedIssues,
    previousIssueOutcomes,
    referenceComparison,
  });

  const judge: JudgeResult = {
    matchRate,
    wpm,
    wordMarks,
    goodPoints,
    devPoints,
    engine: 'whisper-local',
    issues,
    previousIssueOutcomes,
    referenceComparison,
  };

  // Azure発音評価（DESIGN.md §8c）: キーが設定されている場合のみ、Whisper採点の後に追加実行する。
  // ここで投げられる例外は握りつぶし、judge.azureErrorへ一行メッセージを残すのみに留める
  // （Whisper採点はここまでで完了しており、Azureの成否によって変化しない）。
  if (azureEnabled && pcmForAzure && azureKey) {
    onProgress?.({ phase: 'azure-scoring' });
    try {
      const referenceText = sentences.map((s) => s.en).join(' ');
      judge.azure = await runAzurePronunciationAssessment({
        pcm: pcmForAzure,
        referenceText,
        apiKey: azureKey,
        region: azureRegion,
      });
    } catch (err) {
      judge.azureError = describeAzureError(err);
    }
  }

  return { transcript, judge };
}

/**
 * 添削エンジンの一連の処理をまとめたオーケストレーション関数（DESIGN.md §8）。
 *
 * 提出音声Blob → 16kHzモノラルへリサンプル → Whisper文字起こし → スクリプトとアライン →
 * matchRate/WPM算出 → Good/Development Point生成、までを一気通貫で行う。
 * 失敗時（モデルDL/実行エラー）は例外をそのまま投げるので、呼び出し側でフォールバックUI
 * （clipboardFallback.ts）に切り替える。
 *
 * Azure発音評価（DESIGN.md §8c・M9・任意機能）: appStateにAzureキーが設定されている場合のみ、
 * Whisper採点の後に追加で実行する。完全に付加的な機能のため、失敗しても例外を外へ投げず
 * judge.azureErrorに一行メッセージを残すだけで、Whisper採点の結果には一切影響させない。
 */

import { alignWords, buildScriptWords } from '../../lib/align';
import { decodeToMono16k, speechBounds, WHISPER_SAMPLE_RATE } from '../../lib/audio';
import type { JudgeResult, Sentence } from '../../lib/db';
import { computeMatchRate, computeWpm, generateFeedback } from '../../lib/feedback';
import { comparePreviousIssues, detectPhenomena, type PhenomenonIssue } from '../../lib/phenomena';
import { describeAzureError, runAzurePronunciationAssessment } from './azurePronunciation';
import { getAzureSpeechKey, getAzureSpeechRegion } from './azureSpeechConfig';
import { transcribeAudio } from './whisper';
import type { WhisperProgressPhase } from './whisper.protocol';
import { getSelectedWhisperModelKey, whisperModelIdFor } from './whisperModels';

/** Whisperの進捗フェーズに「発音スコア取得中…」（Azure）を加えた、判定処理全体の進捗フェーズ。 */
export type JudgeProgressPhase = WhisperProgressPhase | 'azure-scoring';

export interface JudgeProgressEvent {
  phase: JudgeProgressPhase;
  /** model-downloadの場合のみ、0〜1のおおよその進捗。 */
  progress?: number;
}

export type JudgeProgressCallback = (event: JudgeProgressEvent) => void;

export interface RunJudgeParams {
  audioBlob: Blob;
  sentences: Sentence[];
  /**
   * 提出音声（録音全体）の長さ（秒）。
   * WPM算出は発話区間ベース（DESIGN.md §8手順4・M10、lib/audio.ts speechBounds）が基本で、
   * これは無音のみ等でspeechBoundsがnullを返した場合のフォールバック用の分母としてのみ使う。
   */
  recordingDurationSec: number;
  /** お手本音声の長さ（秒）。指定時のみ速度比較の Good/Dev Point を生成する。 */
  referenceDurationSec?: number;
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
  const { audioBlob, sentences, recordingDurationSec, referenceDurationSec, previousMatchRate, previousIssues, onProgress } =
    params;

  const [pcm, azureKey, azureRegion] = await Promise.all([
    decodeToMono16k(audioBlob),
    getAzureSpeechKey(),
    getAzureSpeechRegion(),
  ]);
  const azureEnabled = Boolean(azureKey) && sentences.length > 0;
  // transcribeAudio は pcm.buffer を transferable で worker へ渡し、呼び出し後にpcmを
  // 再利用できなくする（whisper.ts参照）。Azure採点でも同じPCMを使うため、渡す前に複製する。
  const pcmForAzure = azureEnabled ? pcm.slice() : null;
  // DESIGN.md §8手順4・M10: WPMの分母を発話区間ベースにするため、pcmが上記のtransferableで
  // 転送され使えなくなる前に、先頭・末尾の無音を除いた発話区間を計算しておく。
  const bounds = speechBounds(pcm, WHISPER_SAMPLE_RATE);

  // M8: 設定ページで選択したモデル（appState 'whisperModel'）を毎回解決して使う。
  // 切替後の最初の判定からワーカー内でパイプラインが再構築され、新モデルが反映される。
  const modelKey = await getSelectedWhisperModelKey();
  const transcript = await transcribeAudio(pcm, whisperModelIdFor(modelKey), onProgress);

  const scriptWords = buildScriptWords(sentences);
  const recognizedWords = transcript.length > 0 ? transcript.split(/\s+/).filter(Boolean) : [];
  const { wordMarks, insertions } = alignWords(scriptWords, recognizedWords);

  const matchRate = computeMatchRate(wordMarks);
  // DESIGN.md §8手順4・M10: WPMは発話区間（無音を除いた「最初に声が出た時刻〜最後に声が出た時刻」）
  // の長さを分母にする。speechBoundsがnull（無音のみ等）の場合のみ、従来どおり録音全体の長さを使う。
  const speechDurationSec = bounds ? bounds.endSec - bounds.startSec : recordingDurationSec;
  const wpm = computeWpm(recognizedWords.length, speechDurationSec);
  const referenceWpm =
    referenceDurationSec && referenceDurationSec > 0
      ? computeWpm(scriptWords.length, referenceDurationSec)
      : undefined;

  // DESIGN.md §8 5b: 音声現象の検出と、前回提出issuesとの比較（該当語が今回okになったか）。
  const detectedIssues = detectPhenomena(sentences, wordMarks);
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

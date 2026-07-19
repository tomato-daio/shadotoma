/**
 * 添削エンジンの一連の処理をまとめたオーケストレーション関数（DESIGN.md §8）。
 *
 * 提出音声Blob → 16kHzモノラルへリサンプル → Whisper文字起こし → スクリプトとアライン →
 * matchRate/WPM算出 → Good/Development Point生成、までを一気通貫で行う。
 * 失敗時（モデルDL/実行エラー）は例外をそのまま投げるので、呼び出し側でフォールバックUI
 * （clipboardFallback.ts）に切り替える。
 */

import { alignWords, buildScriptWords } from '../../lib/align';
import { decodeToMono16k } from '../../lib/audio';
import type { JudgeResult, Sentence } from '../../lib/db';
import { computeMatchRate, computeWpm, generateFeedback } from '../../lib/feedback';
import { comparePreviousIssues, detectPhenomena, type PhenomenonIssue } from '../../lib/phenomena';
import { transcribeAudio, type WhisperProgressCallback } from './whisper';

export interface RunJudgeParams {
  audioBlob: Blob;
  sentences: Sentence[];
  /** 提出音声の長さ（秒）。WPM算出に使う。 */
  recordingDurationSec: number;
  /** お手本音声の長さ（秒）。指定時のみ速度比較の Good/Dev Point を生成する。 */
  referenceDurationSec?: number;
  /** 直近の提出のmatchRate（前回比コメント用）。 */
  previousMatchRate?: number;
  /** 同一教材の前回提出（judge付き最新）のissues。指定時のみ前回比較を行う（DESIGN.md §8 5b）。 */
  previousIssues?: PhenomenonIssue[];
  onProgress?: WhisperProgressCallback;
}

export interface RunJudgeOutput {
  transcript: string;
  judge: JudgeResult;
}

export async function runJudge(params: RunJudgeParams): Promise<RunJudgeOutput> {
  const { audioBlob, sentences, recordingDurationSec, referenceDurationSec, previousMatchRate, previousIssues, onProgress } =
    params;

  const pcm = await decodeToMono16k(audioBlob);
  const transcript = await transcribeAudio(pcm, onProgress);

  const scriptWords = buildScriptWords(sentences);
  const recognizedWords = transcript.length > 0 ? transcript.split(/\s+/).filter(Boolean) : [];
  const { wordMarks, insertions } = alignWords(scriptWords, recognizedWords);

  const matchRate = computeMatchRate(wordMarks);
  const wpm = computeWpm(recognizedWords.length, recordingDurationSec);
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

  return { transcript, judge };
}

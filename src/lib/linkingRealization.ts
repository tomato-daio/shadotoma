/**
 * お手本音声の単語タイムスタンプによる「連結の実現」判定（M15・DESIGN.md §8f）。
 *
 * Whisper（timestampedモデル）が返すお手本の単語タイミング列と、お手本transcriptを
 * スクリプトへアラインした結果（refMarks。riでタイミング列のindexに対応）から、
 * 音声現象のペア指摘（linking/flap2語/elision）について「お手本では2語をほぼ切れ目なく
 * 発音している」ことを確認し、issueに referenceLinked を付与する。
 *
 * タイムスタンプは量子化モデル依存で壊れることがあるため、validateTimedWords の品質ゲートを
 * 通過したデータだけを使う（不合格時は呼び出し側が付与なしに縮退する）。純関数のみ。
 */

import type { WordMark } from './align';
import type { PhenomenonIssue } from './phenomena';

/** Whisperが返した単語1つぶんのタイミング。 */
export interface TimedWord {
  word: string;
  startSec: number;
  endSec: number;
}

/** お手本の2語間ギャップがこの秒数以下なら「連結して発音している」とみなす。 */
export const LINKED_GAP_MAX_SEC = 0.09;
/** 有効な語がtranscript語数のこの割合未満なら、タイムスタンプ全体を信頼しない。 */
export const TIMED_WORDS_MIN_COVERAGE = 0.8;
/** startの逆行をこの秒数まで許容する（これを超える逆行は壊れたタイムスタンプ）。 */
const MONOTONIC_SLACK_SEC = 0.05;
/** 最終語のendが音声長をこの秒数以上超えていたら壊れたタイムスタンプとみなす。 */
const MAX_END_OVERRUN_SEC = 1.0;

/**
 * Whisper出力の品質ゲート。合格なら不正エントリを除いた配列、不合格ならnull（縮退）。
 * 注意: 戻り値の配列indexがそのまま後続のアライン（ri）の基準になるため、
 * 呼び出し側はこの戻り値の word 列でアラインすること。
 */
export function validateTimedWords(
  words: TimedWord[] | undefined,
  expectedWordCount: number,
  durationSec: number,
): TimedWord[] | null {
  if (!words || words.length === 0 || expectedWordCount <= 0) return null;

  const valid = words.filter(
    (w) =>
      w.word.length > 0 &&
      Number.isFinite(w.startSec) &&
      Number.isFinite(w.endSec) &&
      w.startSec >= 0 &&
      w.startSec <= w.endSec,
  );
  if (valid.length < expectedWordCount * TIMED_WORDS_MIN_COVERAGE) return null;

  for (let i = 1; i < valid.length; i++) {
    if (valid[i].startSec < valid[i - 1].startSec - MONOTONIC_SLACK_SEC) return null;
  }

  if (Number.isFinite(durationSec) && durationSec > 0) {
    const lastEnd = valid[valid.length - 1].endSec;
    if (lastEnd > durationSec + MAX_END_OVERRUN_SEC) return null;
  }

  return valid;
}

/**
 * ペア指摘の2語が、お手本音声内で連結して発音されているかを調べる。
 * refMarksから同一文内の隣接一致箇所を探し、両語ともok（お手本がスクリプト通り発音・ri保持）で
 * 語間ギャップが LINKED_GAP_MAX_SEC 以下なら連結とみなす。
 */
function isReferenceLinked(issue: PhenomenonIssue, refMarks: WordMark[], refWords: TimedWord[]): boolean {
  for (let k = 0; k + 1 < refMarks.length; k++) {
    const first = refMarks[k];
    const second = refMarks[k + 1];
    if (first.si !== issue.si || second.si !== issue.si) continue;
    if (first.word !== issue.words[0] || second.word !== issue.words[1]) continue;
    if (first.status !== 'ok' || second.status !== 'ok') continue;
    if (first.ri === undefined || second.ri === undefined) continue;
    const firstTimed = refWords[first.ri];
    const secondTimed = refWords[second.ri];
    if (!firstTimed || !secondTimed) continue;
    if (secondTimed.startSec - firstTimed.endSec <= LINKED_GAP_MAX_SEC) return true;
  }
  return false;
}

/**
 * ペア系issue（2語）に referenceLinked を付与した新配列を返す（1語のissueはそのまま）。
 */
export function annotateIssuesWithLinking(args: {
  issues: PhenomenonIssue[];
  /** alignWords(scriptWords, refWords.map(w=>w.word)) の結果。 */
  refMarks: WordMark[];
  /** validateTimedWords 通過済みのお手本タイミング列。 */
  refWords: TimedWord[];
}): PhenomenonIssue[] {
  const { issues, refMarks, refWords } = args;
  return issues.map((issue) => {
    if (issue.words.length !== 2) return issue;
    return isReferenceLinked(issue, refMarks, refWords) ? { ...issue, referenceLinked: true } : issue;
  });
}

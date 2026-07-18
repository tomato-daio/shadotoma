/**
 * 添削スコア(matchRate/WPM)の算出と、Good Point / Development Pointのルールベース生成
 * （DESIGN.md §8手順4・5）。
 *
 * 生成する文言は、可能な限り「どの文の話か」を明記し、文単位の根拠を持たせる
 * （M2申し送り事項: fetch-voaの小見出し混入バグにより文脈のない誤指摘が起きた反省を踏まえ、
 * 集計だけでなく具体的な文を引用する）。
 *
 * 純関数のみを公開し、DOM/ブラウザAPIには依存しない。
 */

import type { WordMark } from './align';

export interface SentenceLike {
  en: string;
}

export interface FeedbackInput {
  wordMarks: WordMark[];
  sentences: SentenceLike[];
  /** このスクリプトに対応しない、認識された余分な語（align.tsのinsertions）。 */
  insertions?: string[];
  /** 提出音声から算出したWPM（DESIGN.md §8: 認識語数/録音秒×60）。 */
  wpm: number;
  /** お手本音声のWPM（スクリプト総語数/お手本再生時間×60）。無ければ速度比較は行わない。 */
  referenceWpm?: number;
  /** 前回提出のmatchRate。無ければ前回比の言及は行わない。 */
  previousMatchRate?: number;
}

export interface FeedbackResult {
  goodPoints: string[];
  devPoints: string[];
}

const GOOD_POINTS_COUNT = 3;
const DEV_POINTS_COUNT = 3;
/** 速度がお手本比でこの割合を超えて外れていたら指摘する（DESIGN.md §8: ±15%以内か）。 */
const WPM_TOLERANCE_RATIO = 0.15;
/** 最長連続一致区間として言及に値する最小語数。 */
const NOTABLE_STREAK_MIN_LENGTH = 4;
/** 「挿入語ゼロ」を褒める条件として要求する最低一致率（全語missedのような空認識で誤って褒めないため）。 */
const NO_INSERTION_PRAISE_MIN_MATCH_RATE = 0.3;
/** 認識語数（ok+sub+insertions）がスクリプト語数に対してこの割合を下回ったら「ほぼ認識できていない」とみなす。 */
const LOW_RECOGNITION_RATIO = 0.15;

/** wordMarksからmatchRate（0-1、スクリプト語のうち言えた割合）を計算する。 */
export function computeMatchRate(wordMarks: WordMark[]): number {
  if (wordMarks.length === 0) return 0;
  const ok = wordMarks.filter((w) => w.status === 'ok').length;
  return ok / wordMarks.length;
}

/** 認識語数と録音秒数からWPM（words per minute）を計算する。 */
export function computeWpm(recognizedWordCount: number, durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  return (recognizedWordCount / durationSec) * 60;
}

export interface OkStreak {
  /** 連続区間の長さ（語数）。 */
  length: number;
  /** wordMarks配列上の開始index。 */
  startIndex: number;
  /** 開始語の文index。 */
  si: number;
  /** 区間内の単語をスペースで結合したテキスト（表示用）。 */
  text: string;
}

/**
 * wordMarks中でstatus==='ok'が連続する最長区間を求める（DESIGN.md §8: 最長連続一致区間）。
 * 同じ長さの区間が複数あれば最初に見つかったものを返す。1件もokが無ければnull。
 */
export function longestOkStreak(wordMarks: WordMark[]): OkStreak | null {
  let best: OkStreak | null = null;
  let runStart = -1;
  let runLength = 0;

  const flush = (endIndexExclusive: number) => {
    if (runLength > 0 && (best === null || runLength > best.length)) {
      const words = wordMarks.slice(runStart, endIndexExclusive).map((w) => w.word);
      best = {
        length: runLength,
        startIndex: runStart,
        si: wordMarks[runStart].si,
        text: words.join(' '),
      };
    }
  };

  for (let i = 0; i < wordMarks.length; i++) {
    if (wordMarks[i].status === 'ok') {
      if (runLength === 0) runStart = i;
      runLength += 1;
    } else {
      flush(i);
      runLength = 0;
    }
  }
  flush(wordMarks.length);

  return best;
}

interface SentenceMissedStat {
  si: number;
  missedCount: number;
  totalCount: number;
  text: string;
}

/** missed/sub（=言えなかった語）が最も集中している文を求める（DESIGN.md §8）。 */
function findWorstSentence(wordMarks: WordMark[], sentences: SentenceLike[]): SentenceMissedStat | null {
  const bySentence = new Map<number, { missed: number; total: number }>();
  for (const mark of wordMarks) {
    const stat = bySentence.get(mark.si) ?? { missed: 0, total: 0 };
    stat.total += 1;
    if (mark.status !== 'ok') stat.missed += 1;
    bySentence.set(mark.si, stat);
  }

  let worst: SentenceMissedStat | null = null;
  for (const [si, stat] of bySentence) {
    if (stat.missed === 0) continue;
    if (
      worst === null ||
      stat.missed > worst.missedCount ||
      (stat.missed === worst.missedCount && stat.missed / stat.total > worst.missedCount / worst.totalCount)
    ) {
      worst = { si, missedCount: stat.missed, totalCount: stat.total, text: sentences[si]?.en ?? '' };
    }
  }
  return worst;
}

function truncateForDisplay(text: string, maxLength = 60): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
}

/**
 * Good Point / Development Pointをルールベースで各3件生成する（DESIGN.md §8手順5）。
 * 条件に当てはまるルールを優先度順に評価し、上位3件を採用する。3件に満たない場合は
 * 汎用的な励まし文言で補う（発生頻度は低いが、matchRate=1.0でmissed/subが無い場合などに起こる）。
 */
export function generateFeedback(input: FeedbackInput): FeedbackResult {
  const { wordMarks, sentences, wpm, referenceWpm, previousMatchRate } = input;
  const matchRate = computeMatchRate(wordMarks);
  const matchRatePercent = Math.round(matchRate * 100);
  const matchedCount = wordMarks.filter((w) => w.status === 'ok').length;
  const subCount = wordMarks.filter((w) => w.status === 'sub').length;
  const insertionsCount = input.insertions?.length ?? 0;
  // Whisperが実際に認識した語数の目安（スクリプトに対応した語 + 対応しない挿入語）。
  const recognizedWordCount = matchedCount + subCount + insertionsCount;

  const goodCandidates: string[] = [];
  const devCandidates: string[] = [];

  // 認識語がほぼ無い（空認識・雑音のみ等）場合は、他の指摘より優先して原因の心当たりを案内する。
  if (wordMarks.length > 0 && recognizedWordCount / wordMarks.length < LOW_RECOGNITION_RATIO) {
    devCandidates.push('音声がほとんど認識できませんでした。マイク位置とイヤホン使用を確認してください。');
  }

  // --- Good Points ---

  const streak = longestOkStreak(wordMarks);
  if (streak && streak.length >= NOTABLE_STREAK_MIN_LENGTH) {
    goodCandidates.push(
      `「${truncateForDisplay(streak.text)}」の${streak.length}語を、つっかえずに言えていました。`,
    );
  }

  if (previousMatchRate !== undefined) {
    const deltaPercent = Math.round((matchRate - previousMatchRate) * 100);
    if (deltaPercent > 0) {
      goodCandidates.push(`前回の一致率${Math.round(previousMatchRate * 100)}%から${deltaPercent}pt改善しました。`);
    }
  }

  if (referenceWpm !== undefined && referenceWpm > 0) {
    const ratio = wpm / referenceWpm;
    if (Math.abs(ratio - 1) <= WPM_TOLERANCE_RATIO) {
      goodCandidates.push(
        `話す速さがお手本（${Math.round(referenceWpm)} WPM）に近く、${Math.round(wpm)} WPMで発話できていました。`,
      );
    }
  }

  if (matchRate >= 0.85) {
    goodCandidates.push(`スクリプト全体の一致率が${matchRatePercent}%と高く、全体的によく聞き取れる発話でした。`);
  } else if (matchRate >= 0.6) {
    goodCandidates.push(`一致率${matchRatePercent}%で、スクリプトの半分以上をしっかり発話できていました。`);
  }

  if (matchedCount > 0 && matchRate >= NO_INSERTION_PRAISE_MIN_MATCH_RATE && insertionsCount === 0) {
    goodCandidates.push('スクリプトに無い言葉を付け足すことなく、原文に忠実に発話できていました。');
  }

  // --- Development Points ---

  const worstSentence = findWorstSentence(wordMarks, sentences);
  if (worstSentence && worstSentence.text) {
    devCandidates.push(
      `「${truncateForDisplay(worstSentence.text)}」の文で${worstSentence.missedCount}語ほど聞き取れていません。この文を重点的に練習しましょう。`,
    );
  }

  if (referenceWpm !== undefined && referenceWpm > 0) {
    const ratio = wpm / referenceWpm;
    if (ratio < 1 - WPM_TOLERANCE_RATIO) {
      devCandidates.push(
        `お手本（${Math.round(referenceWpm)} WPM）よりゆっくりめの${Math.round(wpm)} WPMでした。テンポを上げる練習をしてみましょう。`,
      );
    } else if (ratio > 1 + WPM_TOLERANCE_RATIO) {
      devCandidates.push(
        `お手本（${Math.round(referenceWpm)} WPM）より速い${Math.round(wpm)} WPMでした。焦らず、正確さを優先してみましょう。`,
      );
    }
  }

  if (subCount > 0) {
    devCandidates.push(
      `${subCount}箇所で、スクリプトと異なる語として認識されました。発音や語順を意識して聴き直してみましょう。`,
    );
  }

  if (previousMatchRate !== undefined) {
    const deltaPercent = Math.round((matchRate - previousMatchRate) * 100);
    if (deltaPercent < 0) {
      devCandidates.push(
        `前回の一致率${Math.round(previousMatchRate * 100)}%より${Math.abs(deltaPercent)}pt下がっています。もう一度スクリプトを確認してから挑戦してみましょう。`,
      );
    }
  }

  if (matchRate < 0.85) {
    devCandidates.push(
      `一致率は${matchRatePercent}%でした。0.85（85%）を超えると次の教材への切り替えを提案します。`,
    );
  }

  const goodPoints = fillToCount(goodCandidates, GOOD_POINTS_COUNT, GENERIC_GOOD_FALLBACKS, matchRatePercent);
  const devPoints = fillToCount(devCandidates, DEV_POINTS_COUNT, GENERIC_DEV_FALLBACKS, matchRatePercent);

  return { goodPoints, devPoints };
}

const GENERIC_GOOD_FALLBACKS = [
  'お手本を意識して最後まで発話をやり切りました。継続できていること自体が素晴らしいです。',
  '録音・提出という一連の練習フローにしっかり取り組めています。',
  'この調子で他の文でも同じ精度を目指してみましょう。',
];

const GENERIC_DEV_FALLBACKS = [
  '次はスピードの変化にも挑戦してみましょう。',
  'スクリプトを見ながらもう一度お手本と聴き比べてみましょう。',
  '同じ教材を数日続けて、耳と口を慣らしていきましょう。',
];

function fillToCount(candidates: string[], count: number, fallbacks: string[], matchRatePercent: number): string[] {
  const result = [...candidates];
  let fallbackIndex = 0;
  while (result.length < count && fallbackIndex < fallbacks.length) {
    const fallback = fallbacks[fallbackIndex];
    if (!result.includes(fallback)) result.push(fallback);
    fallbackIndex += 1;
  }
  // フォールバックを使い切ってもまだ足りない場合の最終手段（理論上ほぼ発生しない）。
  while (result.length < count) {
    result.push(`一致率${matchRatePercent}%でした。引き続き練習を続けましょう。`);
  }
  return result.slice(0, count);
}

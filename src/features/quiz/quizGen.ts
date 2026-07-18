/**
 * 確認テスト（穴埋め）の出題ロジック（DESIGN.md §8b）。
 *
 * - 出題対象セクションの選定（status='done'のセクションから直近最大3つ）
 * - セクションのスクリプトからの穴埋め箇所選定（内容語・1文最大2箇所・セクション3〜6箇所）
 * - 解答の正誤判定（src/lib/align.ts の正規化関数を再利用）
 *
 * 純関数のみを公開し、DOM/ブラウザAPIには依存しない（Vitestでテストする）。
 */

import { normalizeWord } from '../../lib/align';
import type { Sentence } from '../../lib/db';

// ---- 出題対象セクションの選定 ----

/** 出題対象セクションの選定に使う入力（DESIGN.md §8b: doneセクション直近最大3つ）。 */
export interface DoneSectionCandidate {
  /** セクション番号（同日内で複数doneの場合のタイブレークに使う）。 */
  part: number;
  /** そのセクションが「直近」かどうかの目安（MaterialProgress.daysPracticedの最新日など、"YYYY-MM-DD"）。 */
  lastPracticedDate: string;
}

const DEFAULT_MAX_SECTIONS = 3;

/**
 * status='done'のセクション候補から、出題対象を直近最大maxCount件選ぶ（DESIGN.md §8b）。
 * lastPracticedDateの降順（同日ならpart降順）でソートして先頭から採用する。
 */
export function selectRecentDoneSections<T extends DoneSectionCandidate>(
  candidates: T[],
  maxCount: number = DEFAULT_MAX_SECTIONS,
): T[] {
  return [...candidates]
    .sort((a, b) => b.lastPracticedDate.localeCompare(a.lastPracticedDate) || b.part - a.part)
    .slice(0, maxCount);
}

// ---- 穴埋め生成 ----

export interface QuizBlank {
  /** セクション内の文index（Material.sentences基準）。 */
  sentenceIndex: number;
  /** 文中の単語index（空白区切りのトークン基準）。 */
  wordIndex: number;
  /** 正答（スクリプト上の元の表記。判定はnormalizeWordで正規化して比較する）。 */
  answer: string;
}

/** 内容語とみなす最低の英字（アルファベット）文字数（DESIGN.md §8b）。 */
const MIN_CONTENT_WORD_LENGTH = 4;
/** 1文あたりの空欄上限（DESIGN.md §8b）。 */
const MAX_BLANKS_PER_SENTENCE = 2;
/** セクションあたりの空欄数の範囲（DESIGN.md §8b: 3〜6箇所）。 */
const MIN_SECTION_BLANKS = 3;
const MAX_SECTION_BLANKS = 6;

/**
 * 内容語から除外するストップワード（the/and/that等の機能語）。
 * 短縮形はアポストロフィ除去後の形（"don't" -> "dont"）で登録する。
 * 4文字未満の語（a, an, the, and, but, for, ...）は別途MIN_CONTENT_WORD_LENGTHで除外されるため含めない。
 */
const STOPWORDS = new Set([
  // 指示・関係詞
  'that', 'this', 'these', 'those', 'which', 'where', 'when', 'what', 'whose', 'whom',
  // 前置詞
  'with', 'from', 'into', 'onto', 'upon', 'unto', 'about', 'above', 'below', 'beneath',
  'beside', 'beyond', 'across', 'along', 'around', 'behind', 'between', 'among', 'during',
  'through', 'throughout', 'toward', 'towards', 'under', 'until', 'within', 'without', 'inside', 'outside',
  // 接続詞・副詞的つなぎ語
  'than', 'then', 'because', 'while', 'after', 'before', 'although', 'though', 'since', 'unless',
  'also', 'only', 'just', 'still', 'again', 'once', 'even', 'very', 'more', 'most', 'some', 'such',
  'over', 'here', 'there', 'both', 'each', 'every', 'other', 'another',
  // be/have/do系の活用形
  'have', 'has', 'had', 'having', 'were', 'been', 'being', 'does', 'doing', 'done',
  // 助動詞・法助動詞
  'will', 'shall', 'must', 'would', 'could', 'should', 'might',
  // 代名詞
  'they', 'them', 'their', 'theirs', 'your', 'yours', 'ours', 'hers', 'mine',
  'itself', 'himself', 'herself', 'myself', 'themselves', 'ourselves', 'yourself', 'yourselves',
  // 短縮形（内部アポストロフィ除去後の形）
  'wont', 'cant', 'dont', 'didnt', 'doesnt', 'isnt', 'arent', 'wasnt', 'werent',
  'havent', 'hasnt', 'hadnt', 'wouldnt', 'couldnt', 'shouldnt',
]);

function extractAlpha(token: string): string {
  return token.replace(/[^A-Za-z]/g, '');
}

/** 内容語（英字4文字以上・ストップワード除外）かどうかを判定する（DESIGN.md §8b）。 */
export function isContentWord(token: string): boolean {
  const alpha = extractAlpha(token);
  if (alpha.length < MIN_CONTENT_WORD_LENGTH) return false;
  return !STOPWORDS.has(alpha.toLowerCase());
}

interface WordToken {
  sentenceIndex: number;
  wordIndex: number;
  word: string;
}

function tokenizeSentences(sentences: Sentence[]): WordToken[] {
  const tokens: WordToken[] = [];
  sentences.forEach((sentence, sentenceIndex) => {
    sentence.en.split(/\s+/).forEach((word, wordIndex) => {
      if (word.length > 0) tokens.push({ sentenceIndex, wordIndex, word });
    });
  });
  return tokens;
}

/** Fisher-Yatesシャッフル（rng注入によりテストで決定論的に検証できる）。 */
function shuffle<T>(items: T[], rng: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** 3〜6の範囲でセクションの目標空欄数を決める（候補が少なければ候補数まで下げる。DESIGN.md §8b）。 */
function pickTargetBlankCount(maxPossible: number, rng: () => number): number {
  if (maxPossible <= MIN_SECTION_BLANKS) return maxPossible;
  const upper = Math.min(maxPossible, MAX_SECTION_BLANKS);
  const range = upper - MIN_SECTION_BLANKS + 1;
  return MIN_SECTION_BLANKS + Math.floor(rng() * range);
}

/**
 * セクションのスクリプトから穴埋め箇所を選ぶ（DESIGN.md §8b）。
 * - 内容語（英字4文字以上・ストップワード除外）から無作為に選ぶ
 * - 1文あたり最大2箇所・セクションあたり3〜6箇所（内容語の候補が少なければそれ以下になる）
 * - 内容語が1つも無いセクションは空配列を返す（安全化。呼び出し側は0件なら出題をスキップする）
 *
 * @param sentences 対象セクションのスクリプト。
 * @param rng 0以上1未満の乱数を返す関数。省略時はMath.random（呼び出し側でcrypto.getRandomValues由来のrngを渡してもよい。DESIGN.md §8b）。
 */
export function generateSectionBlanks(sentences: Sentence[], rng: () => number = Math.random): QuizBlank[] {
  const perSentence = new Map<number, WordToken[]>();
  for (const token of tokenizeSentences(sentences)) {
    if (!isContentWord(token.word)) continue;
    const list = perSentence.get(token.sentenceIndex) ?? [];
    list.push(token);
    perSentence.set(token.sentenceIndex, list);
  }

  const allCandidates = [...perSentence.values()].flat();
  if (allCandidates.length === 0) return [];

  const maxPossible = [...perSentence.values()].reduce(
    (sum, list) => sum + Math.min(list.length, MAX_BLANKS_PER_SENTENCE),
    0,
  );
  const target = pickTargetBlankCount(maxPossible, rng);

  const perSentenceCount = new Map<number, number>();
  const selected: WordToken[] = [];
  for (const token of shuffle(allCandidates, rng)) {
    if (selected.length >= target) break;
    const count = perSentenceCount.get(token.sentenceIndex) ?? 0;
    if (count >= MAX_BLANKS_PER_SENTENCE) continue;
    perSentenceCount.set(token.sentenceIndex, count + 1);
    selected.push(token);
  }

  return selected
    .sort((a, b) => a.sentenceIndex - b.sentenceIndex || a.wordIndex - b.wordIndex)
    .map((t) => ({ sentenceIndex: t.sentenceIndex, wordIndex: t.wordIndex, answer: t.word }));
}

/**
 * crypto.getRandomValuesを使った0以上1未満の乱数（DESIGN.md §8b: 「乱数はcrypto.getRandomValues可」）。
 * 利用できない環境ではMath.randomにフォールバックする。generateSectionBlanksへ渡すデフォルト実装として使う。
 */
export function cryptoRandom(): number {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0] / 0x100000000;
  }
  return Math.random();
}

// ---- 採点 ----

/**
 * 1問分の正誤判定（DESIGN.md §8b: align.tsの正規化関数を再利用し、正規化後一致で正解）。
 * 正答側が正規化後に空文字になるような異常データは、事故的な正解扱いを避けるため不正解とする。
 */
export function isBlankCorrect(userAnswer: string, correctAnswer: string): boolean {
  const normalizedAnswer = normalizeWord(correctAnswer);
  if (normalizedAnswer === '') return false;
  return normalizeWord(userAnswer) === normalizedAnswer;
}

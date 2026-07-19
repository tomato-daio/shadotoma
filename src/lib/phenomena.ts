/**
 * 音声現象ベースの検出器（DESIGN.md §8「5b. 音声現象ベースの指摘と前回比較（M7）」）。
 *
 * スクリプト文とalign結果のwordMarksから、シャドーイングでつまずきやすい5つの音声現象
 * （リンキング/フラップ/脱落/弱形/語尾-s,-ed）に関わる箇所を検出する。
 * 音素解析はせず、正規化した単語の文字列パターンとmissed/subのステータスから
 * ヒューリスティックに「できていない候補」を挙げる純関数群のみを公開する。
 */

import type { WordMark } from './align';

export type PhenomenonType = 'linking' | 'flap' | 'elision' | 'weak' | 'ending';

export interface PhenomenonIssue {
  type: PhenomenonType;
  /** 対象語（表示用の原文のまま）。ペアなら2語、単語単位の現象なら1語。 */
  words: string[];
  /** 文index（Material.sentencesのインデックス）。 */
  si: number;
}

export interface SentenceLike {
  en: string;
}

/** 前回提出の指摘が今回改善したかどうか（DESIGN.md §8 5b「前回比較」）。 */
export interface PreviousIssueOutcome {
  type: PhenomenonType;
  words: string[];
  improved: boolean;
}

// ---- 正規化ヘルパー ----

/**
 * 前後の約物を除去し小文字化する（align.tsのnormalizeWordより単純: 内部のアポストロフィは保持する）。
 * feedback.ts（M8: 実語ベースのDevelopment Point文言）が語頭・語末の文字抽出と
 * カタカナ辞書の照合に再利用するため公開する。
 */
export function stripPunct(word: string): string {
  return word
    .toLowerCase()
    .replace(/^[^a-z']+/, '')
    .replace(/[^a-z']+$/, '');
}

const VOWEL_RE = /^[aeiou]/;
const CONSONANT_LETTER_RE = /[a-z]/;

function startsWithVowelSound(word: string): boolean {
  const w = stripPunct(word);
  return VOWEL_RE.test(w);
}

function startsWithConsonantSound(word: string): boolean {
  const w = stripPunct(word);
  return w.length > 0 && CONSONANT_LETTER_RE.test(w[0]) && !VOWEL_RE.test(w);
}

/** 語末の子音（t以外。tはフラップとして別扱いするためlinkingでは除外する）。 */
function endsWithNonTConsonant(word: string): boolean {
  const w = stripPunct(word);
  if (w.length === 0) return false;
  const last = w[w.length - 1];
  return CONSONANT_LETTER_RE.test(last) && !VOWEL_RE.test(last) && last !== 't';
}

function endsWithT(word: string): boolean {
  const w = stripPunct(word);
  return w.endsWith('t');
}

/** 語末の破裂音（p/t/k/b/d/g）。脱落（エリジョン）検出に使う。 */
const PLOSIVES = new Set(['p', 't', 'k', 'b', 'd', 'g']);
function endsWithPlosive(word: string): boolean {
  const w = stripPunct(word);
  if (w.length === 0) return false;
  return PLOSIVES.has(w[w.length - 1]);
}

/** 母音に挟まれた t/tt を1語の中に含むか（water, better のパターン）。 */
const INTERVOCALIC_T_RE = /[aeiou]tt?[aeiouy]/;
function hasIntervocalicT(word: string): boolean {
  return INTERVOCALIC_T_RE.test(stripPunct(word));
}

/** 弱形になりやすい代表的な機能語（DESIGN.md §8 5b: of, to, for, and, them, can等）。 */
const WEAK_FORM_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'can', 'could', 'do', 'does', 'for', 'from',
  'had', 'has', 'have', 'he', 'her', 'him', 'his', 'is', 'must', 'of', 'shall', 'she',
  'should', 'some', 'than', 'that', 'the', 'them', 'to', 'us', 'was', 'we', 'were',
  'who', 'would', 'you', 'your', 'are', 'am', 'been', 'or', 'not', 'there',
]);

function stemCandidatesForEd(word: string): string[] {
  const candidates: string[] = [];
  if (word.length > 4 && word.endsWith('ed')) candidates.push(word.slice(0, -2)); // wanted -> want
  if (word.length > 3 && word.endsWith('d') && !word.endsWith('ed')) candidates.push(word.slice(0, -1)); // smiled -> smile(d除去)
  return candidates;
}

function stemCandidatesForS(word: string): string[] {
  const candidates: string[] = [];
  if (word.length > 4 && word.endsWith('es')) candidates.push(word.slice(0, -2)); // watches -> watch
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) candidates.push(word.slice(0, -1)); // wants -> want
  return candidates;
}

// ---- 個別検出器 ----

/** リンキング（連結）: 子音終わり語(t以外)+母音始まり語のペアで、どちらかがmissed/subのもの。 */
function detectLinking(wordMarks: WordMark[]): PhenomenonIssue[] {
  const issues: PhenomenonIssue[] = [];
  for (let i = 0; i < wordMarks.length - 1; i++) {
    const w1 = wordMarks[i];
    const w2 = wordMarks[i + 1];
    if (w1.si !== w2.si) continue;
    if (!endsWithNonTConsonant(w1.word) || !startsWithVowelSound(w2.word)) continue;
    if (w1.status === 'ok' && w2.status === 'ok') continue;
    issues.push({ type: 'linking', words: [w1.word, w2.word], si: w1.si });
  }
  return issues;
}

/** フラップ: 1語内の母音に挟まれたt/tt、または語末tの語+母音始まり語のペア。 */
function detectFlap(wordMarks: WordMark[]): PhenomenonIssue[] {
  const issues: PhenomenonIssue[] = [];
  for (let i = 0; i < wordMarks.length; i++) {
    const w = wordMarks[i];
    if (w.status === 'ok') continue;
    if (hasIntervocalicT(w.word)) {
      issues.push({ type: 'flap', words: [w.word], si: w.si });
    }
  }
  for (let i = 0; i < wordMarks.length - 1; i++) {
    const w1 = wordMarks[i];
    const w2 = wordMarks[i + 1];
    if (w1.si !== w2.si) continue;
    if (!endsWithT(w1.word) || !startsWithVowelSound(w2.word)) continue;
    if (w1.status === 'ok' && w2.status === 'ok') continue;
    issues.push({ type: 'flap', words: [w1.word, w2.word], si: w1.si });
  }
  return issues;
}

/** 脱落（エリジョン）: 語末破裂音+子音始まり語のペアで、いずれかがmissed。 */
function detectElision(wordMarks: WordMark[]): PhenomenonIssue[] {
  const issues: PhenomenonIssue[] = [];
  for (let i = 0; i < wordMarks.length - 1; i++) {
    const w1 = wordMarks[i];
    const w2 = wordMarks[i + 1];
    if (w1.si !== w2.si) continue;
    if (!endsWithPlosive(w1.word) || !startsWithConsonantSound(w2.word)) continue;
    if (w1.status !== 'missed' && w2.status !== 'missed') continue;
    issues.push({ type: 'elision', words: [w1.word, w2.word], si: w1.si });
  }
  return issues;
}

/** 弱形: 機能語がmissed（弱く速く発音されて聞き取れなかった可能性）。 */
function detectWeakForms(wordMarks: WordMark[]): PhenomenonIssue[] {
  const issues: PhenomenonIssue[] = [];
  for (const w of wordMarks) {
    if (w.status !== 'missed') continue;
    if (WEAK_FORM_WORDS.has(stripPunct(w.word))) {
      issues.push({ type: 'weak', words: [w.word], si: w.si });
    }
  }
  return issues;
}

/** 語尾の-s/-ed: subで語幹が一致し語尾だけ違う（wanted -> want のように認識されたもの）。 */
function detectEndings(wordMarks: WordMark[]): PhenomenonIssue[] {
  const issues: PhenomenonIssue[] = [];
  for (const w of wordMarks) {
    if (w.status !== 'sub' || !w.recognized) continue;
    const scriptWord = stripPunct(w.word);
    const recognizedWord = stripPunct(w.recognized);
    if (!scriptWord || !recognizedWord || scriptWord === recognizedWord) continue;
    const candidates = [...stemCandidatesForEd(scriptWord), ...stemCandidatesForS(scriptWord)];
    if (candidates.some((stem) => stem.length >= 2 && stem === recognizedWord)) {
      issues.push({ type: 'ending', words: [w.word], si: w.si });
    }
  }
  return issues;
}

/**
 * 5つの音声現象すべてを検出する（未ソート・未上限の生データ）。
 * 優先度順への並べ替え・件数の絞り込みは {@link prioritizeIssues} で行う。
 */
export function detectPhenomena(sentences: SentenceLike[], wordMarks: WordMark[]): PhenomenonIssue[] {
  // 隣接語ペアに依存する検出器（linking/flap-across/elision）は、wordMarksがスクリプト全体を
  // 過不足なくカバーしていて初めて「隣接＝原文で隣接」が保証できる。ずれている場合
  // （呼び出し側の不整合）はペア検出をスキップし、単語単位の検出器のみ行う安全側に倒す。
  const scriptWordCount = sentences.reduce((sum, s) => sum + s.en.split(/\s+/).filter(Boolean).length, 0);
  const positionsReliable = scriptWordCount === wordMarks.length;

  const pairBased = positionsReliable ? [...detectLinking(wordMarks), ...detectElision(wordMarks)] : [];
  const flapIssues = positionsReliable
    ? detectFlap(wordMarks)
    : detectFlap(wordMarks).filter((issue) => issue.words.length === 1);

  return [...pairBased, ...flapIssues, ...detectWeakForms(wordMarks), ...detectEndings(wordMarks)];
}

/**
 * 検出結果を優先度順（同一typeの多発 > 単発）に並べ替え、上位limit件へ絞る（DESIGN.md §8 5b）。
 * 同じtypeの出現数が多いほど優先し、同点内は検出順（Array.sortは安定ソート）を保つ。
 */
export function prioritizeIssues(issues: PhenomenonIssue[], limit = 3): PhenomenonIssue[] {
  const countByType = new Map<PhenomenonType, number>();
  for (const issue of issues) {
    countByType.set(issue.type, (countByType.get(issue.type) ?? 0) + 1);
  }
  const sorted = [...issues].sort((a, b) => (countByType.get(b.type) ?? 0) - (countByType.get(a.type) ?? 0));
  return sorted.slice(0, limit);
}

/**
 * 前回提出の指摘（issues）が今回のwordMarksでokになったかを判定する（DESIGN.md §8 5b「前回比較」）。
 * 対象語すべてが同じ文(si)・同じ表記でstatus==='ok'になっていればimproved=trueとする
 * （音素解析はしないヒューリスティック。同一文内に同名の語が複数ある場合は既知の限界として扱う）。
 */
export function comparePreviousIssues(
  previousIssues: PhenomenonIssue[],
  wordMarks: WordMark[],
): PreviousIssueOutcome[] {
  return previousIssues.map((issue) => {
    const improved = issue.words.every((word) =>
      wordMarks.some((mark) => mark.si === issue.si && mark.word === word && mark.status === 'ok'),
    );
    return { type: issue.type, words: issue.words, improved };
  });
}

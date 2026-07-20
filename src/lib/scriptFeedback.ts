/**
 * 練習画面のスクリプトに「前回の提出でできた/できなかった箇所」を重ねるためのデータ構築（純関数）。
 *
 * - できなかった語（wordMarksのmissed/sub、および指摘issuesの対象箇所）→ ピンクハイライト
 * - 前回指摘から改善した箇所（previousIssueOutcomesのimproved=true）→ 青緑ハイライト
 * - Development（今回の指摘）/ Good（改善した指摘）のコメントカード。ハイライト語のタップで
 *   開閉できるよう、語→カードの対応（FeedbackWord.cardIndices）を保持する。タップアンカーが
 *   1つも無いカードは anchored=false とし、表示側は常時表示にフォールバックする。
 *
 * wordMarksはスクリプト単語と配列順1:1（align.tsのbuildScriptWordsと同じ空白分割）という
 * 不変条件に依存する。教材の差し替え等で語数が合わない場合はハイライトを諦めてプレーン表示に
 * フォールバックし、カードも「対象語が現行スクリプトのその文に実在する」ものだけ表示する
 * （phenomena.tsのpositionsReliableと同じ安全側の判定）。
 */

import type { JudgeResult, Sentence, WordMark } from './db';
import type { PhenomenonType, PreviousIssueOutcome } from './phenomena';

export type WordHighlight = 'miss' | 'improved';

export interface FeedbackCard {
  kind: 'dev' | 'good';
  type: PhenomenonType;
  words: string[];
  /**
   * タップで開閉できる語アンカーが文中に1つ以上あるか。falseのカード（語数不一致フォールバック時・
   * 位置マッチ0件の旧データ等）はタップ手段が無いため、表示側で常時表示にフォールバックする。
   */
  anchored: boolean;
  /**
   * カードを差し込む位置（文内の語index。一致した語のうち最後の位置）。開いたカードは
   * この語の直後に割り込み表示する（シャドテン風）。anchored=falseでは未設定。
   */
  anchorPosition?: number;
}

export interface FeedbackWord {
  text: string;
  highlight: WordHighlight | null;
  /** この語のタップで開閉するカード（SentenceFeedback.cards内のindex）。空なら非タップ。 */
  cardIndices: number[];
}

export interface SentenceFeedback {
  /** 単語単位のハイライト。null = wordMarksとスクリプトの対応が取れず、この文はプレーン表示にする。 */
  words: FeedbackWord[] | null;
  /** この文に紐づくコメントカード（dev=今回の指摘 / good=改善した前回指摘。登録順に表示）。 */
  cards: FeedbackCard[];
}

/** 表示すべきハイライト・カードが1つでもあるか（トグルUIを出すかどうかの判定に使う）。 */
export function hasAnyFeedback(feedback: SentenceFeedback[]): boolean {
  return feedback.some(
    (f) => f.cards.length > 0 || (f.words !== null && f.words.some((w) => w.highlight !== null)),
  );
}

/**
 * outcome.wordsが全て同一文内にstatus==='ok'で存在する最初の文indexを返す。
 * si付きのoutcome（M14以降の保存データ）には不要で、siを持たない旧データ専用のフォールバック。
 * the/to等の頻出語では手前の文に誤ヒットしうる既知の限界がある（siがあれば正確）。
 */
function findOutcomeSentence(outcome: PreviousIssueOutcome, wordMarks: WordMark[]): number | null {
  const sentenceIndices = [...new Set(wordMarks.map((m) => m.si))].sort((a, b) => a - b);
  for (const si of sentenceIndices) {
    const inSentence = wordMarks.filter((m) => m.si === si);
    if (outcome.words.every((word) => inSentence.some((m) => m.word === word && m.status === 'ok'))) {
      return si;
    }
  }
  return null;
}

/**
 * 文内のmark列から、語列wordsに（隣接して）一致しacceptを満たす位置（文内index）を列挙する。
 * 語テキストだけをキーにすると同一文内の同名トークン（頻出語のthe等）まで巻き添えで塗ってしまうため、
 * 位置ベースで照合する。
 */
function findMatchPositions(
  marks: WordMark[] | undefined,
  words: string[],
  accept: (slice: WordMark[]) => boolean,
): number[] {
  if (!marks || words.length === 0) return [];
  const positions = new Set<number>();
  for (let k = 0; k + words.length <= marks.length; k++) {
    const slice = marks.slice(k, k + words.length);
    if (!slice.every((m, j) => m.word === words[j])) continue;
    if (!accept(slice)) continue;
    for (let j = 0; j < words.length; j++) {
      positions.add(k + j);
    }
  }
  return [...positions];
}

/** 直近の判定結果から、文ごとのハイライト・カード情報を組み立てる。judge未指定（初回練習）は空を返す。 */
export function buildScriptFeedback(sentences: Sentence[], judge?: JudgeResult): SentenceFeedback[] {
  if (!judge) {
    return sentences.map(() => ({ words: null, cards: [] }));
  }

  const wordMarks = judge.wordMarks ?? [];
  const scriptWords = sentences.map((s) => s.en.split(/\s+/).filter(Boolean));
  const totalWords = scriptWords.reduce((sum, words) => sum + words.length, 0);
  // buildScriptWordsと同じ分割での総語数が一致して初めて「配列順=スクリプト語順」を信頼できる。
  const reliable = totalWords > 0 && totalWords === wordMarks.length;

  // 文indexごとのwordMarks（配列順を保つ）
  const marksBySentence = new Map<number, WordMark[]>();
  if (reliable) {
    for (const mark of wordMarks) {
      const list = marksBySentence.get(mark.si) ?? [];
      list.push(mark);
      marksBySentence.set(mark.si, list);
    }
  }

  // 対象語が現行スクリプトの文siに実在するか。教材の再分割（DESIGN.md §7b）で旧提出のsiが
  // 別の文を指すようになったカードを、無関係な文の下に出さないためのゲート。
  const wordsExistIn = (si: number, words: string[]): boolean =>
    si >= 0 && si < sentences.length && words.every((w) => scriptWords[si].includes(w));

  const missPositions = new Set<string>();
  const improvedPositions = new Set<string>();
  const cardsBySentence = new Map<number, FeedbackCard[]>();
  const cardIndicesByPosition = new Map<string, number[]>();

  /** カードを登録し、一致位置にハイライトと語→カードの対応を付ける。 */
  const addCard = (
    si: number,
    kind: FeedbackCard['kind'],
    type: PhenomenonType,
    words: string[],
    highlightTarget: Set<string>,
    accept: (slice: WordMark[]) => boolean,
  ): void => {
    const list = cardsBySentence.get(si) ?? [];
    const cardIndex = list.length;
    const positions = findMatchPositions(marksBySentence.get(si), words, accept);
    for (const k of positions) {
      const key = `${si}:${k}`;
      highlightTarget.add(key);
      const indices = cardIndicesByPosition.get(key) ?? [];
      indices.push(cardIndex);
      cardIndicesByPosition.set(key, indices);
    }
    if (positions.length > 0) {
      list.push({ kind, type, words, anchored: true, anchorPosition: Math.max(...positions) });
    } else {
      list.push({ kind, type, words, anchored: false });
    }
    cardsBySentence.set(si, list);
  };

  // 今回の指摘（Developmentカード + 対象箇所のピンク。ペアはok側のメンバーも含めて塗る）
  for (const issue of judge.issues ?? []) {
    if (!wordsExistIn(issue.si, issue.words)) continue;
    addCard(issue.si, 'dev', issue.type, issue.words, missPositions, (slice) =>
      slice.some((m) => m.status !== 'ok'),
    );
  }

  // 改善した前回指摘（Goodカード + 対象箇所の青緑）。si付き（M14以降）はそれを使い、
  // si無しの旧データのみ逆引きにフォールバック。逆引き失敗・語が実在しない場合はスキップ。
  for (const outcome of judge.previousIssueOutcomes ?? []) {
    if (!outcome.improved) continue;
    const si = outcome.si ?? findOutcomeSentence(outcome, wordMarks);
    if (si === null || !wordsExistIn(si, outcome.words)) continue;
    addCard(si, 'good', outcome.type, outcome.words, improvedPositions, (slice) =>
      slice.every((m) => m.status === 'ok'),
    );
  }

  return sentences.map((_s, si) => {
    const marks = reliable ? (marksBySentence.get(si) ?? []) : null;
    let words: FeedbackWord[] | null = null;
    if (marks !== null && marks.length === scriptWords[si].length) {
      words = scriptWords[si].map((text, k) => {
        const key = `${si}:${k}`;
        const cardIndices = cardIndicesByPosition.get(key) ?? [];
        // ピンク優先: できていない箇所は改善ハイライトより「今できていない」ことを優先して見せる
        if (marks[k].status !== 'ok' || missPositions.has(key)) {
          return { text, highlight: 'miss' as const, cardIndices };
        }
        if (improvedPositions.has(key)) {
          return { text, highlight: 'improved' as const, cardIndices };
        }
        return { text, highlight: null, cardIndices };
      });
    }
    const cards = cardsBySentence.get(si) ?? [];
    // words=nullの文はアンカーの語が描画されないため、カードは常時表示へフォールバックする。
    const normalizedCards =
      words === null
        ? cards.map((c) => (c.anchored ? { kind: c.kind, type: c.type, words: c.words, anchored: false } : c))
        : cards;
    return { words, cards: normalizedCards };
  });
}

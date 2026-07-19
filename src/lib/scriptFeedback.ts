/**
 * 練習画面のスクリプトに「前回の提出でできた/できなかった箇所」を重ねるためのデータ構築（純関数）。
 *
 * - できなかった語（wordMarksのmissed/sub、および指摘issuesの対象語）→ ピンクハイライト
 * - 前回指摘から改善した語（previousIssueOutcomesのimproved=true）→ 青緑ハイライト
 * - 文の直下に Development（今回の指摘）/ Good（改善した指摘）のコメントカード
 *
 * wordMarksはスクリプト単語と配列順1:1（align.tsのbuildScriptWordsと同じ空白分割）という
 * 不変条件に依存する。教材の差し替え等で語数が合わない場合はハイライトを諦めて
 * プレーン表示にフォールバックする（phenomena.tsのpositionsReliableと同じ安全側の判定）。
 */

import type { JudgeResult, Sentence, WordMark } from './db';
import type { PhenomenonIssue, PreviousIssueOutcome } from './phenomena';

export type WordHighlight = 'miss' | 'improved';

export interface FeedbackWord {
  text: string;
  highlight: WordHighlight | null;
}

export interface SentenceFeedback {
  /** 単語単位のハイライト。null = wordMarksとスクリプトの対応が取れず、この文はプレーン表示にする。 */
  words: FeedbackWord[] | null;
  /** この文に紐づく今回の指摘（Developmentカード）。 */
  devIssues: PhenomenonIssue[];
  /** この文に紐づく改善した前回指摘（Goodカード）。 */
  improvedOutcomes: PreviousIssueOutcome[];
}

/** 表示すべきハイライト・カードが1つでもあるか（トグルUIを出すかどうかの判定に使う）。 */
export function hasAnyFeedback(feedback: SentenceFeedback[]): boolean {
  return feedback.some(
    (f) =>
      f.devIssues.length > 0 ||
      f.improvedOutcomes.length > 0 ||
      (f.words !== null && f.words.some((w) => w.highlight !== null)),
  );
}

/**
 * outcome.wordsが全て同一文内にstatus==='ok'で存在する最初の文indexを返す。
 * PreviousIssueOutcomeはsiを持たないため、comparePreviousIssuesのimproved判定と同じ条件で
 * 逆引きする（同名語が複数文にある場合は最初の文に付く既知の限界を許容）。
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

/** 直近の判定結果から、文ごとのハイライト・カード情報を組み立てる。judge未指定（初回練習）は空を返す。 */
export function buildScriptFeedback(sentences: Sentence[], judge?: JudgeResult): SentenceFeedback[] {
  if (!judge) {
    return sentences.map(() => ({ words: null, devIssues: [], improvedOutcomes: [] }));
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

  // 今回の指摘（Developmentカード + 対象語のピンクハイライト）
  const issuesBySentence = new Map<number, PhenomenonIssue[]>();
  const issueWordKeys = new Set<string>();
  for (const issue of judge.issues ?? []) {
    if (issue.si < 0 || issue.si >= sentences.length) continue;
    const list = issuesBySentence.get(issue.si) ?? [];
    list.push(issue);
    issuesBySentence.set(issue.si, list);
    for (const word of issue.words) {
      issueWordKeys.add(`${issue.si}:${word}`);
    }
  }

  // 改善した前回指摘（Goodカード + 対象語の青緑ハイライト）。siは逆引きし、失敗分はスキップする。
  const improvedBySentence = new Map<number, PreviousIssueOutcome[]>();
  const improvedWordKeys = new Set<string>();
  for (const outcome of judge.previousIssueOutcomes ?? []) {
    if (!outcome.improved) continue;
    const si = findOutcomeSentence(outcome, wordMarks);
    if (si === null || si >= sentences.length) continue;
    const list = improvedBySentence.get(si) ?? [];
    list.push(outcome);
    improvedBySentence.set(si, list);
    for (const word of outcome.words) {
      improvedWordKeys.add(`${si}:${word}`);
    }
  }

  return sentences.map((_s, si) => {
    const marks = reliable ? (marksBySentence.get(si) ?? []) : null;
    let words: FeedbackWord[] | null = null;
    if (marks !== null && marks.length === scriptWords[si].length) {
      words = scriptWords[si].map((text, k) => {
        const mark = marks[k];
        const key = `${si}:${mark.word}`;
        // ピンク優先: できていない語は改善ハイライトより「今できていない」ことを優先して見せる
        if (mark.status !== 'ok' || issueWordKeys.has(key)) return { text, highlight: 'miss' as const };
        if (improvedWordKeys.has(key)) return { text, highlight: 'improved' as const };
        return { text, highlight: null };
      });
    }
    return {
      words,
      devIssues: issuesBySentence.get(si) ?? [],
      improvedOutcomes: improvedBySentence.get(si) ?? [],
    };
  });
}

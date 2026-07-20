import { describe, expect, it } from 'vitest';
import type { JudgeResult, Sentence, WordMark } from './db';
import { buildScriptFeedback, hasAnyFeedback } from './scriptFeedback';

function mark(word: string, si: number, status: WordMark['status'], recognized?: string): WordMark {
  return recognized !== undefined ? { word, si, status, recognized } : { word, si, status };
}

function makeJudge(overrides: Partial<JudgeResult> = {}): JudgeResult {
  return {
    matchRate: 0.8,
    wpm: 120,
    wordMarks: [],
    goodPoints: [],
    devPoints: [],
    engine: 'whisper-local',
    ...overrides,
  };
}

const SENTENCES: Sentence[] = [{ en: 'They turned on the light.' }, { en: 'I need some water now.' }];

/** SENTENCESと語数一致（5+5=10語）のwordMarks。 */
function matchingMarks(): WordMark[] {
  return [
    mark('They', 0, 'ok'),
    mark('turned', 0, 'missed'),
    mark('on', 0, 'ok'),
    mark('the', 0, 'ok'),
    mark('light.', 0, 'sub', 'night'),
    mark('I', 1, 'ok'),
    mark('need', 1, 'ok'),
    mark('some', 1, 'ok'),
    mark('water', 1, 'ok'),
    mark('now.', 1, 'ok'),
  ];
}

describe('buildScriptFeedback', () => {
  it('judge未指定（初回練習）は全文プレーン・カードなし', () => {
    const feedback = buildScriptFeedback(SENTENCES, undefined);
    expect(feedback).toHaveLength(2);
    expect(feedback.every((f) => f.words === null && f.cards.length === 0)).toBe(true);
    expect(hasAnyFeedback(feedback)).toBe(false);
  });

  it('missed/subの語にピンク(miss)ハイライトを付ける', () => {
    const judge = makeJudge({ wordMarks: matchingMarks() });
    const feedback = buildScriptFeedback(SENTENCES, judge);
    expect(feedback[0].words).not.toBeNull();
    expect(feedback[0].words!.map((w) => w.highlight)).toEqual([null, 'miss', null, null, 'miss']);
    expect(feedback[0].words!.map((w) => w.text)).toEqual(['They', 'turned', 'on', 'the', 'light.']);
    expect(feedback[1].words!.every((w) => w.highlight === null)).toBe(true);
    // カードが無いのでどの語も非タップ
    expect(feedback[0].words!.every((w) => w.cardIndices.length === 0)).toBe(true);
    expect(hasAnyFeedback(feedback)).toBe(true);
  });

  it('スクリプトとwordMarksの語数が不一致ならハイライトなし（words=null）にフォールバックする', () => {
    const judge = makeJudge({ wordMarks: matchingMarks().slice(0, 5) });
    const feedback = buildScriptFeedback(SENTENCES, judge);
    expect(feedback[0].words).toBeNull();
    expect(feedback[1].words).toBeNull();
  });

  it('issuesをDevelopmentカードにし、ペアの両語（okの相方も含む）に同じカードindexとピンクを付ける', () => {
    const judge = makeJudge({
      wordMarks: matchingMarks(),
      issues: [{ type: 'linking', words: ['turned', 'on'], si: 0 }],
    });
    const feedback = buildScriptFeedback(SENTENCES, judge);
    // anchorPosition=2('on'の位置): カードはペア末尾の語の直後に割り込み表示される
    expect(feedback[0].cards).toEqual([
      { kind: 'dev', type: 'linking', words: ['turned', 'on'], anchored: true, anchorPosition: 2 },
    ]);
    // "on"はstatus ok だが指摘対象語なのでピンク+タップ対象にする
    expect(feedback[0].words![1]).toEqual({ text: 'turned', highlight: 'miss', cardIndices: [0] });
    expect(feedback[0].words![2]).toEqual({ text: 'on', highlight: 'miss', cardIndices: [0] });
    expect(feedback[1].cards).toHaveLength(0);
  });

  it('siが範囲外のissuesは無視する', () => {
    const judge = makeJudge({
      wordMarks: matchingMarks(),
      issues: [{ type: 'flap', words: ['water'], si: 99 }],
    });
    const feedback = buildScriptFeedback(SENTENCES, judge);
    expect(feedback.every((f) => f.cards.length === 0)).toBe(true);
  });

  it('improved=trueの前回指摘は語からsiを逆引きし、Goodカードと青緑ハイライトを付ける', () => {
    const judge = makeJudge({
      wordMarks: matchingMarks(),
      previousIssueOutcomes: [{ type: 'flap', words: ['water'], improved: true }],
    });
    const feedback = buildScriptFeedback(SENTENCES, judge);
    expect(feedback[1].cards).toEqual([{ kind: 'good', type: 'flap', words: ['water'], anchored: true, anchorPosition: 3 }]);
    expect(feedback[1].words![3]).toEqual({ text: 'water', highlight: 'improved', cardIndices: [0] });
    expect(feedback[0].cards).toHaveLength(0);
  });

  it('improved=falseの前回指摘はカードもハイライトも付けない', () => {
    const judge = makeJudge({
      wordMarks: matchingMarks(),
      previousIssueOutcomes: [{ type: 'flap', words: ['water'], improved: false }],
    });
    const feedback = buildScriptFeedback(SENTENCES, judge);
    expect(feedback.every((f) => f.cards.length === 0)).toBe(true);
  });

  it('逆引きできない前回指摘（該当語がokで存在しない）はスキップする', () => {
    const judge = makeJudge({
      wordMarks: matchingMarks(),
      // "turned"はmissedなので「同一文内に全語がokで存在」を満たせない
      previousIssueOutcomes: [{ type: 'linking', words: ['turned', 'on'], improved: true }],
    });
    const feedback = buildScriptFeedback(SENTENCES, judge);
    expect(feedback.every((f) => f.cards.length === 0)).toBe(true);
  });

  it('missとimprovedが同じ語に重なった場合はmissを優先する', () => {
    const marks = matchingMarks();
    // "the"(si0)をsubにして、同語がimproved対象でもmissが勝つことを確認
    marks[3] = mark('the', 0, 'sub', 'a');
    const judge = makeJudge({
      wordMarks: marks,
      // "They"はok・同一文内なので逆引きは成功し、"the"側はmiss優先になる
      previousIssueOutcomes: [{ type: 'weak', words: ['They'], improved: true }],
    });
    const feedback = buildScriptFeedback(SENTENCES, judge);
    expect(feedback[0].words![0]).toEqual({ text: 'They', highlight: 'improved', cardIndices: [0] });
    expect(feedback[0].words![3]).toEqual({ text: 'the', highlight: 'miss', cardIndices: [] });
  });

  it('si付きのoutcome（M14以降）は、同名語が手前の文にokで存在しても指定の文にGoodカードが付く', () => {
    const sentences: Sentence[] = [{ en: 'I like the dog.' }, { en: 'She fed the cat.' }];
    const marks: WordMark[] = [
      mark('I', 0, 'ok'),
      mark('like', 0, 'ok'),
      mark('the', 0, 'ok'),
      mark('dog.', 0, 'ok'),
      mark('She', 1, 'ok'),
      mark('fed', 1, 'ok'),
      mark('the', 1, 'ok'),
      mark('cat.', 1, 'ok'),
    ];
    const judge = makeJudge({
      wordMarks: marks,
      // 前回文1の'the'の弱形指摘が改善した。文0にも'the'(ok)があるが、siがあるので誤配置しない
      previousIssueOutcomes: [{ type: 'weak', words: ['the'], si: 1, improved: true }],
    });
    const feedback = buildScriptFeedback(sentences, judge);
    expect(feedback[0].cards).toHaveLength(0);
    expect(feedback[1].cards).toHaveLength(1);
    expect(feedback[0].words![2]).toEqual({ text: 'the', highlight: null, cardIndices: [] });
    expect(feedback[1].words![2]).toEqual({ text: 'the', highlight: 'improved', cardIndices: [0] });
  });

  it('同一文内の同名トークンは、指摘に該当する位置だけをピンク・タップ対象にする（okの同名語は巻き添えにしない）', () => {
    const sentences: Sentence[] = [{ en: 'I saw the dog and the cat.' }];
    const marks: WordMark[] = [
      mark('I', 0, 'ok'),
      mark('saw', 0, 'ok'),
      mark('the', 0, 'missed'),
      mark('dog', 0, 'ok'),
      mark('and', 0, 'ok'),
      mark('the', 0, 'ok'),
      mark('cat.', 0, 'ok'),
    ];
    const judge = makeJudge({
      wordMarks: marks,
      issues: [{ type: 'weak', words: ['the'], si: 0 }],
    });
    const feedback = buildScriptFeedback(sentences, judge);
    expect(feedback[0].words![2]).toEqual({ text: 'the', highlight: 'miss', cardIndices: [0] });
    expect(feedback[0].words![5]).toEqual({ text: 'the', highlight: null, cardIndices: [] });
  });

  it('教材の再分割等でsiの文に対象語が実在しない旧issueのカードは表示しない', () => {
    const judge = makeJudge({
      wordMarks: matchingMarks(),
      // si=1は範囲内だが、文1に'turned'/'on'は存在しない（再分割前のsiを引きずった旧データを想定）
      issues: [{ type: 'linking', words: ['turned', 'on'], si: 1 }],
    });
    const feedback = buildScriptFeedback(SENTENCES, judge);
    expect(feedback.every((f) => f.cards.length === 0)).toBe(true);
  });

  it('語数不一致でもsiが範囲内のissuesカードは残し、anchored=false（常時表示フォールバック）にする', () => {
    const judge = makeJudge({
      wordMarks: matchingMarks().slice(0, 3),
      issues: [{ type: 'linking', words: ['turned', 'on'], si: 0 }],
    });
    const feedback = buildScriptFeedback(SENTENCES, judge);
    expect(feedback[0].words).toBeNull();
    expect(feedback[0].cards).toEqual([{ kind: 'dev', type: 'linking', words: ['turned', 'on'], anchored: false }]);
    expect(hasAnyFeedback(feedback)).toBe(true);
  });

  it('1語が複数カードに属する場合、cardIndicesに登録順で両方入る', () => {
    const sentences: Sentence[] = [{ en: 'I want it now.' }];
    const marks: WordMark[] = [
      mark('I', 0, 'ok'),
      mark('want', 0, 'missed'),
      mark('it', 0, 'ok'),
      mark('now.', 0, 'ok'),
    ];
    const judge = makeJudge({
      wordMarks: marks,
      issues: [
        { type: 'flap', words: ['want', 'it'], si: 0 },
        { type: 'ending', words: ['want'], si: 0 },
      ],
    });
    const feedback = buildScriptFeedback(sentences, judge);
    expect(feedback[0].cards.map((c) => c.type)).toEqual(['flap', 'ending']);
    // 差し込み位置はそれぞれの一致範囲の末尾（flapペア='it'の位置2、ending単語='want'の位置1）
    expect(feedback[0].cards.map((c) => c.anchorPosition)).toEqual([2, 1]);
    expect(feedback[0].words![1]).toEqual({ text: 'want', highlight: 'miss', cardIndices: [0, 1] });
    expect(feedback[0].words![2]).toEqual({ text: 'it', highlight: 'miss', cardIndices: [0] });
  });

  it('devペアのok側の語が単独goodの対象でもある場合、miss優先の色で両カードのindexを持つ', () => {
    const judge = makeJudge({
      wordMarks: matchingMarks(),
      issues: [{ type: 'linking', words: ['turned', 'on'], si: 0 }],
      previousIssueOutcomes: [{ type: 'weak', words: ['on'], si: 0, improved: true }],
    });
    const feedback = buildScriptFeedback(SENTENCES, judge);
    expect(feedback[0].cards.map((c) => c.kind)).toEqual(['dev', 'good']);
    expect(feedback[0].words![2]).toEqual({ text: 'on', highlight: 'miss', cardIndices: [0, 1] });
  });

  it('issueのreferenceLinkedはカードへ伝搬する', () => {
    const judge = makeJudge({
      wordMarks: matchingMarks(),
      issues: [{ type: 'linking', words: ['turned', 'on'], si: 0, referenceLinked: true }],
    });
    const feedback = buildScriptFeedback(SENTENCES, judge);
    expect(feedback[0].cards).toEqual([
      { kind: 'dev', type: 'linking', words: ['turned', 'on'], anchored: true, anchorPosition: 2, referenceLinked: true },
    ]);
  });

  it('語は実在するが隣接一致しないカードはanchored=falseになり、どの語にも紐づかない', () => {
    const judge = makeJudge({
      wordMarks: matchingMarks(),
      // 'on','turned'は文0に実在するが、この語順で隣接はしていない
      issues: [{ type: 'linking', words: ['on', 'turned'], si: 0 }],
    });
    const feedback = buildScriptFeedback(SENTENCES, judge);
    expect(feedback[0].cards).toEqual([{ kind: 'dev', type: 'linking', words: ['on', 'turned'], anchored: false }]);
    expect(feedback[0].words!.every((w) => w.cardIndices.length === 0)).toBe(true);
  });
});

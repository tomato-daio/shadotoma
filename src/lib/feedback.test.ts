import { describe, expect, it } from 'vitest';
import type { WordMark } from './align';
import { computeMatchRate, computeWpm, generateFeedback, longestOkStreak } from './feedback';

function mark(word: string, si: number, status: WordMark['status']): WordMark {
  return { word, si, status };
}

describe('computeMatchRate', () => {
  it('全語okなら1.0', () => {
    const marks = [mark('a', 0, 'ok'), mark('b', 0, 'ok')];
    expect(computeMatchRate(marks)).toBe(1);
  });

  it('半分okなら0.5', () => {
    const marks = [mark('a', 0, 'ok'), mark('b', 0, 'missed')];
    expect(computeMatchRate(marks)).toBe(0.5);
  });

  it('空配列は0', () => {
    expect(computeMatchRate([])).toBe(0);
  });
});

describe('computeWpm', () => {
  it('120語を60秒で発話したら120WPM', () => {
    expect(computeWpm(120, 60)).toBe(120);
  });

  it('30語を15秒で発話したら120WPM', () => {
    expect(computeWpm(30, 15)).toBe(120);
  });

  it('秒数が0以下なら0（ゼロ除算を避ける）', () => {
    expect(computeWpm(10, 0)).toBe(0);
    expect(computeWpm(10, -5)).toBe(0);
  });
});

describe('longestOkStreak', () => {
  it('最長の連続ok区間を返す', () => {
    const marks = [
      mark('a', 0, 'ok'),
      mark('b', 0, 'missed'),
      mark('c', 0, 'ok'),
      mark('d', 0, 'ok'),
      mark('e', 0, 'ok'),
      mark('f', 0, 'sub'),
    ];
    const streak = longestOkStreak(marks);
    expect(streak).not.toBeNull();
    expect(streak?.length).toBe(3);
    expect(streak?.text).toBe('c d e');
    expect(streak?.startIndex).toBe(2);
  });

  it('末尾まで連続していても検出する', () => {
    const marks = [mark('a', 0, 'missed'), mark('b', 0, 'ok'), mark('c', 0, 'ok')];
    const streak = longestOkStreak(marks);
    expect(streak?.length).toBe(2);
    expect(streak?.text).toBe('b c');
  });

  it('okが1つも無ければnull', () => {
    const marks = [mark('a', 0, 'missed'), mark('b', 0, 'sub')];
    expect(longestOkStreak(marks)).toBeNull();
  });

  it('同じ長さの区間が複数あれば最初のものを返す', () => {
    const marks = [mark('a', 0, 'ok'), mark('b', 0, 'ok'), mark('x', 0, 'missed'), mark('c', 0, 'ok'), mark('d', 0, 'ok')];
    const streak = longestOkStreak(marks);
    expect(streak?.startIndex).toBe(0);
  });
});

const SENTENCES = [
  { en: 'The quick brown fox jumps over the lazy dog.' },
  { en: 'She sells seashells by the seashore every summer.' },
];

function buildWordMarks(sentenceIdx: number, words: string[], statuses: WordMark['status'][]): WordMark[] {
  return words.map((w, i) => mark(w, sentenceIdx, statuses[i]));
}

describe('generateFeedback', () => {
  it('常にGood/Development Pointを3件ずつ返す', () => {
    const wordMarks = buildWordMarks(0, ['The', 'quick', 'brown'], ['ok', 'ok', 'ok']);
    const { goodPoints, devPoints } = generateFeedback({ wordMarks, sentences: SENTENCES, wpm: 100 });
    expect(goodPoints).toHaveLength(3);
    expect(devPoints).toHaveLength(3);
  });

  it('全語okな完璧な提出でもクラッシュせず3件ずつ返す（フォールバック文言で補う）', () => {
    const wordMarks = buildWordMarks(0, ['The', 'quick', 'brown', 'fox'], ['ok', 'ok', 'ok', 'ok']);
    const { goodPoints, devPoints } = generateFeedback({ wordMarks, sentences: SENTENCES, wpm: 100, referenceWpm: 100 });
    expect(goodPoints).toHaveLength(3);
    expect(devPoints).toHaveLength(3);
    expect(new Set(devPoints).size).toBe(devPoints.length); // 重複が無い
  });

  it('missedが集中した文をDevelopment Pointで名指しする', () => {
    const wordMarks = [
      ...buildWordMarks(0, ['The', 'quick', 'brown', 'fox', 'jumps'], ['ok', 'missed', 'missed', 'missed', 'ok']),
      ...buildWordMarks(1, ['She', 'sells', 'seashells'], ['ok', 'ok', 'ok']),
    ];
    const { devPoints } = generateFeedback({ wordMarks, sentences: SENTENCES, wpm: 100 });
    expect(devPoints.some((p) => p.includes(SENTENCES[0].en))).toBe(true);
  });

  it('前回より改善していればGood Pointに前回比が入る', () => {
    const wordMarks = buildWordMarks(0, ['a', 'b', 'c', 'd'], ['ok', 'ok', 'ok', 'ok']);
    const { goodPoints } = generateFeedback({
      wordMarks,
      sentences: SENTENCES,
      wpm: 100,
      previousMatchRate: 0.5,
    });
    expect(goodPoints.some((p) => p.includes('改善'))).toBe(true);
  });

  it('前回より悪化していればDevelopment Pointに前回比が入る', () => {
    const wordMarks = buildWordMarks(0, ['a', 'b', 'c', 'd'], ['ok', 'missed', 'missed', 'missed']);
    const { devPoints } = generateFeedback({
      wordMarks,
      sentences: SENTENCES,
      wpm: 100,
      previousMatchRate: 0.9,
    });
    expect(devPoints.some((p) => p.includes('下がっています'))).toBe(true);
  });

  it('お手本より遅い速度をDevelopment Pointで指摘する', () => {
    const wordMarks = buildWordMarks(0, ['a', 'b', 'c', 'd'], ['ok', 'ok', 'ok', 'ok']);
    const { devPoints } = generateFeedback({
      wordMarks,
      sentences: SENTENCES,
      wpm: 60,
      referenceWpm: 100,
    });
    expect(devPoints.some((p) => p.includes('ゆっくりめ'))).toBe(true);
  });

  it('お手本より速い速度をDevelopment Pointで指摘する', () => {
    const wordMarks = buildWordMarks(0, ['a', 'b', 'c', 'd'], ['ok', 'ok', 'ok', 'ok']);
    const { devPoints } = generateFeedback({
      wordMarks,
      sentences: SENTENCES,
      wpm: 150,
      referenceWpm: 100,
    });
    expect(devPoints.some((p) => p.includes('速い'))).toBe(true);
  });

  it('お手本比±15%以内の速度はGood Pointで評価する', () => {
    const wordMarks = buildWordMarks(0, ['a', 'b', 'c', 'd'], ['ok', 'ok', 'ok', 'ok']);
    const { goodPoints } = generateFeedback({
      wordMarks,
      sentences: SENTENCES,
      wpm: 105,
      referenceWpm: 100,
    });
    expect(goodPoints.some((p) => p.includes('近く'))).toBe(true);
  });

  it('最長連続一致区間をGood Pointで言及する', () => {
    const wordMarks = buildWordMarks(
      0,
      ['The', 'quick', 'brown', 'fox', 'jumps', 'over'],
      ['missed', 'ok', 'ok', 'ok', 'ok', 'missed'],
    );
    const { goodPoints } = generateFeedback({ wordMarks, sentences: SENTENCES, wpm: 100 });
    expect(goodPoints.some((p) => p.includes('quick brown fox jumps'))).toBe(true);
  });

  it('スクリプトに無い挿入語が無ければGood Pointで評価する', () => {
    const wordMarks = buildWordMarks(0, ['a', 'b', 'c', 'd'], ['ok', 'ok', 'ok', 'ok']);
    const { goodPoints } = generateFeedback({ wordMarks, sentences: SENTENCES, wpm: 100, insertions: [] });
    expect(goodPoints.some((p) => p.includes('付け足すことなく'))).toBe(true);
  });

  it('全語missed（空認識）+挿入語ゼロでは「原文に忠実」の偽陽性Good Pointを出さず、認識できなかった旨をDevelopment Pointの先頭に出す', () => {
    const wordMarks = buildWordMarks(0, ['The', 'quick', 'brown', 'fox'], ['missed', 'missed', 'missed', 'missed']);
    const { goodPoints, devPoints } = generateFeedback({ wordMarks, sentences: SENTENCES, wpm: 0, insertions: [] });
    expect(goodPoints.some((p) => p.includes('付け足すことなく'))).toBe(false);
    expect(devPoints[0]).toContain('音声がほとんど認識できませんでした');
  });
});

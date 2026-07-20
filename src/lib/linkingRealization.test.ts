import { describe, expect, it } from 'vitest';
import type { WordMark } from './align';
import type { PhenomenonIssue } from './phenomena';
import { annotateIssuesWithLinking, validateTimedWords, type TimedWord } from './linkingRealization';

function timed(word: string, startSec: number, endSec: number): TimedWord {
  return { word, startSec, endSec };
}

describe('validateTimedWords', () => {
  const words: TimedWord[] = [
    timed('They', 0.1, 0.3),
    timed('turned', 0.35, 0.6),
    timed('on', 0.62, 0.75),
    timed('the', 0.8, 0.9),
    timed('light.', 0.95, 1.3),
  ];

  it('正常なタイムスタンプ列はそのまま通す', () => {
    expect(validateTimedWords(words, 5, 2)).toEqual(words);
  });

  it('不正エントリ(空文字・NaN・start>end)は除外しつつ、カバレッジが足りれば通す', () => {
    const noisy = [...words, timed('', 1.4, 1.5), timed('x', Number.NaN, 1.6)];
    expect(validateTimedWords(noisy, 5, 2)).toEqual(words);
  });

  it('有効語がtranscript語数の80%未満なら全体を信頼しない', () => {
    expect(validateTimedWords(words.slice(0, 3), 5, 2)).toBeNull();
  });

  it('startが大きく逆行していたら壊れたタイムスタンプとしてnull', () => {
    const broken = [...words.slice(0, 4), timed('light.', 0.2, 1.3)];
    expect(validateTimedWords(broken, 5, 2)).toBeNull();
  });

  it('最終語のendが音声長を1秒以上超えていたらnull', () => {
    expect(validateTimedWords(words, 5, 0.2)).toBeNull();
  });

  it('未指定・空配列はnull', () => {
    expect(validateTimedWords(undefined, 5, 2)).toBeNull();
    expect(validateTimedWords([], 5, 2)).toBeNull();
  });
});

describe('annotateIssuesWithLinking', () => {
  // お手本transcript「they turned on the light」がスクリプトと完全一致した場合のrefMarks
  const refMarks: WordMark[] = [
    { word: 'They', si: 0, status: 'ok', ri: 0 },
    { word: 'turned', si: 0, status: 'ok', ri: 1 },
    { word: 'on', si: 0, status: 'ok', ri: 2 },
    { word: 'the', si: 0, status: 'ok', ri: 3 },
    { word: 'light.', si: 0, status: 'ok', ri: 4 },
  ];
  const issue: PhenomenonIssue = { type: 'linking', words: ['turned', 'on'], si: 0 };

  it('お手本の2語間ギャップが小さければreferenceLinkedを付与する', () => {
    const refWords = [
      timed('they', 0.1, 0.3),
      timed('turned', 0.35, 0.6),
      timed('on', 0.65, 0.75), // gap 0.05 <= 0.09
      timed('the', 0.8, 0.9),
      timed('light', 0.95, 1.3),
    ];
    const result = annotateIssuesWithLinking({ issues: [issue], refMarks, refWords });
    expect(result[0].referenceLinked).toBe(true);
  });

  it('お手本でも間が空いていれば付与しない', () => {
    const refWords = [
      timed('they', 0.1, 0.3),
      timed('turned', 0.35, 0.6),
      timed('on', 0.9, 1.0), // gap 0.3
      timed('the', 1.1, 1.2),
      timed('light', 1.3, 1.6),
    ];
    const result = annotateIssuesWithLinking({ issues: [issue], refMarks, refWords });
    expect(result[0].referenceLinked).toBeUndefined();
  });

  it('お手本側の認識がok以外(sub/missed)なら付与しない', () => {
    const subMarks: WordMark[] = refMarks.map((m) =>
      m.word === 'on' ? { ...m, status: 'sub' as const, recognized: 'in' } : m,
    );
    const refWords = [
      timed('they', 0.1, 0.3),
      timed('turned', 0.35, 0.6),
      timed('in', 0.65, 0.75),
      timed('the', 0.8, 0.9),
      timed('light', 0.95, 1.3),
    ];
    const result = annotateIssuesWithLinking({ issues: [issue], refMarks: subMarks, refWords });
    expect(result[0].referenceLinked).toBeUndefined();
  });

  it('1語のissueはそのまま通す', () => {
    const single: PhenomenonIssue = { type: 'weak', words: ['the'], si: 0 };
    const result = annotateIssuesWithLinking({ issues: [single], refMarks, refWords: [] });
    expect(result[0]).toEqual(single);
  });

  it('元のissue配列は変更しない(新配列を返す)', () => {
    const refWords = [
      timed('they', 0.1, 0.3),
      timed('turned', 0.35, 0.6),
      timed('on', 0.65, 0.75),
      timed('the', 0.8, 0.9),
      timed('light', 0.95, 1.3),
    ];
    annotateIssuesWithLinking({ issues: [issue], refMarks, refWords });
    expect(issue.referenceLinked).toBeUndefined();
  });
});

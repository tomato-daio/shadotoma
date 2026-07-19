import { describe, expect, it } from 'vitest';
import type { AzurePronunciationResult } from '../../lib/db';
import { generateAzureComments } from './azureComments';

function baseAzure(overrides: Partial<AzurePronunciationResult> = {}): AzurePronunciationResult {
  return {
    pronScore: 90,
    accuracyScore: 90,
    fluencyScore: 90,
    prosodyScore: 90,
    completenessScore: 100,
    words: [],
    ...overrides,
  };
}

describe('generateAzureComments', () => {
  it('該当なしなら肯定コメント1件のみ返す', () => {
    const comments = generateAzureComments(baseAzure());
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain('安定');
  });

  it('①苦手音素（辞書にあり）: コツ文つきで生成する', () => {
    const azure = baseAzure({
      weakPhonemes: [{ phoneme: 'R', avgScore: 40, examples: ['red', 'run'] }],
    });
    const comments = generateAzureComments(azure);
    expect(comments[0]).toContain('rの音');
    expect(comments[0]).toContain('40点');
    expect(comments[0]).toContain('red・run');
    expect(comments[0]).toContain(':'); // コツ文の区切り
  });

  it('①苦手音素（辞書に無い音素）: 記号と例語のみでコツ文を付けない', () => {
    const azure = baseAzure({
      weakPhonemes: [{ phoneme: 'ZZ', avgScore: 30, examples: ['foo'] }],
    });
    const comments = generateAzureComments(azure);
    expect(comments[0]).toContain('ZZの音');
    expect(comments[0]).not.toContain(':');
  });

  it('①平均60点未満の音素のみコメント化し、60点以上は除外する', () => {
    const azure = baseAzure({
      weakPhonemes: [
        { phoneme: 'R', avgScore: 55, examples: ['red'] },
        { phoneme: 'TH', avgScore: 60, examples: ['think'] },
      ],
    });
    const comments = generateAzureComments(azure);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain('rの音');
  });

  it('①苦手音素は最大3件まで、音素ごとに1コメントずつ生成する', () => {
    const azure = baseAzure({
      weakPhonemes: [
        { phoneme: 'R', avgScore: 30, examples: [] },
        { phoneme: 'TH', avgScore: 35, examples: [] },
        { phoneme: 'AE', avgScore: 40, examples: [] },
      ],
      // ②③④の条件も満たすが、①だけで枠が埋まるため出ない
      fluencyScore: 50,
      prosodyScore: 40,
      completenessScore: 50,
      prosodyFeedback: { unexpectedBreaks: 3, missingBreaks: 0, monotone: true },
    });
    const comments = generateAzureComments(azure);
    expect(comments).toHaveLength(3);
    expect(comments[0]).toContain('rの音');
    expect(comments[1]).toContain('thの音');
    expect(comments[2]).toContain('æの音');
  });

  it('②流暢さ<75かつunexpectedBreaks>0で「不要な間」コメントを出す', () => {
    const azure = baseAzure({
      fluencyScore: 60,
      prosodyFeedback: { unexpectedBreaks: 2, missingBreaks: 0, monotone: false },
    });
    const comments = generateAzureComments(azure);
    expect(comments[0]).toContain('不要な間が2箇所');
  });

  it('流暢さが低くてもunexpectedBreaksが0なら②は出さない', () => {
    const azure = baseAzure({
      fluencyScore: 60,
      prosodyFeedback: { unexpectedBreaks: 0, missingBreaks: 0, monotone: false },
    });
    const comments = generateAzureComments(azure);
    expect(comments.some((c) => c.includes('不要な間'))).toBe(false);
  });

  it('③monotoneがtrueなら「抑揚が平坦」コメントを出す', () => {
    const azure = baseAzure({ prosodyFeedback: { unexpectedBreaks: 0, missingBreaks: 0, monotone: true } });
    const comments = generateAzureComments(azure);
    expect(comments[0]).toContain('抑揚が平坦');
  });

  it('③韻律<70でも（monotoneでなくても）「抑揚が平坦」コメントを出す', () => {
    const azure = baseAzure({ prosodyScore: 65 });
    const comments = generateAzureComments(azure);
    expect(comments[0]).toContain('抑揚が平坦');
  });

  it('③韻律スコアがundefined（M10フォールバック）かつmonotoneでなければ③は出さない', () => {
    const azure = baseAzure({ prosodyScore: undefined });
    const comments = generateAzureComments(azure);
    expect(comments.some((c) => c.includes('抑揚'))).toBe(false);
  });

  it('④完全性<80で「読み飛ばし」コメントを出す', () => {
    const azure = baseAzure({ completenessScore: 70 });
    const comments = generateAzureComments(azure);
    expect(comments[0]).toContain('読み飛ば');
  });

  it('優先度順（①→②→③→④）で最大3件に絞る', () => {
    const azure = baseAzure({
      weakPhonemes: [{ phoneme: 'R', avgScore: 30, examples: [] }],
      fluencyScore: 60,
      prosodyFeedback: { unexpectedBreaks: 1, missingBreaks: 0, monotone: true },
      prosodyScore: 50,
      completenessScore: 50,
    });
    const comments = generateAzureComments(azure);
    expect(comments).toHaveLength(3);
    expect(comments[0]).toContain('rの音');
    expect(comments[1]).toContain('不要な間');
    expect(comments[2]).toContain('抑揚が平坦');
    // ④は枠が無いため出ない
    expect(comments.some((c) => c.includes('読み飛ば'))).toBe(false);
  });
});

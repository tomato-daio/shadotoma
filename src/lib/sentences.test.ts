import { describe, expect, it } from 'vitest';
import { sentencesFromText, splitSentences } from './sentences';

describe('splitSentences', () => {
  it('空文字列は空配列を返す', () => {
    expect(splitSentences('')).toEqual([]);
    expect(splitSentences('   ')).toEqual([]);
  });

  it('単純な複数文を分割する', () => {
    expect(splitSentences('Hello world. This is a test.')).toEqual([
      'Hello world.',
      'This is a test.',
    ]);
  });

  it('末尾に句読点がない1文はそのまま返す', () => {
    expect(splitSentences('Hello world')).toEqual(['Hello world']);
  });

  it('改行や連続空白を正規化してから分割する', () => {
    expect(splitSentences('Hello world.\n\nThis   is\na test.')).toEqual([
      'Hello world.',
      'This is a test.',
    ]);
  });

  it('!と?でも分割する', () => {
    expect(splitSentences('Wait! Is that true? Yes, it is.')).toEqual([
      'Wait!',
      'Is that true?',
      'Yes, it is.',
    ]);
  });

  describe('略語', () => {
    it('Mr. / Dr. などの敬称の後で分割しない', () => {
      expect(splitSentences('Mr. Smith went to Washington. He met the president.')).toEqual([
        'Mr. Smith went to Washington.',
        'He met the president.',
      ]);
    });

    it('U.S. のような頭字語の後で分割しない', () => {
      expect(splitSentences('The U.S. economy is growing. Experts are optimistic.')).toEqual([
        'The U.S. economy is growing.',
        'Experts are optimistic.',
      ]);
    });

    it('複数の略語が混在していても正しく分割する', () => {
      expect(
        splitSentences(
          'Dr. Lee works at the U.N. in New York. She will speak at 3 p.m. tomorrow.',
        ),
      ).toEqual([
        'Dr. Lee works at the U.N. in New York.',
        'She will speak at 3 p.m. tomorrow.',
      ]);
    });

    it('etc. は常に非文末として扱う（"etc.,"のような文中使用を優先する設計上のトレードオフ）', () => {
      // "etc." は実文では文中("A, B, etc., are sold")にも文末("...and so on. Next...")にも
      // 現れうる曖昧な略語。本実装は既知略語リストで一律に非分割として扱うため、
      // 直後の文と連結されたままになる（既知の制限として申し送る）。
      expect(
        splitSentences('They sell fruit, vegetables, etc. The market opens early.'),
      ).toEqual(['They sell fruit, vegetables, etc. The market opens early.']);
    });
  });

  describe('引用符', () => {
    it('閉じ引用符の後ろで正しく分割する', () => {
      expect(splitSentences('She said, "I am happy." He smiled.')).toEqual([
        'She said, "I am happy."',
        'He smiled.',
      ]);
    });

    it('疑問符+閉じ引用符の後ろで正しく分割する', () => {
      expect(splitSentences('He asked, "Is this correct?" Then he nodded.')).toEqual([
        'He asked, "Is this correct?"',
        'Then he nodded.',
      ]);
    });

    it('カーリークォートの後ろでも分割する', () => {
      expect(splitSentences('She said, “I am happy.” He smiled.')).toEqual([
        'She said, “I am happy.”',
        'He smiled.',
      ]);
    });
  });

  describe('数字の小数点', () => {
    it('小数点を含む数値の後で分割しない', () => {
      expect(
        splitSentences('The rate is 3.5 percent this year. It rose slightly.'),
      ).toEqual(['The rate is 3.5 percent this year.', 'It rose slightly.']);
    });

    it('金額表記でも小数点で分割しない', () => {
      expect(splitSentences('The price is $3.50 today. That is cheap.')).toEqual([
        'The price is $3.50 today.',
        'That is cheap.',
      ]);
    });
  });

  it('3文以上でも正しく分割する', () => {
    expect(splitSentences('One. Two. Three.')).toEqual(['One.', 'Two.', 'Three.']);
  });
});

describe('sentencesFromText', () => {
  it('分割結果を {en} オブジェクト配列に変換する', () => {
    expect(sentencesFromText('Hello world. This is a test.')).toEqual([
      { en: 'Hello world.' },
      { en: 'This is a test.' },
    ]);
  });

  it('空文字列は空配列を返す', () => {
    expect(sentencesFromText('')).toEqual([]);
  });
});

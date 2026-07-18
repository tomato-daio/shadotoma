import { describe, expect, it } from 'vitest';
import {
  generateSectionBlanks,
  isBlankCorrect,
  isContentWord,
  selectRecentDoneSections,
  type DoneSectionCandidate,
} from './quizGen';

/** テスト用の決定論的rng: 与えた数列を順番に返し、尽きたら先頭に戻る（0以上1未満想定）。 */
function sequenceRng(values: number[]): () => number {
  let i = 0;
  return () => {
    const v = values[i % values.length];
    i += 1;
    return v;
  };
}

describe('isContentWord', () => {
  it('英字4文字以上の一般語は内容語', () => {
    expect(isContentWord('researchers,')).toBe(true);
    expect(isContentWord('Korea')).toBe(true);
    expect(isContentWord('"quickly"')).toBe(true);
  });

  it('3文字以下の語は内容語ではない', () => {
    expect(isContentWord('cat')).toBe(false);
    expect(isContentWord('a')).toBe(false);
  });

  it('4文字以上でもストップワードは内容語ではない', () => {
    expect(isContentWord('with')).toBe(false);
    expect(isContentWord('that')).toBe(false);
    expect(isContentWord('This')).toBe(false);
    expect(isContentWord("don't")).toBe(false);
  });

  it('数字や頭字語（英字が4文字未満）は内容語ではない', () => {
    expect(isContentWord('238,300')).toBe(false);
    expect(isContentWord('U.S.')).toBe(false);
  });
});

describe('generateSectionBlanks', () => {
  it('内容語が1つも無いセクションは空配列を返す（安全化）', () => {
    const sentences = [{ en: 'It was with them.' }, { en: 'That is all.' }];
    expect(generateSectionBlanks(sentences, sequenceRng([0]))).toEqual([]);
  });

  it('候補が3未満なら候補数ぶんだけ空欄にする（下限に届かなくても安全に動く）', () => {
    const sentences = [{ en: 'Researchers found something interesting today.' }];
    // researchers/found/something/interesting/today が候補だが、1文なので最大2件までしか選ばれない
    const blanks = generateSectionBlanks(sentences, sequenceRng([0.1, 0.4, 0.9]));
    expect(blanks.length).toBe(2);
    for (const b of blanks) {
      expect(b.sentenceIndex).toBe(0);
    }
  });

  it('1文あたり最大2箇所・セクションあたり3〜6箇所に収まる', () => {
    const sentences = [
      { en: 'Scientists discovered another interesting species yesterday.' },
      { en: 'Researchers explained their findings carefully afterward.' },
      { en: 'Officials announced significant changes recently.' },
    ];
    const blanks = generateSectionBlanks(sentences, sequenceRng([0.05, 0.55, 0.95, 0.15, 0.65, 0.35, 0.75, 0.25]));

    expect(blanks.length).toBeGreaterThanOrEqual(3);
    expect(blanks.length).toBeLessThanOrEqual(6);

    const perSentence = new Map<number, number>();
    for (const b of blanks) {
      perSentence.set(b.sentenceIndex, (perSentence.get(b.sentenceIndex) ?? 0) + 1);
    }
    for (const count of perSentence.values()) {
      expect(count).toBeLessThanOrEqual(2);
    }
  });

  it('選ばれた空欄のanswerは元のスクリプト上の表記そのもの', () => {
    const sentences = [{ en: 'Researchers explained their findings carefully.' }];
    const blanks = generateSectionBlanks(sentences, sequenceRng([0.2, 0.6]));
    for (const b of blanks) {
      const word = sentences[b.sentenceIndex].en.split(/\s+/)[b.wordIndex];
      expect(b.answer).toBe(word);
    }
  });

  it('rngが同じ数列なら同じ結果になる（決定論的）', () => {
    const sentences = [
      { en: 'Scientists discovered another interesting species yesterday.' },
      { en: 'Researchers explained their findings carefully afterward.' },
    ];
    const rngValues = [0.1, 0.9, 0.3, 0.7, 0.5, 0.2];
    const a = generateSectionBlanks(sentences, sequenceRng(rngValues));
    const b = generateSectionBlanks(sentences, sequenceRng(rngValues));
    expect(a).toEqual(b);
  });
});

describe('selectRecentDoneSections', () => {
  interface Candidate extends DoneSectionCandidate {
    id: string;
  }

  it('lastPracticedDateの降順で並べ、最大maxCount件を返す', () => {
    const candidates: Candidate[] = [
      { id: 'p1', part: 1, lastPracticedDate: '2026-07-10' },
      { id: 'p2', part: 2, lastPracticedDate: '2026-07-15' },
      { id: 'p3', part: 3, lastPracticedDate: '2026-07-12' },
      { id: 'p4', part: 4, lastPracticedDate: '2026-07-18' },
    ];

    const selected = selectRecentDoneSections(candidates);

    expect(selected.map((c) => c.id)).toEqual(['p4', 'p2', 'p3']);
  });

  it('同じ日付ならpart降順でタイブレークする', () => {
    const candidates: Candidate[] = [
      { id: 'p1', part: 1, lastPracticedDate: '2026-07-18' },
      { id: 'p2', part: 2, lastPracticedDate: '2026-07-18' },
    ];

    const selected = selectRecentDoneSections(candidates, 5);

    expect(selected.map((c) => c.id)).toEqual(['p2', 'p1']);
  });

  it('maxCountを指定すればその件数に絞れる', () => {
    const candidates: Candidate[] = [
      { id: 'p1', part: 1, lastPracticedDate: '2026-07-10' },
      { id: 'p2', part: 2, lastPracticedDate: '2026-07-11' },
    ];

    expect(selectRecentDoneSections(candidates, 1).map((c) => c.id)).toEqual(['p2']);
  });

  it('候補が0件なら空配列', () => {
    expect(selectRecentDoneSections([])).toEqual([]);
  });
});

describe('isBlankCorrect', () => {
  it('大文字小文字・約物の違いは正解扱い（align.tsのnormalizeWordを再利用）', () => {
    expect(isBlankCorrect('korea', 'Korea,')).toBe(true);
    expect(isBlankCorrect('Korea', 'korea')).toBe(true);
  });

  it('短縮形のアポストロフィ有無は正解扱い', () => {
    expect(isBlankCorrect('dont', "don't")).toBe(true);
  });

  it('異なる語は不正解', () => {
    expect(isBlankCorrect('japan', 'Korea')).toBe(false);
  });

  it('空欄回答は不正解', () => {
    expect(isBlankCorrect('', 'Korea')).toBe(false);
  });

  it('正答側が正規化後に空になる異常データは不正解扱い（安全化）', () => {
    expect(isBlankCorrect('', '...')).toBe(false);
    expect(isBlankCorrect('anything', '...')).toBe(false);
  });
});

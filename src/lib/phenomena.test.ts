import { describe, expect, it } from 'vitest';
import type { WordMark } from './align';
import {
  comparePreviousIssues,
  detectPhenomena,
  prioritizeIssues,
  stripPunct,
  type PhenomenonIssue,
} from './phenomena';

function mark(word: string, si: number, status: WordMark['status'], recognized?: string): WordMark {
  return recognized !== undefined ? { word, si, status, recognized } : { word, si, status };
}

describe('stripPunct（M8: feedback.tsの実語ベース文言生成で再利用する公開ヘルパー）', () => {
  it('前後の約物を除去し小文字化する', () => {
    expect(stripPunct('Day.')).toBe('day');
    expect(stripPunct('"Hello,"')).toBe('hello');
  });

  it('内部のアポストロフィは保持する', () => {
    expect(stripPunct("Korea's")).toBe("korea's");
  });
});

describe('detectPhenomena / linking（リンキング）', () => {
  it('子音終わり+母音始まりのペアがmissedなら連結を検出する', () => {
    const sentences = [{ en: 'They turned on the light.' }];
    const wordMarks = [
      mark('They', 0, 'ok'),
      mark('turned', 0, 'missed'),
      mark('on', 0, 'missed'),
      mark('the', 0, 'ok'),
      mark('light.', 0, 'ok'),
    ];
    const issues = detectPhenomena(sentences, wordMarks);
    expect(issues).toContainEqual({ type: 'linking', words: ['turned', 'on'], si: 0 });
  });

  it('両語ともokなら連結として検出しない', () => {
    const sentences = [{ en: 'They turned on the light.' }];
    const wordMarks = [
      mark('They', 0, 'ok'),
      mark('turned', 0, 'ok'),
      mark('on', 0, 'ok'),
      mark('the', 0, 'ok'),
      mark('light.', 0, 'ok'),
    ];
    const issues = detectPhenomena(sentences, wordMarks);
    expect(issues.some((i) => i.type === 'linking')).toBe(false);
  });
});

describe('detectPhenomena / flap（フラップ）', () => {
  it('母音に挟まれたtを含む語(water)がmissedならフラップを検出する', () => {
    const sentences = [{ en: 'I need some water now.' }];
    const wordMarks = [
      mark('I', 0, 'ok'),
      mark('need', 0, 'ok'),
      mark('some', 0, 'ok'),
      mark('water', 0, 'missed'),
      mark('now.', 0, 'ok'),
    ];
    const issues = detectPhenomena(sentences, wordMarks);
    expect(issues).toContainEqual({ type: 'flap', words: ['water'], si: 0 });
  });

  it('二重子音tt(better)がsubならフラップを検出する', () => {
    const sentences = [{ en: 'This is better than that.' }];
    const wordMarks = [
      mark('This', 0, 'ok'),
      mark('is', 0, 'ok'),
      mark('better', 0, 'sub', 'bear'),
      mark('than', 0, 'ok'),
      mark('that.', 0, 'ok'),
    ];
    const issues = detectPhenomena(sentences, wordMarks);
    expect(issues).toContainEqual({ type: 'flap', words: ['better'], si: 0 });
  });

  it('語末tの語(got)+母音始まり語(a)のペアがmissedならフラップを検出する', () => {
    const sentences = [{ en: 'I got a present.' }];
    const wordMarks = [
      mark('I', 0, 'ok'),
      mark('got', 0, 'missed'),
      mark('a', 0, 'missed'),
      mark('present.', 0, 'ok'),
    ];
    const issues = detectPhenomena(sentences, wordMarks);
    expect(issues).toContainEqual({ type: 'flap', words: ['got', 'a'], si: 0 });
  });
});

describe('detectPhenomena / elision（脱落）', () => {
  it('語末破裂音+子音始まり語(next day)がmissedなら脱落を検出する', () => {
    const sentences = [{ en: 'See you next day.' }];
    const wordMarks = [
      mark('See', 0, 'ok'),
      mark('you', 0, 'ok'),
      mark('next', 0, 'missed'),
      mark('day.', 0, 'ok'),
    ];
    const issues = detectPhenomena(sentences, wordMarks);
    expect(issues).toContainEqual({ type: 'elision', words: ['next', 'day.'], si: 0 });
  });

  it('語末破裂音+子音始まり語(just now)がmissedなら脱落を検出する', () => {
    const sentences = [{ en: 'I just now arrived.' }];
    const wordMarks = [
      mark('I', 0, 'ok'),
      mark('just', 0, 'missed'),
      mark('now', 0, 'ok'),
      mark('arrived.', 0, 'ok'),
    ];
    const issues = detectPhenomena(sentences, wordMarks);
    expect(issues).toContainEqual({ type: 'elision', words: ['just', 'now'], si: 0 });
  });

  it('両語ともokなら脱落として検出しない', () => {
    const sentences = [{ en: 'See you next day.' }];
    const wordMarks = [
      mark('See', 0, 'ok'),
      mark('you', 0, 'ok'),
      mark('next', 0, 'ok'),
      mark('day.', 0, 'ok'),
    ];
    const issues = detectPhenomena(sentences, wordMarks);
    expect(issues.some((i) => i.type === 'elision')).toBe(false);
  });
});

describe('detectPhenomena / weak（弱形）', () => {
  it('機能語ofがmissedなら弱形を検出する', () => {
    const sentences = [{ en: 'A cup of tea, please.' }];
    const wordMarks = [
      mark('A', 0, 'ok'),
      mark('cup', 0, 'ok'),
      mark('of', 0, 'missed'),
      mark('tea,', 0, 'ok'),
      mark('please.', 0, 'ok'),
    ];
    const issues = detectPhenomena(sentences, wordMarks);
    expect(issues).toContainEqual({ type: 'weak', words: ['of'], si: 0 });
  });

  it('機能語canがmissedなら弱形を検出する', () => {
    const sentences = [{ en: 'You can go now.' }];
    const wordMarks = [
      mark('You', 0, 'ok'),
      mark('can', 0, 'missed'),
      mark('go', 0, 'ok'),
      mark('now.', 0, 'ok'),
    ];
    const issues = detectPhenomena(sentences, wordMarks);
    expect(issues).toContainEqual({ type: 'weak', words: ['can'], si: 0 });
  });

  it('内容語がmissedでも弱形としては検出しない', () => {
    const sentences = [{ en: 'The mountain is tall.' }];
    const wordMarks = [
      mark('The', 0, 'ok'),
      mark('mountain', 0, 'missed'),
      mark('is', 0, 'ok'),
      mark('tall.', 0, 'ok'),
    ];
    const issues = detectPhenomena(sentences, wordMarks);
    expect(issues.some((i) => i.type === 'weak')).toBe(false);
  });
});

describe('detectPhenomena / ending（語尾-s/-ed）', () => {
  it('wanted→wantのように-edが脱落した認識をsubで語尾指摘する', () => {
    const sentences = [{ en: 'She wanted to go.' }];
    const wordMarks = [
      mark('She', 0, 'ok'),
      mark('wanted', 0, 'sub', 'want'),
      mark('to', 0, 'ok'),
      mark('go.', 0, 'ok'),
    ];
    const issues = detectPhenomena(sentences, wordMarks);
    expect(issues).toContainEqual({ type: 'ending', words: ['wanted'], si: 0 });
  });

  it('wants→wantのように-sが脱落した認識をsubで語尾指摘する', () => {
    const sentences = [{ en: 'He wants coffee.' }];
    const wordMarks = [mark('He', 0, 'ok'), mark('wants', 0, 'sub', 'want'), mark('coffee.', 0, 'ok')];
    const issues = detectPhenomena(sentences, wordMarks);
    expect(issues).toContainEqual({ type: 'ending', words: ['wants'], si: 0 });
  });

  it('語幹自体が別の語に変わったsubは語尾指摘としない', () => {
    const sentences = [{ en: 'I like cats.' }];
    const wordMarks = [mark('I', 0, 'ok'), mark('like', 0, 'ok'), mark('cats.', 0, 'sub', 'dogs')];
    const issues = detectPhenomena(sentences, wordMarks);
    expect(issues.some((i) => i.type === 'ending')).toBe(false);
  });

  it('okの語は語尾指摘の対象にしない', () => {
    const sentences = [{ en: 'She wanted to go.' }];
    const wordMarks = [
      mark('She', 0, 'ok'),
      mark('wanted', 0, 'ok'),
      mark('to', 0, 'ok'),
      mark('go.', 0, 'ok'),
    ];
    const issues = detectPhenomena(sentences, wordMarks);
    expect(issues.some((i) => i.type === 'ending')).toBe(false);
  });
});

describe('detectPhenomena / 文をまたぐペアは検出しない', () => {
  it('文末語と次の文の先頭語は連結・脱落の対象にしない', () => {
    const sentences = [{ en: 'He went out.' }, { en: 'It was cold.' }];
    const wordMarks = [
      mark('He', 0, 'ok'),
      mark('went', 0, 'missed'),
      mark('out.', 0, 'missed'),
      mark('It', 1, 'missed'),
      mark('was', 1, 'ok'),
      mark('cold.', 1, 'ok'),
    ];
    const issues = detectPhenomena(sentences, wordMarks);
    // out.(si=0) と It(si=1) はまたがるペアなので対象にならない
    expect(issues.some((i) => i.words.includes('out.') && i.words.includes('It'))).toBe(false);
  });
});

describe('prioritizeIssues', () => {
  function issue(type: PhenomenonIssue['type'], words: string[], si = 0): PhenomenonIssue {
    return { type, words, si };
  }

  it('同一typeが多いものを優先し、上限件数に絞る', () => {
    const issues = [
      issue('weak', ['of']),
      issue('linking', ['turned', 'on']),
      issue('weak', ['to']),
      issue('weak', ['for']),
    ];
    const result = prioritizeIssues(issues, 3);
    expect(result).toHaveLength(3);
    expect(result.every((i) => i.type === 'weak')).toBe(true);
  });

  it('同点内は検出順を保つ（安定ソート）', () => {
    const issues = [issue('linking', ['a', 'b']), issue('elision', ['c', 'd'])];
    const result = prioritizeIssues(issues, 3);
    expect(result.map((i) => i.type)).toEqual(['linking', 'elision']);
  });

  it('上限を超えない場合はそのまま返す', () => {
    const issues = [issue('weak', ['of'])];
    expect(prioritizeIssues(issues, 3)).toEqual(issues);
  });
});

describe('comparePreviousIssues', () => {
  it('前回指摘の語が今回okになっていればimproved:trueになる', () => {
    const previousIssues: PhenomenonIssue[] = [{ type: 'linking', words: ['turned', 'on'], si: 0 }];
    const wordMarks = [
      mark('They', 0, 'ok'),
      mark('turned', 0, 'ok'),
      mark('on', 0, 'ok'),
      mark('the', 0, 'ok'),
      mark('light.', 0, 'ok'),
    ];
    const outcomes = comparePreviousIssues(previousIssues, wordMarks);
    expect(outcomes).toEqual([{ type: 'linking', words: ['turned', 'on'], improved: true }]);
  });

  it('前回指摘の語がまだmissed/subならimproved:falseになる', () => {
    const previousIssues: PhenomenonIssue[] = [{ type: 'weak', words: ['of'], si: 0 }];
    const wordMarks = [mark('A', 0, 'ok'), mark('cup', 0, 'ok'), mark('of', 0, 'missed'), mark('tea.', 0, 'ok')];
    const outcomes = comparePreviousIssues(previousIssues, wordMarks);
    expect(outcomes).toEqual([{ type: 'weak', words: ['of'], improved: false }]);
  });

  it('片方の語だけokになっても、ペア全体がokでなければimproved:falseになる', () => {
    const previousIssues: PhenomenonIssue[] = [{ type: 'linking', words: ['turned', 'on'], si: 0 }];
    const wordMarks = [
      mark('They', 0, 'ok'),
      mark('turned', 0, 'ok'),
      mark('on', 0, 'missed'),
      mark('the', 0, 'ok'),
      mark('light.', 0, 'ok'),
    ];
    const outcomes = comparePreviousIssues(previousIssues, wordMarks);
    expect(outcomes[0].improved).toBe(false);
  });

  it('前回指摘が無ければ空配列を返す', () => {
    expect(comparePreviousIssues([], [mark('a', 0, 'ok')])).toEqual([]);
  });
});

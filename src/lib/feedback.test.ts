import { describe, expect, it } from 'vitest';
import type { WordMark } from './align';
import { computeMatchRate, computeWpm, generateFeedback, longestOkStreak } from './feedback';
import type { PhenomenonIssue, PreviousIssueOutcome } from './phenomena';

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

  // DESIGN.md §8 5b: 音声現象ベースの指摘と前回比較（M8: 文言は実際の検出語から組み立てる）
  describe('issues（音声現象ベースの指摘）', () => {
    function issue(type: PhenomenonIssue['type'], words: string[], si = 0): PhenomenonIssue {
      return { type, words, si };
    }

    it('linking + 辞書ヒットあり: 実語ペア・綴りから取った文字・合成カタカナで文言を組み立てる', () => {
      const wordMarks = buildWordMarks(0, ['a', 'b', 'c', 'd'], ['ok', 'ok', 'ok', 'ok']);
      const issues = [issue('linking', ['turned', 'on'])];
      const result = generateFeedback({ wordMarks, sentences: SENTENCES, wpm: 100, issues });
      expect(result.devPoints).toContain(
        '「turned on」の連結が言えていませんでした。turned on は d と o がつながって1語のように聞こえます（「ターンドン」のような音です）。',
      );
      expect(result.issues).toEqual(issues);
    });

    it('linking + 辞書ヒットなし: カタカナを付けず文字ベースの説明のみにする', () => {
      const wordMarks = buildWordMarks(0, ['a', 'b', 'c', 'd'], ['ok', 'ok', 'ok', 'ok']);
      const issues = [issue('linking', ['picked', 'it'])];
      const { devPoints } = generateFeedback({ wordMarks, sentences: SENTENCES, wpm: 100, issues });
      expect(devPoints).toContain(
        '「picked it」の連結が言えていませんでした。picked it は d と i がつながって1語のように聞こえます。',
      );
    });

    it('flap + 辞書ヒットあり: 実語のtのラ行化をフラップ読みつきで説明する', () => {
      const wordMarks = buildWordMarks(0, ['a', 'b', 'c', 'd'], ['ok', 'ok', 'ok', 'ok']);
      const issues = [issue('flap', ['water'])];
      const { devPoints } = generateFeedback({ wordMarks, sentences: SENTENCES, wpm: 100, issues });
      expect(devPoints).toContain(
        '「water」のフラップ（tの軽い音）が言えていませんでした。water の t が弱いラ行のような音になります（「ワラ」のような音です）。',
      );
    });

    it('flap + 辞書ヒットなし: カタカナを付けず文字ベースの説明のみにする', () => {
      const wordMarks = buildWordMarks(0, ['a', 'b', 'c', 'd'], ['ok', 'ok', 'ok', 'ok']);
      const issues = [issue('flap', ['letter'])];
      const { devPoints } = generateFeedback({ wordMarks, sentences: SENTENCES, wpm: 100, issues });
      expect(devPoints).toContain(
        '「letter」のフラップ（tの軽い音）が言えていませんでした。letter の t が弱いラ行のような音になります。',
      );
    });

    it('weak + 辞書ヒットあり: 実語の弱形を読みつきで説明する', () => {
      const wordMarks = buildWordMarks(0, ['a', 'b', 'c', 'd'], ['ok', 'ok', 'ok', 'ok']);
      const issues = [issue('weak', ['of'])];
      const { devPoints } = generateFeedback({ wordMarks, sentences: SENTENCES, wpm: 100, issues });
      expect(devPoints).toContain(
        '「of」の弱形が言えていませんでした。of は弱く速く発音されます（弱く短い「オヴ」のような音です）。',
      );
    });

    it('elision + 辞書ヒットあり: 実語ペアの語末音の脱落を合成読みつきで説明する', () => {
      const wordMarks = buildWordMarks(0, ['a', 'b', 'c', 'd'], ['ok', 'ok', 'ok', 'ok']);
      const issues = [issue('elision', ['next', 'day.'])];
      const { devPoints } = generateFeedback({ wordMarks, sentences: SENTENCES, wpm: 100, issues });
      expect(devPoints).toContain(
        '「next day」の脱落が言えていませんでした。next day は t の音がほとんど落ちます（「ネクスデイ」のような音です）。',
      );
    });

    it('ending: 実語の語尾(-ed)を名指しし、カタカナは付けない', () => {
      const wordMarks = buildWordMarks(0, ['a', 'b', 'c', 'd'], ['ok', 'ok', 'ok', 'ok']);
      const issues = [issue('ending', ['wanted'])];
      const { devPoints } = generateFeedback({ wordMarks, sentences: SENTENCES, wpm: 100, issues });
      expect(devPoints).toContain(
        '「wanted」の語尾(-s/-ed)が言えていませんでした。wanted の語尾 -ed が弱くなります。',
      );
    });

    it('検出語と無関係な固定例文（turned on/ターンドン/ワラ/ネクスデイ等）を使い回さない', () => {
      const wordMarks = buildWordMarks(0, ['a', 'b', 'c', 'd'], ['ok', 'ok', 'ok', 'ok']);
      const issues = [
        issue('linking', ['picked', 'it']),
        issue('flap', ['letter']),
        issue('weak', ['his']),
      ];
      const { devPoints } = generateFeedback({ wordMarks, sentences: SENTENCES, wpm: 100, issues });
      const joined = devPoints.join(' ');
      // 検出された実語は文言に含まれる
      expect(joined).toContain('picked it');
      expect(joined).toContain('letter');
      expect(joined).toContain('his');
      // 検出語ではない固定の例文・カタカナは一切含まれない
      for (const banned of ['turned on', 'ターンドン', 'water', 'ワラ', 'next day', 'ネクスデイ', 'wanted', 'ワニッ']) {
        expect(joined).not.toContain(banned);
      }
    });

    it('同typeが複数検出された場合は1つの文言にまとめ、実語ペアを最大2つ列挙する', () => {
      const wordMarks = buildWordMarks(0, ['a', 'b', 'c', 'd'], ['ok', 'ok', 'ok', 'ok']);
      const issues = [
        issue('linking', ['picked', 'it']),
        issue('linking', ['found', 'a']),
        issue('linking', ['turned', 'on']),
      ];
      const { devPoints } = generateFeedback({ wordMarks, sentences: SENTENCES, wpm: 100, issues });
      const linkingPoints = devPoints.filter((p) => p.includes('連結'));
      expect(linkingPoints).toHaveLength(1);
      expect(linkingPoints[0]).toContain('「picked it」「found a」のような連結');
      // 3ペア目は列挙しない（最大2ペア）
      expect(linkingPoints[0]).not.toContain('turned on');
    });

    it('4件以上あるissuesは同一typeの多発を優先して3件に絞る（保存用issuesは3件のまま）', () => {
      const wordMarks = buildWordMarks(0, ['a', 'b', 'c', 'd'], ['ok', 'ok', 'ok', 'ok']);
      const issues = [
        issue('weak', ['of']),
        issue('linking', ['turned', 'on']),
        issue('weak', ['to']),
        issue('weak', ['for']),
      ];
      const result = generateFeedback({ wordMarks, sentences: SENTENCES, wpm: 100, issues });
      expect(result.issues).toHaveLength(3);
      expect(result.issues.every((i) => i.type === 'weak')).toBe(true);
      // 3件のweakは1つの文言にまとまり、先頭2語（of, to）が列挙される
      const weakPoints = result.devPoints.filter((p) => p.includes('弱形'));
      expect(weakPoints).toHaveLength(1);
      expect(weakPoints[0]).toContain('「of」「to」のような弱形');
    });

    it('同一文言になる指摘が重複しても、devPointsには1回しか載らない', () => {
      const wordMarks = buildWordMarks(0, ['a', 'b', 'c', 'd'], ['ok', 'ok', 'ok', 'ok']);
      const issues = [issue('weak', ['of']), issue('linking', ['picked', 'it'])];
      const { devPoints } = generateFeedback({ wordMarks, sentences: SENTENCES, wpm: 100, issues });
      expect(new Set(devPoints).size).toBe(devPoints.length);
    });

    it('issuesが3件に満たない場合は既存の一般指摘（missed集中文など）で補う', () => {
      const wordMarks = [
        ...buildWordMarks(0, ['The', 'quick', 'brown', 'fox', 'jumps'], ['ok', 'missed', 'missed', 'missed', 'ok']),
        ...buildWordMarks(1, ['She', 'sells', 'seashells'], ['ok', 'ok', 'ok']),
      ];
      const issues = [issue('weak', ['of'])];
      const { devPoints } = generateFeedback({ wordMarks, sentences: SENTENCES, wpm: 100, issues });
      expect(devPoints).toHaveLength(3);
      expect(devPoints.some((p) => p.includes('「of」の弱形'))).toBe(true);
      expect(devPoints.some((p) => p.includes(SENTENCES[0].en))).toBe(true);
    });

    it('issuesを渡さなければ従来どおり一般指摘のみでdevPointsを構成する（後方互換）', () => {
      const wordMarks = buildWordMarks(0, ['The', 'quick', 'brown'], ['ok', 'ok', 'ok']);
      const result = generateFeedback({ wordMarks, sentences: SENTENCES, wpm: 100 });
      expect(result.issues).toEqual([]);
      expect(result.devPoints).toHaveLength(3);
    });
  });

  describe('previousIssueOutcomes（前回比較）', () => {
    it('前回指摘が改善していればGood Pointの最優先に採用する', () => {
      const wordMarks = buildWordMarks(0, ['a', 'b', 'c', 'd'], ['ok', 'ok', 'ok', 'ok']);
      const previousIssueOutcomes: PreviousIssueOutcome[] = [
        { type: 'linking', words: ['turned', 'on'], improved: true },
      ];
      const { goodPoints } = generateFeedback({
        wordMarks,
        sentences: SENTENCES,
        wpm: 100,
        previousIssueOutcomes,
      });
      expect(goodPoints[0]).toContain('turned on');
      expect(goodPoints[0]).toContain('改善');
    });

    it('改善していない前回指摘（improved:false）はGood Pointに採用しない', () => {
      const wordMarks = buildWordMarks(0, ['a', 'b', 'c', 'd'], ['ok', 'ok', 'ok', 'ok']);
      const previousIssueOutcomes: PreviousIssueOutcome[] = [{ type: 'weak', words: ['of'], improved: false }];
      const { goodPoints } = generateFeedback({
        wordMarks,
        sentences: SENTENCES,
        wpm: 100,
        previousIssueOutcomes,
      });
      expect(goodPoints.some((p) => p.includes('of') && p.includes('改善'))).toBe(false);
    });
  });
});

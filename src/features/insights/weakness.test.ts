import { describe, expect, it } from 'vitest';
import type { AzurePronunciationResult, JudgeResult, QuizResult, Submission } from '../../lib/db';
import { buildWeaknessProfile, isWeaknessProfileEmpty } from './weakness';

let seq = 0;

function makeAzure(overrides: Partial<AzurePronunciationResult> = {}): AzurePronunciationResult {
  return {
    pronScore: 80,
    accuracyScore: 80,
    fluencyScore: 80,
    completenessScore: 100,
    words: [],
    ...overrides,
  };
}

function makeSubmission(
  overrides: Omit<Partial<Submission>, 'judge'> & { judge?: Partial<JudgeResult> } = {},
): Submission {
  seq += 1;
  const { judge, ...rest } = overrides;
  return {
    id: `sub-${seq}`,
    materialId: 'voa-1-p1',
    date: '2026-07-01',
    audioBlob: new Blob(['x']),
    mimeType: 'audio/webm',
    createdAt: seq, // 呼び出し順=createdAt昇順（テストの可読性のため小さい連番を使う。overridesで上書き可）
    ...(judge
      ? {
          judge: {
            matchRate: 0.8,
            wpm: 120,
            wordMarks: [],
            goodPoints: [],
            devPoints: [],
            engine: 'whisper-local',
            ...judge,
          } as JudgeResult,
        }
      : {}),
    ...rest,
  };
}

function makeQuizResult(overrides: Partial<QuizResult> = {}): QuizResult {
  seq += 1;
  return {
    id: `quiz-${seq}`,
    articleId: 'voa-1',
    date: '2026-07-01',
    sectionIds: ['voa-1-p1'],
    total: 5,
    correct: 3,
    createdAt: seq,
    ...overrides,
  };
}

describe('buildWeaknessProfile: 空データ', () => {
  it('提出・テスト結果が0件なら全カテゴリ空、azureSubmissionCount=0、recentMatchRateAvg=null', () => {
    const profile = buildWeaknessProfile([], []);
    expect(profile.weakPhonemes).toEqual([]);
    expect(profile.overcomePhonemes).toEqual([]);
    expect(profile.weakPhenomena).toEqual([]);
    expect(profile.weakWords).toEqual([]);
    expect(profile.azureSubmissionCount).toBe(0);
    expect(profile.recentMatchRateAvg).toBeNull();
    expect(isWeaknessProfileEmpty(profile)).toBe(true);
  });
});

describe('buildWeaknessProfile: 苦手音素', () => {
  it('出現1件なら score はそのままの値、trendはstagnant（データ不足）', () => {
    const s = makeSubmission({ judge: { azure: makeAzure({ weakPhonemes: [{ phoneme: 'R', avgScore: 40, examples: ['red'] }] }) } });
    const profile = buildWeaknessProfile([s], []);
    expect(profile.weakPhonemes).toEqual([{ phoneme: 'R', score: 40, occurrences: 1, trend: 'stagnant' }]);
    expect(profile.azureSubmissionCount).toBe(1);
  });

  it('半減期10提出の時間減衰加重平均（新しい提出ほど重みが大きい）', () => {
    // rank0（最新）=40点、rank1=80点。weight0=1, weight1=0.5^(1/10)。
    const newer = makeSubmission({
      createdAt: 200,
      judge: { azure: makeAzure({ weakPhonemes: [{ phoneme: 'R', avgScore: 40, examples: [] }] }) },
    });
    const older = makeSubmission({
      createdAt: 100,
      judge: { azure: makeAzure({ weakPhonemes: [{ phoneme: 'R', avgScore: 80, examples: [] }] }) },
    });
    const profile = buildWeaknessProfile([older, newer], []);

    const w0 = 1;
    const w1 = 0.5 ** (1 / 10);
    const expectedScore = (40 * w0 + 80 * w1) / (w0 + w1);

    expect(profile.weakPhonemes).toHaveLength(1);
    expect(profile.weakPhonemes[0].phoneme).toBe('R');
    expect(profile.weakPhonemes[0].score).toBeCloseTo(expectedScore, 6);
    expect(profile.weakPhonemes[0].occurrences).toBe(2);
  });

  it('直近の出現の方がスコアが高ければimproving、そうでなければstagnant', () => {
    const older = makeSubmission({
      createdAt: 100,
      judge: { azure: makeAzure({ weakPhonemes: [{ phoneme: 'R', avgScore: 30, examples: [] }] }) },
    });
    const newer = makeSubmission({
      createdAt: 200,
      judge: { azure: makeAzure({ weakPhonemes: [{ phoneme: 'R', avgScore: 60, examples: [] }] }) },
    });
    const improving = buildWeaknessProfile([older, newer], []);
    expect(improving.weakPhonemes[0].trend).toBe('improving');

    const olderHigh = makeSubmission({
      createdAt: 300,
      judge: { azure: makeAzure({ weakPhonemes: [{ phoneme: 'TH', avgScore: 60, examples: [] }] }) },
    });
    const newerLow = makeSubmission({
      createdAt: 400,
      judge: { azure: makeAzure({ weakPhonemes: [{ phoneme: 'TH', avgScore: 30, examples: [] }] }) },
    });
    const stagnant = buildWeaknessProfile([olderHigh, newerLow], []);
    expect(stagnant.weakPhonemes[0].trend).toBe('stagnant');
  });

  it('直近平均が75以上になった音素は克服扱いでweakPhonemesから除きovercomePhonemesに入れる', () => {
    const s = makeSubmission({ judge: { azure: makeAzure({ weakPhonemes: [{ phoneme: 'R', avgScore: 90, examples: [] }] }) } });
    const profile = buildWeaknessProfile([s], []);
    expect(profile.weakPhonemes).toEqual([]);
    expect(profile.overcomePhonemes).toEqual(['R']);
  });

  it('苦手音素は上位3件（スコア低い順）に絞る', () => {
    const s = makeSubmission({
      judge: {
        azure: makeAzure({
          weakPhonemes: [
            { phoneme: 'R', avgScore: 50, examples: [] },
            { phoneme: 'TH', avgScore: 20, examples: [] },
            { phoneme: 'AE', avgScore: 40, examples: [] },
            { phoneme: 'S', avgScore: 60, examples: [] },
          ],
        }),
      },
    });
    const profile = buildWeaknessProfile([s], []);
    expect(profile.weakPhonemes.map((w) => w.phoneme)).toEqual(['TH', 'AE', 'R']);
  });

  it('azureデータの無い提出はazureSubmissionCountに数えない', () => {
    const withAzure = makeSubmission({ judge: { azure: makeAzure({ weakPhonemes: [{ phoneme: 'R', avgScore: 50, examples: [] }] }) } });
    const withoutAzure = makeSubmission({ judge: {} });
    const noJudgeAtAll = makeSubmission();
    const profile = buildWeaknessProfile([withAzure, withoutAzure, noJudgeAtAll], []);
    expect(profile.azureSubmissionCount).toBe(1);
  });
});

describe('buildWeaknessProfile: 苦手現象', () => {
  it('頻度×未改善率でスコアを計算し、改善できていない現象ほど上位に並べる', () => {
    const submissions = [
      makeSubmission({ judge: { issues: [{ type: 'linking', words: ['a', 'b'], si: 0 }] } }),
      makeSubmission({ judge: { issues: [{ type: 'linking', words: ['c', 'd'], si: 1 }] } }),
      makeSubmission({
        judge: {
          issues: [{ type: 'weak', words: ['of'], si: 0 }],
          previousIssueOutcomes: [{ type: 'weak', words: ['of'], improved: false }],
        },
      }),
    ];
    const profile = buildWeaknessProfile(submissions, []);
    // linking: frequency=2, 比較実績なし→未改善率=1 → score=2
    // weak: frequency=1, improved=false→未改善率=1 → score=1（改善していない現象は頻度そのままの重み）
    expect(profile.weakPhenomena[0]).toMatchObject({ type: 'linking', frequency: 2, score: 2 });
    expect(profile.weakPhenomena.find((p) => p.type === 'weak')).toMatchObject({ frequency: 1, score: 1 });
    expect(profile.weakPhenomena[0].score).toBeGreaterThanOrEqual(profile.weakPhenomena[1]?.score ?? -Infinity);
  });

  it('改善済みの現象は未改善の現象より下位になる（下限0.1で完全には消えない）', () => {
    const submissions = [
      // flap: 2回指摘されたが2回とも改善済み → score = 2 × 0.1 = 0.2
      makeSubmission({ judge: { issues: [{ type: 'flap', words: ['water'], si: 0 }] } }),
      makeSubmission({
        judge: {
          issues: [{ type: 'flap', words: ['better'], si: 0 }],
          previousIssueOutcomes: [{ type: 'flap', words: ['water'], improved: true }],
        },
      }),
      makeSubmission({
        judge: {
          previousIssueOutcomes: [{ type: 'flap', words: ['better'], improved: true }],
        },
      }),
      // weak: 1回指摘され未改善 → score = 1 × 1 = 1
      makeSubmission({
        judge: {
          issues: [{ type: 'weak', words: ['of'], si: 0 }],
          previousIssueOutcomes: [{ type: 'weak', words: ['of'], improved: false }],
        },
      }),
    ];
    const profile = buildWeaknessProfile(submissions, []);
    const flap = profile.weakPhenomena.find((p) => p.type === 'flap');
    const weak = profile.weakPhenomena.find((p) => p.type === 'weak');
    expect(flap).toMatchObject({ frequency: 2 });
    expect(flap?.score).toBeCloseTo(0.2, 6);
    expect(weak?.score).toBeCloseTo(1, 6);
    expect(weak!.score).toBeGreaterThan(flap!.score);
  });

  it('issuesが無ければ空配列', () => {
    const profile = buildWeaknessProfile([makeSubmission({ judge: {} })], []);
    expect(profile.weakPhenomena).toEqual([]);
  });
});

describe('buildWeaknessProfile: 苦手単語', () => {
  it('missed/subが2回以上重なった語（正規化して同一視）を拾う', () => {
    const submissions = [
      makeSubmission({
        judge: {
          wordMarks: [
            { word: 'Korea,', si: 0, status: 'missed' },
            { word: 'today', si: 0, status: 'ok' },
          ],
        },
      }),
      makeSubmission({
        judge: {
          wordMarks: [{ word: 'korea', si: 0, status: 'sub', recognized: 'x' }],
        },
      }),
    ];
    const profile = buildWeaknessProfile(submissions, []);
    expect(profile.weakWords).toEqual([{ word: 'Korea,', count: 2 }]);
  });

  it('1回しか出ない語は含めない', () => {
    const profile = buildWeaknessProfile(
      [makeSubmission({ judge: { wordMarks: [{ word: 'once', si: 0, status: 'missed' }] } })],
      [],
    );
    expect(profile.weakWords).toEqual([]);
  });

  it('Azureの低スコア語（60点未満）も対象に数える', () => {
    const submissions = [
      makeSubmission({ judge: { azure: makeAzure({ words: [{ word: 'water', accuracyScore: 40 }] }) } }),
      makeSubmission({ judge: { azure: makeAzure({ words: [{ word: 'water', accuracyScore: 50 }] }) } }),
    ];
    const profile = buildWeaknessProfile(submissions, []);
    expect(profile.weakWords).toEqual([{ word: 'water', count: 2 }]);
  });

  it('60点以上のAzure語は数えない', () => {
    const submissions = [
      makeSubmission({ judge: { azure: makeAzure({ words: [{ word: 'water', accuracyScore: 80 }] }) } }),
      makeSubmission({ judge: { azure: makeAzure({ words: [{ word: 'water', accuracyScore: 90 }] }) } }),
    ];
    const profile = buildWeaknessProfile(submissions, []);
    expect(profile.weakWords).toEqual([]);
  });

  it('確認テストの誤答語（wrongWords）も対象に数える', () => {
    const quizResults = [makeQuizResult({ wrongWords: ['about'] }), makeQuizResult({ wrongWords: ['about'] })];
    const profile = buildWeaknessProfile([], quizResults);
    expect(profile.weakWords).toEqual([{ word: 'about', count: 2 }]);
  });

  it('件数の多い順にソートし上位5件に絞る', () => {
    const marks = ['a', 'b', 'c', 'd', 'e', 'f'].flatMap((w, i) =>
      Array.from({ length: 6 - i }, () => ({ word: w, si: 0, status: 'missed' as const })),
    );
    const profile = buildWeaknessProfile([makeSubmission({ judge: { wordMarks: marks } })], []);
    expect(profile.weakWords).toHaveLength(5);
    expect(profile.weakWords.map((w) => w.word)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('buildWeaknessProfile: レベル適正（recentMatchRateAvg）', () => {
  it('直近最大5件のjudge付き提出のmatchRate平均を返す', () => {
    const submissions = [1, 2, 3, 4, 5, 6].map((n) =>
      makeSubmission({ createdAt: n, judge: { matchRate: n / 10 } }),
    );
    const profile = buildWeaknessProfile(submissions, []);
    // 直近5件 = createdAt 2..6 → matchRate 0.2..0.6 の平均 = 0.4
    expect(profile.recentMatchRateAvg).toBeCloseTo(0.4, 6);
  });

  it('judge付き提出が無ければnull', () => {
    const profile = buildWeaknessProfile([makeSubmission()], []);
    expect(profile.recentMatchRateAvg).toBeNull();
  });
});

describe('isWeaknessProfileEmpty', () => {
  it('いずれかのカテゴリにデータがあればfalse', () => {
    const profile = buildWeaknessProfile(
      [makeSubmission({ judge: { azure: makeAzure({ weakPhonemes: [{ phoneme: 'R', avgScore: 30, examples: [] }] }) } })],
      [],
    );
    expect(isWeaknessProfileEmpty(profile)).toBe(false);
  });
});

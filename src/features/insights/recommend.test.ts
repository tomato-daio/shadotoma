import { describe, expect, it } from 'vitest';
import type { Material, MaterialProgress } from '../../lib/db';
import { recommendMaterials } from './recommend';
import type { WeaknessProfile } from './weakness';

let seq = 0;
function makeMaterial(overrides: Partial<Material> = {}): Material {
  seq += 1;
  return {
    id: `voa-${seq}-p1`,
    source: 'voa',
    title: `教材${seq}`,
    level: 1,
    category: 'As It Is',
    audioUrl: `materials/audio/voa-${seq}-p1.mp3`,
    sentences: [{ en: 'This is a simple test sentence today.' }],
    wordCount: 7,
    addedAt: seq,
    articleId: `voa-${seq}`,
    part: 1,
    partCount: 1,
    ...overrides,
  };
}

function makeProgress(materialId: string, status: MaterialProgress['status']): MaterialProgress {
  return { materialId, daysPracticed: ['2026-07-01'], totalLoops: 1, lastStep: 'shadowing', status };
}

function makeProfile(overrides: Partial<WeaknessProfile> = {}): WeaknessProfile {
  return {
    weakPhonemes: [],
    overcomePhonemes: [],
    weakPhenomena: [],
    weakWords: [],
    azureSubmissionCount: 5, // コールドスタートを外す既定値
    recentMatchRateAvg: null,
    ...overrides,
  };
}

describe('recommendMaterials: コールドスタート（DESIGN.md §8d）', () => {
  it('Azure付き提出が3件未満ならレベル順の未着手教材を返し、reasonは「まずはここから。」', () => {
    const m1 = makeMaterial({ level: 2 });
    const m2 = makeMaterial({ level: 1 });
    const m3 = makeMaterial({ level: 3 });
    const profile = makeProfile({ azureSubmissionCount: 2 });

    const result = recommendMaterials(profile, [m1, m2, m3], []);

    expect(result).toHaveLength(2);
    expect(result[0].material.id).toBe(m2.id); // level1が最初
    expect(result[1].material.id).toBe(m1.id); // 次にlevel2
    expect(result.every((r) => r.reason === 'まずはここから。')).toBe(true);
  });

  it('done教材とlocal教材は対象から除外する', () => {
    const doneMaterial = makeMaterial({ level: 1 });
    const activeMaterial = makeMaterial({ level: 1 });
    const localMaterial = makeMaterial({ source: 'local', level: 1, audioUrl: undefined });
    const profile = makeProfile({ azureSubmissionCount: 0 });

    const result = recommendMaterials(
      profile,
      [doneMaterial, activeMaterial, localMaterial],
      [makeProgress(doneMaterial.id, 'done')],
    );

    expect(result.map((r) => r.material.id)).not.toContain(doneMaterial.id);
    expect(result.map((r) => r.material.id)).not.toContain(localMaterial.id);
    expect(result.map((r) => r.material.id)).toContain(activeMaterial.id);
  });

  it('候補が無ければ空配列', () => {
    const profile = makeProfile({ azureSubmissionCount: 0 });
    expect(recommendMaterials(profile, [], [])).toEqual([]);
  });
});

describe('recommendMaterials: 苦手音素×phonemeCounts密度', () => {
  it('苦手音素を多く含む教材を優先し、理由文にその音の名前を含める', () => {
    const rich = makeMaterial({ phonemeCounts: { R: 10 }, wordCount: 20 });
    const poor = makeMaterial({ phonemeCounts: { R: 0 }, wordCount: 20 });
    const profile = makeProfile({ weakPhonemes: [{ phoneme: 'R', score: 30, occurrences: 3, trend: 'stagnant' }] });

    const result = recommendMaterials(profile, [poor, rich], []);

    expect(result[0].material.id).toBe(rich.id);
    expect(result[0].reason).toContain('rの音');
  });

  it('phonemeCountsが無い教材（旧データ）でもクラッシュせず、単に加点なしになる', () => {
    const material = makeMaterial({});
    const profile = makeProfile({ weakPhonemes: [{ phoneme: 'R', score: 30, occurrences: 1, trend: 'stagnant' }] });
    expect(() => recommendMaterials(profile, [material], [])).not.toThrow();
  });
});

describe('recommendMaterials: 苦手現象の練習機会数', () => {
  it('苦手現象（linking）の構造的な出現が多い教材を優先する', () => {
    // "picked it" は子音終わり(d)+母音始まり(it)でlinkingの構造に合致する。
    const linkingRich = makeMaterial({
      sentences: [{ en: 'He picked it up and looked around.' }, { en: 'He picked it up again today.' }],
      wordCount: 16,
    });
    const linkingPoor = makeMaterial({
      sentences: [{ en: 'Many students study every single day.' }],
      wordCount: 6,
    });
    const profile = makeProfile({ weakPhenomena: [{ type: 'linking', frequency: 5, score: 5 }] });

    const result = recommendMaterials(profile, [linkingPoor, linkingRich], []);
    expect(result[0].material.id).toBe(linkingRich.id);
    expect(result[0].reason).toContain('連結');
  });
});

describe('recommendMaterials: 苦手単語出現', () => {
  it('苦手単語を含む教材を優先し、理由文にその語を含める', () => {
    const withWord = makeMaterial({ sentences: [{ en: 'The water was very cold today.' }], wordCount: 6 });
    const withoutWord = makeMaterial({ sentences: [{ en: 'The weather was very nice today.' }], wordCount: 6 });
    const profile = makeProfile({ weakWords: [{ word: 'water', count: 3 }] });

    const result = recommendMaterials(profile, [withoutWord, withWord], []);
    expect(result[0].material.id).toBe(withWord.id);
    expect(result[0].reason).toContain('water');
  });
});

describe('recommendMaterials: レベル適正', () => {
  it('直近一致率が低ければ低レベル教材を優先する', () => {
    const low = makeMaterial({ level: 1 });
    const high = makeMaterial({ level: 3 });
    const profile = makeProfile({ recentMatchRateAvg: 0.4 });

    const result = recommendMaterials(profile, [high, low], []);
    expect(result[0].material.id).toBe(low.id);
    expect(result[0].reason).toContain('レベル');
  });

  it('直近一致率が高ければ上のレベルの教材を優先する', () => {
    const low = makeMaterial({ level: 1 });
    const high = makeMaterial({ level: 3 });
    const profile = makeProfile({ recentMatchRateAvg: 0.9 });

    const result = recommendMaterials(profile, [low, high], []);
    expect(result[0].material.id).toBe(high.id);
  });
});

describe('recommendMaterials: 上位2件', () => {
  it('候補が多くても上位2件のみ返す', () => {
    const materials = Array.from({ length: 5 }, () => makeMaterial({ phonemeCounts: { R: 5 }, wordCount: 10 }));
    const profile = makeProfile({ weakPhonemes: [{ phoneme: 'R', score: 30, occurrences: 1, trend: 'stagnant' }] });
    const result = recommendMaterials(profile, materials, []);
    expect(result).toHaveLength(2);
  });
});

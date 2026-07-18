import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addSubmission,
  getAllMaterials,
  getMaterial,
  getMaterialProgress,
  getSubmissionsByMaterial,
  newId,
  putMaterial,
  putMaterialProgress,
  resetDBForTest,
  syncBundledMaterials,
  touchMaterialProgress,
  type Material,
  type Submission,
} from './db';

function makeMaterial(overrides: Partial<Material> = {}): Material {
  return {
    id: newId('local'),
    source: 'local',
    title: 'テスト教材',
    level: 0,
    category: 'Local',
    sentences: [{ en: 'Hello world.', ja: 'こんにちは世界。' }],
    wordCount: 2,
    addedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(async () => {
  await resetDBForTest();
});

afterEach(async () => {
  await resetDBForTest();
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase('shadotoma');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error as Error);
    req.onblocked = () => resolve();
  });
});

describe('materials CRUD', () => {
  it('保存した教材を取得できる', async () => {
    const material = makeMaterial({ title: '保存テスト' });
    await putMaterial(material);

    const fetched = await getMaterial(material.id);
    expect(fetched?.title).toBe('保存テスト');
  });

  it('全教材を取得できる', async () => {
    await putMaterial(makeMaterial());
    await putMaterial(makeMaterial());

    const all = await getAllMaterials();
    expect(all).toHaveLength(2);
  });
});

describe('materialProgress', () => {
  it('初回のtouchでnot-startedからactiveになり、daysPracticedに日付が追加される', async () => {
    const materialId = 'local-abc';
    const progress = await touchMaterialProgress(materialId, '2026-07-18', 'listening', 3);

    expect(progress.status).toBe('active');
    expect(progress.daysPracticed).toEqual(['2026-07-18']);
    expect(progress.totalLoops).toBe(3);
    expect(progress.lastStep).toBe('listening');
  });

  it('同じ日付を複数回touchしても重複しない', async () => {
    const materialId = 'local-dup';
    await touchMaterialProgress(materialId, '2026-07-18', 'listening', 1);
    const progress = await touchMaterialProgress(materialId, '2026-07-18', 'script', 2);

    expect(progress.daysPracticed).toEqual(['2026-07-18']);
    expect(progress.totalLoops).toBe(3);
    expect(progress.lastStep).toBe('script');
  });

  it('別日にtouchするとdaysPracticedが増える', async () => {
    const materialId = 'local-multi';
    await touchMaterialProgress(materialId, '2026-07-17', 'listening', 1);
    const progress = await touchMaterialProgress(materialId, '2026-07-18', 'overlapping', 1);

    expect(progress.daysPracticed).toEqual(['2026-07-17', '2026-07-18']);
  });

  it('進捗が無い教材はundefinedを返す', async () => {
    const progress = await getMaterialProgress('does-not-exist');
    expect(progress).toBeUndefined();
  });
});

describe('submissions', () => {
  it('提出を保存し、教材ごとに新しい順で取得できる', async () => {
    const materialId = 'local-sub';
    const older: Submission = {
      id: newId('sub'),
      materialId,
      date: '2026-07-17',
      audioBlob: new Blob(['a']),
      mimeType: 'audio/webm',
      createdAt: 1000,
    };
    const newer: Submission = {
      id: newId('sub'),
      materialId,
      date: '2026-07-18',
      audioBlob: new Blob(['b']),
      mimeType: 'audio/webm',
      createdAt: 2000,
    };
    await addSubmission(older);
    await addSubmission(newer);

    const list = await getSubmissionsByMaterial(materialId);
    expect(list.map((s) => s.id)).toEqual([newer.id, older.id]);
  });
});

function makeBundledMaterial(overrides: Partial<Material> = {}): Material {
  return {
    id: 'voa-1000-p1',
    source: 'voa',
    title: 'VOAテスト記事 (1/2)',
    level: 1,
    category: 'As It Is',
    audioUrl: 'materials/audio/voa-1000-p1.mp3',
    sentences: [{ en: 'Hello.' }],
    wordCount: 1,
    addedAt: 1,
    articleId: 'voa-1000',
    part: 1,
    partCount: 2,
    ...overrides,
  };
}

describe('syncBundledMaterials', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('indexの内容をbundled教材として新規追加する', async () => {
    const indexData = [makeBundledMaterial()];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(indexData), { status: 200 })),
    );

    await syncBundledMaterials('/');

    const all = await getAllMaterials();
    expect(all.map((m) => m.id)).toEqual(['voa-1000-p1']);
  });

  it('既存のbundled教材のうちindexから消えたものはIndexedDBからも削除する', async () => {
    await putMaterial(makeBundledMaterial({ id: 'voa-1000-p1' }));
    await putMaterial(makeBundledMaterial({ id: 'voa-1000-p2', part: 2 }));

    // 新しいindexには p1 だけが残っている（記事が再分割され p2 が消えたケースを想定）
    const indexData = [makeBundledMaterial({ id: 'voa-1000-p1', title: '更新後タイトル' })];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(indexData), { status: 200 })),
    );

    await syncBundledMaterials('/');

    const all = await getAllMaterials();
    expect(all.map((m) => m.id).sort()).toEqual(['voa-1000-p1']);
    expect((await getMaterial('voa-1000-p1'))?.title).toBe('更新後タイトル');
  });

  it('source:localのローカル取り込み教材はindexに無くても絶対に削除しない', async () => {
    const local: Material = {
      id: newId('local'),
      source: 'local',
      title: 'ローカル取り込み教材',
      level: 0,
      category: 'Local',
      sentences: [{ en: 'Keep me.' }],
      wordCount: 2,
      addedAt: Date.now(),
    };
    await putMaterial(local);
    await putMaterial(makeBundledMaterial({ id: 'voa-1000-p1' }));

    // indexは空（＝bundled教材が全て消えたケース）
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })),
    );

    await syncBundledMaterials('/');

    const all = await getAllMaterials();
    expect(all.map((m) => m.id)).toEqual([local.id]);
    expect(await getMaterial(local.id)).toBeDefined();
  });

  it('indexから消えて削除された教材でもmaterialProgressは残る', async () => {
    const materialId = 'voa-1000-p1';
    await putMaterial(makeBundledMaterial({ id: materialId }));
    await putMaterialProgress({
      materialId,
      daysPracticed: ['2026-07-17'],
      totalLoops: 3,
      lastStep: 'listening',
      status: 'active',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })),
    );

    await syncBundledMaterials('/');

    expect(await getMaterial(materialId)).toBeUndefined();
    expect(await getMaterialProgress(materialId)).toBeDefined();
  });

  it('fetch失敗時は例外を投げず既存DBのまま継続する', async () => {
    await putMaterial(makeBundledMaterial({ id: 'voa-1000-p1' }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network error');
      }),
    );

    await expect(syncBundledMaterials('/')).resolves.toBeUndefined();
    expect(await getMaterial('voa-1000-p1')).toBeDefined();
  });
});

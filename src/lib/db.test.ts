import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addQuizResult,
  addSubmission,
  getAllMaterials,
  getMaterial,
  getMaterialProgress,
  getMaterialsByArticleId,
  getQuizResultsByArticle,
  getRecentQuizResults,
  getSubmissionsByMaterial,
  markMaterialProgressDone,
  newId,
  putMaterial,
  putMaterialProgress,
  resetDBForTest,
  syncBundledMaterials,
  touchMaterialProgress,
  type Material,
  type QuizResult,
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

describe('markMaterialProgressDone (DESIGN.md §8b)', () => {
  it('既存レコードのstatusをdoneに更新する（daysPracticed/totalLoopsは維持）', async () => {
    const materialId = 'local-done-1';
    await touchMaterialProgress(materialId, '2026-07-17', 'shadowing', 5);

    const progress = await markMaterialProgressDone(materialId, '2026-07-18');

    expect(progress.status).toBe('done');
    expect(progress.totalLoops).toBe(5);
    expect(progress.daysPracticed).toEqual(['2026-07-17', '2026-07-18']);
  });

  it('レコードが無い場合でも新規作成してdoneにする（ステップを飛ばして直接提出したケース）', async () => {
    const materialId = 'local-done-2';
    const progress = await markMaterialProgressDone(materialId, '2026-07-18');

    expect(progress.status).toBe('done');
    expect(progress.daysPracticed).toEqual(['2026-07-18']);
  });

  it('既にdoneなら冪等（daysPracticedに新しい日付を足さない）', async () => {
    const materialId = 'local-done-3';
    await markMaterialProgressDone(materialId, '2026-07-17');
    const progress = await markMaterialProgressDone(materialId, '2026-07-18');

    expect(progress.status).toBe('done');
    expect(progress.daysPracticed).toEqual(['2026-07-17']);
  });

  it('touchMaterialProgressはdoneをactiveへ巻き戻さない（継続練習してもdoneのまま）', async () => {
    const materialId = 'local-done-4';
    await touchMaterialProgress(materialId, '2026-07-17', 'shadowing', 1);
    await markMaterialProgressDone(materialId, '2026-07-17');

    const progress = await touchMaterialProgress(materialId, '2026-07-18', 'shadowing', 1);

    expect(progress.status).toBe('done');
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

describe('getMaterialsByArticleId', () => {
  it('同一articleIdのセクションをpart順で返す', async () => {
    await putMaterial(makeBundledMaterial({ id: 'voa-1000-p2', part: 2 }));
    await putMaterial(makeBundledMaterial({ id: 'voa-1000-p1', part: 1 }));
    await putMaterial(makeBundledMaterial({ id: 'voa-2000-p1', articleId: 'voa-2000', part: 1 }));

    const sections = await getMaterialsByArticleId('voa-1000');

    expect(sections.map((m) => m.id)).toEqual(['voa-1000-p1', 'voa-1000-p2']);
  });
});

function makeQuizResult(overrides: Partial<QuizResult> = {}): QuizResult {
  return {
    id: newId('quiz'),
    articleId: 'voa-1000',
    date: '2026-07-18',
    sectionIds: ['voa-1000-p1'],
    total: 5,
    correct: 4,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('quizResults（DESIGN.md §8b）', () => {
  it('保存した結果を記事ごとに新しい順で取得できる', async () => {
    const older = makeQuizResult({ id: newId('quiz'), createdAt: 1000 });
    const newer = makeQuizResult({ id: newId('quiz'), createdAt: 2000 });
    await addQuizResult(older);
    await addQuizResult(newer);
    await addQuizResult(makeQuizResult({ id: newId('quiz'), articleId: 'voa-9999', createdAt: 3000 }));

    const list = await getQuizResultsByArticle('voa-1000');

    expect(list.map((r) => r.id)).toEqual([newer.id, older.id]);
  });

  it('getRecentQuizResultsは全記事横断で新しい順に最大limit件を返す', async () => {
    for (let i = 0; i < 7; i++) {
      await addQuizResult(makeQuizResult({ id: newId('quiz'), createdAt: i }));
    }

    const recent = await getRecentQuizResults(3);

    expect(recent).toHaveLength(3);
    expect(recent.map((r) => r.createdAt)).toEqual([6, 5, 4]);
  });
});

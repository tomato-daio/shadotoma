import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addSubmission,
  getAllMaterials,
  getMaterial,
  getMaterialProgress,
  getSubmissionsByMaterial,
  newId,
  putMaterial,
  resetDBForTest,
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

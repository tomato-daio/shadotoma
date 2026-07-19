import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportAllData, importAllData, type BackupBundle } from './backup';
import { getAppState, resetDBForTest, setAppState } from './db';

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

async function readBundle(blob: Blob): Promise<BackupBundle> {
  return JSON.parse(await blob.text()) as BackupBundle;
}

function makeEmptyBundle(appState: BackupBundle['appState']): BackupBundle {
  return {
    app: 'shadotoma',
    version: 2,
    exportedAt: Date.now(),
    materials: [],
    sessions: [],
    submissions: [],
    materialProgress: [],
    appState,
    quizResults: [],
  };
}

describe('exportAllData (DESIGN.md §8c: azureSpeechKeyの除外)', () => {
  it('azureSpeechKeyをエクスポートから除外する', async () => {
    await setAppState('azureSpeechKey', 'secret-key-123');
    await setAppState('azureSpeechRegion', 'japaneast');
    await setAppState('whisperModel', 'fast');

    const blob = await exportAllData();
    const bundle = await readBundle(blob);

    expect(bundle.appState.some((e) => e.key === 'azureSpeechKey')).toBe(false);
  });

  it('azureSpeechRegionや他のappStateはエクスポートに含める', async () => {
    await setAppState('azureSpeechKey', 'secret-key-123');
    await setAppState('azureSpeechRegion', 'japaneast');
    await setAppState('whisperModel', 'fast');

    const blob = await exportAllData();
    const bundle = await readBundle(blob);

    expect(bundle.appState.find((e) => e.key === 'azureSpeechRegion')?.value).toBe('japaneast');
    expect(bundle.appState.find((e) => e.key === 'whisperModel')?.value).toBe('fast');
  });
});

describe('importAllData (DESIGN.md §8c: 復元時も既存キーを消さない)', () => {
  it('インポート後も端末に保存済みのazureSpeechKeyを保持する', async () => {
    await setAppState('azureSpeechKey', 'original-secret');

    const bundle = makeEmptyBundle([{ key: 'whisperModel', value: 'fast' }]);
    const blob = new Blob([JSON.stringify(bundle)], { type: 'application/json' });

    await importAllData(blob);

    expect(await getAppState('azureSpeechKey')).toBe('original-secret');
    expect(await getAppState('whisperModel')).toBe('fast');
  });

  it('バックアップ側にazureSpeechKeyが含まれていても取り込まない（キーが未設定なら未設定のまま）', async () => {
    // 既存キーなし。バックアップ側に紛れ込んだazureSpeechKeyがあっても復元しない
    // （常に「復元前の端末の値」を優先するため、未設定なら未設定のままになる）。
    const bundle = makeEmptyBundle([{ key: 'azureSpeechKey', value: 'from-shared-backup-file' }]);
    const blob = new Blob([JSON.stringify(bundle)], { type: 'application/json' });

    await importAllData(blob);

    expect(await getAppState('azureSpeechKey')).toBeUndefined();
  });

  it('他のappState（教材の添削精度設定など）は通常どおりインポートされる', async () => {
    const bundle = makeEmptyBundle([{ key: 'whisperModel', value: 'high' }]);
    const blob = new Blob([JSON.stringify(bundle)], { type: 'application/json' });

    await importAllData(blob);

    expect(await getAppState('whisperModel')).toBe('high');
  });
});

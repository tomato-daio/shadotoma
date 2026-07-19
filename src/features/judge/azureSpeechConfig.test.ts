import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDBForTest } from '../../lib/db';
import {
  clearAzureSpeechCredentials,
  DEFAULT_AZURE_REGION,
  getAzureSpeechKey,
  getAzureSpeechRegion,
  setAzureSpeechCredentials,
  testAzureSpeechConnection,
} from './azureSpeechConfig';

beforeEach(async () => {
  await resetDBForTest();
});

afterEach(async () => {
  await resetDBForTest();
  vi.unstubAllGlobals();
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase('shadotoma');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error as Error);
    req.onblocked = () => resolve();
  });
});

describe('azureSpeechConfig: appStateの保存/取得', () => {
  it('未設定の初期状態ではキーはundefined・リージョンは初期値(japaneast)', async () => {
    expect(await getAzureSpeechKey()).toBeUndefined();
    expect(await getAzureSpeechRegion()).toBe(DEFAULT_AZURE_REGION);
  });

  it('setAzureSpeechCredentialsで保存した値を取得できる', async () => {
    await setAzureSpeechCredentials('my-key', 'eastus');
    expect(await getAzureSpeechKey()).toBe('my-key');
    expect(await getAzureSpeechRegion()).toBe('eastus');
  });

  it('clearAzureSpeechCredentialsで削除すると初期状態に戻る', async () => {
    await setAzureSpeechCredentials('my-key', 'eastus');
    await clearAzureSpeechCredentials();
    expect(await getAzureSpeechKey()).toBeUndefined();
    expect(await getAzureSpeechRegion()).toBe(DEFAULT_AZURE_REGION);
  });
});

describe('testAzureSpeechConnection', () => {
  it('キーが空ならネットワークへ問い合わせずに失敗を返す', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await testAzureSpeechConnection('', 'japaneast');

    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('issueTokenエンドポイントが200なら成功を返す', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response),
    );

    const result = await testAzureSpeechConnection('valid-key', 'japaneast');

    expect(result.ok).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      'https://japaneast.api.cognitive.microsoft.com/sts/v1.0/issueToken',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Ocp-Apim-Subscription-Key': 'valid-key' },
      }),
    );
  });

  it('401が返るとキー無効のメッセージになる', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 } as Response));

    const result = await testAzureSpeechConnection('bad-key', 'japaneast');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('APIキーが無効です');
  });

  it('fetchが例外を投げるとネットワークエラーのメッセージになる', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const result = await testAzureSpeechConnection('any-key', 'japaneast');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('ネットワークエラー');
  });

  it('その他のHTTPエラーはステータスコードを含むメッセージになる', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response));

    const result = await testAzureSpeechConnection('any-key', 'japaneast');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('500');
  });
});

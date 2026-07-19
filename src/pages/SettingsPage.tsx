import { useEffect, useRef, useState } from 'react';
import {
  AZURE_REGION_OPTIONS,
  clearAzureSpeechCredentials,
  DEFAULT_AZURE_REGION,
  getAzureSpeechKey,
  getAzureSpeechRegion,
  setAzureSpeechCredentials,
  testAzureSpeechConnection,
} from '../features/judge/azureSpeechConfig';
import { SelfTest } from '../features/judge/SelfTest';
import {
  getSelectedWhisperModelKey,
  setSelectedWhisperModelKey,
  WHISPER_MODEL_OPTIONS,
  type WhisperModelKey,
} from '../features/judge/whisperModels';
import { buildBackupFileName, exportAllData, importAllData } from '../lib/backup';
import { useMaterialsStore } from '../stores/useMaterialsStore';

/** 隠しボタン: アプリ情報を5回タップすると自己テストセクションが現れる（DESIGN.md §10 M3-7）。 */
const HIDDEN_UNLOCK_TAP_COUNT = 5;

export function SettingsPage() {
  const { materials, loaded, refresh } = useMaterialsStore();
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [versionTapCount, setVersionTapCount] = useState(0);
  // null = 読み込み中（読み込み完了までボタンを出さず、初期値の点滅を避ける）
  const [whisperModelKey, setWhisperModelKey] = useState<WhisperModelKey | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // ---- Azure発音評価（DESIGN.md §8c・M9・任意機能） ----
  const [azureApiKeyInput, setAzureApiKeyInput] = useState('');
  const [azureRegionInput, setAzureRegionInput] = useState(DEFAULT_AZURE_REGION);
  const [azureConfigured, setAzureConfigured] = useState(false);
  const [azureSaving, setAzureSaving] = useState(false);
  const [azureTesting, setAzureTesting] = useState(false);
  const [azureStatus, setAzureStatus] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (!loaded) void refresh();
  }, [loaded, refresh]);

  useEffect(() => {
    let cancelled = false;
    void getSelectedWhisperModelKey().then((key) => {
      if (!cancelled) setWhisperModelKey(key);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([getAzureSpeechKey(), getAzureSpeechRegion()]).then(([key, region]) => {
      if (cancelled) return;
      if (key) {
        setAzureApiKeyInput(key);
        setAzureConfigured(true);
      }
      setAzureRegionInput(region);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSelectWhisperModel = (key: WhisperModelKey) => {
    setWhisperModelKey(key);
    void setSelectedWhisperModelKey(key);
  };

  const handleSaveAzure = async () => {
    const key = azureApiKeyInput.trim();
    if (!key) {
      setAzureStatus({ ok: false, message: 'APIキーを入力してください。' });
      return;
    }
    setAzureSaving(true);
    setAzureStatus(null);
    try {
      await setAzureSpeechCredentials(key, azureRegionInput);
      setAzureConfigured(true);
      setAzureStatus({ ok: true, message: '保存しました。次回の提出から発音スコアが採点されます。' });
    } finally {
      setAzureSaving(false);
    }
  };

  const handleTestAzure = async () => {
    const key = azureApiKeyInput.trim();
    setAzureTesting(true);
    setAzureStatus(null);
    try {
      const result = await testAzureSpeechConnection(key, azureRegionInput);
      setAzureStatus(result);
    } finally {
      setAzureTesting(false);
    }
  };

  const handleDeleteAzure = async () => {
    const confirmed = window.confirm('保存済みのAzure APIキーを削除します。よろしいですか？');
    if (!confirmed) return;
    await clearAzureSpeechCredentials();
    setAzureApiKeyInput('');
    setAzureRegionInput(DEFAULT_AZURE_REGION);
    setAzureConfigured(false);
    setAzureStatus({ ok: true, message: '削除しました。以降は通常のWhisper採点のみになります。' });
  };

  // 開発ビルド（`npm run dev`）では常に表示。本番ビルドではアプリ情報を連打した時だけ表示する。
  const showSelfTest = import.meta.env.DEV || versionTapCount >= HIDDEN_UNLOCK_TAP_COUNT;

  const handleExport = async () => {
    setExporting(true);
    setError(null);
    setMessage(null);
    try {
      const blob = await exportAllData();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = buildBackupFileName();
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setMessage('エクスポートしました。');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'エクスポートに失敗しました');
    } finally {
      setExporting(false);
    }
  };

  const handleImportFile = async (file: File) => {
    const confirmed = window.confirm(
      '現在のデータをすべて上書きして復元します。よろしいですか？（この操作は取り消せません）',
    );
    if (!confirmed) {
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    setImporting(true);
    setError(null);
    setMessage(null);
    try {
      await importAllData(file);
      await refresh();
      setMessage('復元しました。');
    } catch (err) {
      setError(err instanceof Error ? err.message : '復元に失敗しました');
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      <h1 className="text-lg font-bold text-neutral-800">設定</h1>

      <section className="rounded-xl border border-neutral-200 p-4">
        <button
          type="button"
          onClick={() => setVersionTapCount((c) => c + 1)}
          className="w-full text-left"
        >
          <p className="text-sm font-medium text-neutral-700">アプリ情報</p>
          <p className="mt-1 text-xs text-neutral-400">シャドとま v0.1.0（M3）</p>
        </button>
      </section>

      <section className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4">
        <p className="text-sm font-medium text-neutral-700">添削の精度</p>
        <p className="text-xs text-neutral-400">
          提出の添削（AI文字起こし）に使うモデルを選べます。高精度は認識ミスが減りますが、
          処理時間が標準の約2倍かかり、初回に大きめのモデルのダウンロードが発生します。
          切り替えは次回の添削から反映されます。
        </p>
        {whisperModelKey !== null ? (
          <div className="flex flex-col gap-2" role="radiogroup" aria-label="添削の精度">
            {WHISPER_MODEL_OPTIONS.map((option) => {
              const selected = option.key === whisperModelKey;
              return (
                <button
                  key={option.key}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => handleSelectWhisperModel(option.key)}
                  className={`rounded-lg border px-3 py-2 text-left ${
                    selected
                      ? 'border-tomato-500 bg-tomato-50'
                      : 'border-neutral-200 bg-white active:bg-neutral-50'
                  }`}
                >
                  <span
                    className={`text-sm font-semibold ${selected ? 'text-tomato-700' : 'text-neutral-700'}`}
                  >
                    {selected ? '● ' : '○ '}
                    {option.label}
                  </span>
                  <span className="mt-0.5 block text-xs text-neutral-400">{option.description}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-neutral-400">読み込み中…</p>
        )}
      </section>

      <section className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4">
        <p className="text-sm font-medium text-neutral-700">発音スコア（Azure・任意）</p>
        <p className="text-xs text-neutral-400">
          Azure Speechの発音評価を使うと、音素レベルの発音スコアが追加で表示されます（任意機能・未設定でも通常どおり使えます）。
        </p>
        <ul className="list-disc pl-4 text-xs text-neutral-400">
          <li>無料枠は月5時間まで。毎日数分の練習であれば0円で使い続けられます。</li>
          <li>送信されるのは、採点する提出音声とスクリプトのみです。</li>
          <li>APIキーはこの端末内にのみ保存され、外部やバックアップファイルには含まれません。</li>
        </ul>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-600">APIキー</span>
          <input
            type="password"
            value={azureApiKeyInput}
            onChange={(e) => setAzureApiKeyInput(e.target.value)}
            placeholder="Azure Speechのキー1を貼り付け"
            className="rounded-md border border-neutral-300 px-3 py-2 text-sm"
            autoComplete="off"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-600">リージョン</span>
          <select
            value={azureRegionInput}
            onChange={(e) => setAzureRegionInput(e.target.value)}
            className="rounded-md border border-neutral-300 px-3 py-2 text-sm"
          >
            {AZURE_REGION_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void handleSaveAzure()}
            disabled={azureSaving}
            className="flex-1 rounded-md bg-tomato-500 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {azureSaving ? '保存中…' : '保存'}
          </button>
          <button
            type="button"
            onClick={() => void handleTestAzure()}
            disabled={azureTesting || !azureApiKeyInput.trim()}
            className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-600 disabled:opacity-50"
          >
            {azureTesting ? '接続テスト中…' : '接続テスト'}
          </button>
        </div>

        {azureConfigured ? (
          <button
            type="button"
            onClick={() => void handleDeleteAzure()}
            className="rounded-md border border-red-200 px-3 py-2 text-sm text-red-600 active:bg-red-50"
          >
            削除
          </button>
        ) : null}

        {azureStatus ? (
          <p className={`text-xs ${azureStatus.ok ? 'text-green-700' : 'text-red-600'}`}>{azureStatus.message}</p>
        ) : null}
      </section>

      <section className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4">
        <p className="text-sm font-medium text-neutral-700">データのエクスポート/インポート</p>
        <p className="text-xs text-neutral-400">
          学習データ（教材・録音・進捗・添削結果）は端末内(IndexedDB)にのみ保存され、外部へ送信されることはありません。
          音声を含む全データを1つのJSONファイルとして書き出し・復元できます。
        </p>
        <button
          type="button"
          onClick={() => void handleExport()}
          disabled={exporting}
          className="rounded-md bg-tomato-500 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {exporting ? '書き出し中…' : 'エクスポート（ダウンロード）'}
        </button>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-600">バックアップファイルから復元</span>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json"
            disabled={importing}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleImportFile(file);
            }}
            className="text-sm"
          />
        </label>

        {message ? <p className="text-xs text-green-700">{message}</p> : null}
        {error ? <p className="text-xs text-red-600">{error}</p> : null}
      </section>

      {showSelfTest ? (
        <section className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-4">
          <p className="text-sm font-medium text-neutral-700">添削エンジン自己テスト</p>
          <SelfTest materials={materials} />
        </section>
      ) : null}
    </div>
  );
}

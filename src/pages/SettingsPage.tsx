import { useEffect, useRef, useState } from 'react';
import { SelfTest } from '../features/judge/SelfTest';
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
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!loaded) void refresh();
  }, [loaded, refresh]);

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

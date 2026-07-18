export function SettingsPage() {
  return (
    <div className="flex flex-col gap-4 p-4">
      <h1 className="text-lg font-bold text-neutral-800">設定</h1>
      <section className="rounded-xl border border-neutral-200 p-4">
        <p className="text-sm font-medium text-neutral-700">アプリ情報</p>
        <p className="mt-1 text-xs text-neutral-400">シャドとま v0.1.0（M1）</p>
      </section>
      <section className="rounded-xl border border-neutral-200 p-4">
        <p className="text-sm font-medium text-neutral-700">データのエクスポート/インポート</p>
        <p className="mt-1 text-xs text-neutral-400">
          M3で実装予定です。学習データ（教材・録音・進捗）は端末内(IndexedDB)にのみ保存され、外部へ送信されることはありません。
        </p>
      </section>
    </div>
  );
}

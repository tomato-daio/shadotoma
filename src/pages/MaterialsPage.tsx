import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LocalMaterialImport } from '../features/materials/LocalMaterialImport';
import { useMaterialsStore } from '../stores/useMaterialsStore';

export function MaterialsPage() {
  const { materials, loaded, refresh, upsertLocal } = useMaterialsStore();
  const [importing, setImporting] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (!loaded) void refresh();
  }, [loaded, refresh]);

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-neutral-800">教材</h1>
        <button
          type="button"
          onClick={() => setImporting((v) => !v)}
          className="rounded-full border border-tomato-300 px-3 py-1 text-xs font-medium text-tomato-600"
        >
          音声ファイルを開く
        </button>
      </header>

      {importing ? (
        <LocalMaterialImport
          onCreated={(material) => {
            upsertLocal(material);
            setImporting(false);
            navigate(`/practice/${material.id}`);
          }}
          onCancel={() => setImporting(false)}
        />
      ) : null}

      <p className="text-xs text-neutral-400">
        レベル・カテゴリでの絞り込みやVOA教材の取り込みはM2で実装予定です。
      </p>

      {materials.length === 0 ? (
        <p className="text-sm text-neutral-400">教材はまだありません。</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {materials.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => navigate(`/practice/${m.id}`)}
                className="flex w-full flex-col items-start gap-1 rounded-lg border border-neutral-200 p-3 text-left active:bg-neutral-50"
              >
                <span className="text-sm font-medium text-neutral-800">{m.title}</span>
                <span className="text-xs text-neutral-400">
                  {m.source === 'voa' ? 'VOA' : 'ローカル'} ・ {m.category}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

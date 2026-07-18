import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LocalMaterialImport } from '../features/materials/LocalMaterialImport';
import type { Material } from '../lib/db';
import { formatTime } from '../lib/audio';
import { useMaterialsStore } from '../stores/useMaterialsStore';

type LevelFilter = 'all' | 0 | 1 | 2 | 3;

const LEVEL_LABELS: Record<Exclude<LevelFilter, 'all'>, string> = {
  0: 'ローカル',
  1: 'レベル1',
  2: 'レベル2',
  3: 'レベル3',
};

const ALL_CATEGORIES = 'all';

export function MaterialsPage() {
  const { materials, loaded, refresh, upsertLocal } = useMaterialsStore();
  const [importing, setImporting] = useState(false);
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>(ALL_CATEGORIES);
  const navigate = useNavigate();

  useEffect(() => {
    if (!loaded) void refresh();
  }, [loaded, refresh]);

  const levelFilteredMaterials = useMemo(
    () => (levelFilter === 'all' ? materials : materials.filter((m) => m.level === levelFilter)),
    [materials, levelFilter],
  );

  const categories = useMemo(() => {
    const set = new Set(levelFilteredMaterials.map((m) => m.category));
    return [...set].sort();
  }, [levelFilteredMaterials]);

  // レベルを切り替えてカテゴリの選択肢が変わったら、選択中カテゴリが無効になっていないか調整する
  useEffect(() => {
    if (categoryFilter !== ALL_CATEGORIES && !categories.includes(categoryFilter)) {
      setCategoryFilter(ALL_CATEGORIES);
    }
  }, [categories, categoryFilter]);

  const visibleMaterials = useMemo(
    () =>
      categoryFilter === ALL_CATEGORIES
        ? levelFilteredMaterials
        : levelFilteredMaterials.filter((m) => m.category === categoryFilter),
    [levelFilteredMaterials, categoryFilter],
  );

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-neutral-800">教材</h1>
        <button
          type="button"
          onClick={() => setImporting((v) => !v)}
          className="rounded-full border border-tomato-300 px-3 py-1 text-xs font-medium text-tomato-600"
        >
          {importing ? '閉じる' : 'ローカル教材を追加'}
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

      <div className="flex flex-col gap-2">
        <div className="flex gap-1 overflow-x-auto">
          {(['all', 1, 2, 3, 0] as LevelFilter[]).map((lv) => (
            <button
              key={String(lv)}
              type="button"
              onClick={() => setLevelFilter(lv)}
              className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium ${
                levelFilter === lv
                  ? 'border-tomato-500 bg-tomato-500 text-white'
                  : 'border-neutral-300 text-neutral-600'
              }`}
            >
              {lv === 'all' ? 'すべて' : LEVEL_LABELS[lv]}
            </button>
          ))}
        </div>

        {categories.length > 1 ? (
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="rounded-md border border-neutral-300 px-2 py-1.5 text-xs text-neutral-600"
            aria-label="カテゴリで絞り込み"
          >
            <option value={ALL_CATEGORIES}>カテゴリ: すべて</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                カテゴリ: {c}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      {materials.length === 0 ? (
        <p className="text-sm text-neutral-400">教材はまだありません。</p>
      ) : visibleMaterials.length === 0 ? (
        <p className="text-sm text-neutral-400">条件に一致する教材がありません。</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {visibleMaterials.map((m) => (
            <MaterialListItem key={m.id} material={m} onSelect={() => navigate(`/practice/${m.id}`)} />
          ))}
        </ul>
      )}
    </div>
  );
}

function MaterialListItem({ material, onSelect }: { material: Material; onSelect: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className="flex w-full flex-col items-start gap-1 rounded-lg border border-neutral-200 p-3 text-left active:bg-neutral-50"
      >
        <span className="text-sm font-medium text-neutral-800">{material.title}</span>
        <span className="flex flex-wrap items-center gap-x-2 text-xs text-neutral-400">
          <span>{material.source === 'voa' ? 'VOA' : 'ローカル'}</span>
          <span>・</span>
          <span>{material.category}</span>
          {material.level > 0 ? (
            <>
              <span>・</span>
              <span>{LEVEL_LABELS[material.level as 1 | 2 | 3]}</span>
            </>
          ) : null}
          {material.durationSec ? (
            <>
              <span>・</span>
              <span>{formatTime(material.durationSec)}</span>
            </>
          ) : null}
        </span>
      </button>
    </li>
  );
}

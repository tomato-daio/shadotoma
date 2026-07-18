import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LocalMaterialImport } from '../features/materials/LocalMaterialImport';
import { getAllMaterialProgress, type Material, type MaterialProgress } from '../lib/db';
import { formatTime } from '../lib/audio';
import { articleHeadingTitle } from '../lib/articleTitle';
import { useMaterialsStore } from '../stores/useMaterialsStore';

type LevelFilter = 'all' | 0 | 1 | 2 | 3;

const LEVEL_LABELS: Record<Exclude<LevelFilter, 'all'>, string> = {
  0: 'ローカル',
  1: 'レベル1',
  2: 'レベル2',
  3: 'レベル3',
};

const ALL_CATEGORIES = 'all';

/** ライブラリ表示用のグループ単位。分割教材(articleId持ち・partCount>1)は記事単位でまとめる。 */
interface MaterialGroup {
  key: string;
  /** nullなら分割されていない単独教材（従来どおり1行表示）。 */
  articleTitle: string | null;
  sections: Material[];
}

function groupMaterials(materials: Material[]): MaterialGroup[] {
  const groups: MaterialGroup[] = [];
  const groupIndexByArticleId = new Map<string, number>();

  for (const m of materials) {
    const partCount = m.partCount ?? 1;
    if (m.articleId && partCount > 1) {
      const existingIndex = groupIndexByArticleId.get(m.articleId);
      if (existingIndex === undefined) {
        groupIndexByArticleId.set(m.articleId, groups.length);
        groups.push({ key: m.articleId, articleTitle: articleHeadingTitle(m.title), sections: [m] });
      } else {
        groups[existingIndex].sections.push(m);
      }
    } else {
      groups.push({ key: m.id, articleTitle: null, sections: [m] });
    }
  }

  for (const g of groups) {
    g.sections.sort((a, b) => (a.part ?? 0) - (b.part ?? 0));
  }

  return groups;
}

export function MaterialsPage() {
  const { materials, loaded, refresh, upsertLocal } = useMaterialsStore();
  const [importing, setImporting] = useState(false);
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>(ALL_CATEGORIES);
  const [progressByMaterial, setProgressByMaterial] = useState<Map<string, MaterialProgress>>(new Map());
  const navigate = useNavigate();

  useEffect(() => {
    if (!loaded) void refresh();
  }, [loaded, refresh]);

  // 進行中セクションの表示用（DESIGN.md §4のマルチセクション練習で「今どのセクションか」が
  // ライブラリからも分かるように）。教材一覧の読み込みに合わせてmaterialProgressも取得する。
  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    void getAllMaterialProgress().then((list) => {
      if (cancelled) return;
      setProgressByMaterial(new Map(list.map((p) => [p.materialId, p])));
    });
    return () => {
      cancelled = true;
    };
  }, [loaded, materials.length]);

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

  const groupedMaterials = useMemo(() => groupMaterials(visibleMaterials), [visibleMaterials]);

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
          {groupedMaterials.map((g) =>
            g.articleTitle !== null ? (
              <ArticleGroupItem
                key={g.key}
                articleTitle={g.articleTitle}
                sections={g.sections}
                progressByMaterial={progressByMaterial}
                onSelectSection={(id) => navigate(`/practice/${id}`)}
                onQuiz={(articleId) => navigate(`/quiz/${articleId}`)}
              />
            ) : (
              <MaterialListItem
                key={g.key}
                material={g.sections[0]}
                onSelect={() => navigate(`/practice/${g.sections[0].id}`)}
              />
            ),
          )}
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

/** セクション分割済み教材を「記事タイトルの見出し＋セクション一覧」でまとめて表示する（DESIGN.md §7b）。 */
function ArticleGroupItem({
  articleTitle,
  sections,
  progressByMaterial,
  onSelectSection,
  onQuiz,
}: {
  articleTitle: string;
  sections: Material[];
  progressByMaterial: Map<string, MaterialProgress>;
  onSelectSection: (materialId: string) => void;
  onQuiz: (articleId: string) => void;
}) {
  const first = sections[0];
  const partCount = first.partCount ?? sections.length;
  // DESIGN.md §8b: doneセクションが1つ以上で確認テストボタンを活性にする。
  const doneCount = sections.filter((s) => progressByMaterial.get(s.id)?.status === 'done').length;
  const articleId = first.articleId ?? first.id;

  return (
    <li className="rounded-lg border border-neutral-200 p-3">
      <div className="flex flex-col items-start gap-1">
        <span className="text-sm font-medium text-neutral-800">{articleTitle}</span>
        <span className="flex flex-wrap items-center gap-x-2 text-xs text-neutral-400">
          <span>VOA</span>
          <span>・</span>
          <span>{first.category}</span>
          {first.level > 0 ? (
            <>
              <span>・</span>
              <span>{LEVEL_LABELS[first.level as 1 | 2 | 3]}</span>
            </>
          ) : null}
          <span>・</span>
          <span>全{partCount}セクション</span>
        </span>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => onQuiz(articleId)}
          disabled={doneCount === 0}
          className={`rounded-full border px-3 py-1 text-xs font-medium ${
            doneCount === 0
              ? 'border-neutral-200 text-neutral-300'
              : 'border-tomato-300 text-tomato-600 active:bg-tomato-50'
          }`}
        >
          確認テスト
        </button>
        {doneCount === 0 ? (
          <span className="text-xs text-neutral-400">セクションを完了すると挑戦できます</span>
        ) : null}
      </div>

      <ul className="mt-2 flex flex-col gap-1">
        {sections.map((s) => {
          const status = progressByMaterial.get(s.id)?.status;
          const isActive = status === 'active';
          const isDone = status === 'done';
          return (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => onSelectSection(s.id)}
                className={`flex w-full items-center justify-between rounded-md border px-2 py-1.5 text-left text-xs active:bg-neutral-50 ${
                  isActive ? 'border-tomato-300 bg-tomato-50' : 'border-neutral-200'
                }`}
              >
                <span className="flex items-center gap-1 text-neutral-700">
                  <span>
                    セクション {s.part ?? '?'}/{partCount}
                  </span>
                  {isActive ? <span className="text-tomato-600">進行中</span> : null}
                  {isDone ? <span className="text-neutral-400">完了</span> : null}
                </span>
                {s.durationSec ? <span className="text-neutral-400">{formatTime(s.durationSec)}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </li>
  );
}

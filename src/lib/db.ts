import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

export type PracticeStep = 'listening' | 'script' | 'overlapping' | 'shadowing';

export interface Sentence {
  en: string;
  ja?: string;
}

// store: materials（教材メタ。音声本体は bundled=URL参照 / local=audioBlob保存）
export interface Material {
  id: string; // bundled: "voa-<記事ID>-p<part>" (例 voa-8002695-p1), local: "local-" + crypto.randomUUID()
  source: 'voa' | 'local';
  title: string;
  level: 1 | 2 | 3 | 0; // VOAレベル。0=不明(ローカル)
  category: string; // 例 "As It Is", "Local"
  audioUrl?: string; // bundled: base相対 "materials/audio/xxx.mp3"（セクションごとに独立したmp3）
  audioBlob?: Blob; // local のみ
  sentences: Sentence[]; // このセクションに割り当てられた文
  durationSec?: number;
  wordCount: number;
  addedAt: number; // epoch ms
  // ---- セクション分割（M4）----
  articleId?: string; // 元記事のグループキー（例 "voa-8002695"）。ライブラリで同一記事をまとめて表示
  part?: number; // 1始まりのセクション番号
  partCount?: number; // 記事内の総セクション数
}

// store: sessions（練習1回=1レコード。回数カウントの元データ）
export interface PracticeSession {
  id: string;
  materialId: string;
  date: string; // "YYYY-MM-DD"（learningDate基準）
  step: PracticeStep;
  loops: number; // このセッションで再生し切った回数
  startedAt: number;
}

export interface WordMark {
  word: string;
  si: number; // 文index
  status: 'ok' | 'missed' | 'sub';
}

// JudgeResult（M3で実装。型だけ先に定義）
export interface JudgeResult {
  matchRate: number; // 0-1
  wpm: number;
  wordMarks: WordMark[];
  goodPoints: string[]; // 3件
  devPoints: string[]; // 3件
  engine: 'whisper-local' | 'manual';
}

// store: submissions（提出=録音+添削結果）
export interface Submission {
  id: string;
  materialId: string;
  date: string; // sessionsと同じ日付規則
  audioBlob: Blob;
  mimeType: string;
  transcript?: string; // Whisper文字起こし（M3）
  judge?: JudgeResult; // 添削結果（M3）
  createdAt: number;
}

// store: materialProgress（教材ごとの通算状況）
export interface MaterialProgress {
  materialId: string; // keyPath
  daysPracticed: string[]; // 練習した日付の配列（"何日目"= length）
  totalLoops: number;
  lastStep: PracticeStep;
  status: 'not-started' | 'active' | 'done';
}

export type AppStateValue = string | number | boolean | null;

interface AppStateRecord {
  key: string;
  value: AppStateValue;
}

interface ShadotomaDBSchema extends DBSchema {
  materials: {
    key: string;
    value: Material;
    indexes: { 'by-source': string };
  };
  sessions: {
    key: string;
    value: PracticeSession;
    indexes: { 'by-material': string; 'by-date': string };
  };
  submissions: {
    key: string;
    value: Submission;
    indexes: { 'by-material': string; 'by-date': string };
  };
  materialProgress: {
    key: string;
    value: MaterialProgress;
  };
  appState: {
    key: string;
    value: AppStateRecord;
  };
}

const DB_NAME = 'shadotoma';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<ShadotomaDBSchema>> | null = null;

export function getDB(): Promise<IDBPDatabase<ShadotomaDBSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<ShadotomaDBSchema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('materials')) {
          const store = db.createObjectStore('materials', { keyPath: 'id' });
          store.createIndex('by-source', 'source');
        }
        if (!db.objectStoreNames.contains('sessions')) {
          const store = db.createObjectStore('sessions', { keyPath: 'id' });
          store.createIndex('by-material', 'materialId');
          store.createIndex('by-date', 'date');
        }
        if (!db.objectStoreNames.contains('submissions')) {
          const store = db.createObjectStore('submissions', { keyPath: 'id' });
          store.createIndex('by-material', 'materialId');
          store.createIndex('by-date', 'date');
        }
        if (!db.objectStoreNames.contains('materialProgress')) {
          db.createObjectStore('materialProgress', { keyPath: 'materialId' });
        }
        if (!db.objectStoreNames.contains('appState')) {
          db.createObjectStore('appState', { keyPath: 'key' });
        }
      },
    });
  }
  return dbPromise;
}

/** テスト用: 開いているDB接続を閉じてキャッシュをリセットする。 */
export async function resetDBForTest(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise;
    db.close();
  }
  dbPromise = null;
}

export function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

// ---- materials ----

export async function putMaterial(material: Material): Promise<void> {
  const db = await getDB();
  await db.put('materials', material);
}

export async function getMaterial(id: string): Promise<Material | undefined> {
  const db = await getDB();
  return db.get('materials', id);
}

export async function getAllMaterials(): Promise<Material[]> {
  const db = await getDB();
  return db.getAll('materials');
}

export async function deleteMaterial(id: string): Promise<void> {
  const db = await getDB();
  await db.delete('materials', id);
}

// ---- sessions ----

export async function addSession(session: PracticeSession): Promise<void> {
  const db = await getDB();
  await db.put('sessions', session);
}

export async function getSessionsByMaterial(materialId: string): Promise<PracticeSession[]> {
  const db = await getDB();
  return db.getAllFromIndex('sessions', 'by-material', materialId);
}

// ---- submissions ----

export async function addSubmission(submission: Submission): Promise<void> {
  const db = await getDB();
  await db.put('submissions', submission);
}

export async function getSubmissionsByMaterial(materialId: string): Promise<Submission[]> {
  const db = await getDB();
  const list = await db.getAllFromIndex('submissions', 'by-material', materialId);
  return list.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getAllSubmissions(): Promise<Submission[]> {
  const db = await getDB();
  const list = await db.getAll('submissions');
  return list.sort((a, b) => b.createdAt - a.createdAt);
}

// ---- materialProgress ----

export async function getMaterialProgress(materialId: string): Promise<MaterialProgress | undefined> {
  const db = await getDB();
  return db.get('materialProgress', materialId);
}

export async function putMaterialProgress(progress: MaterialProgress): Promise<void> {
  const db = await getDB();
  await db.put('materialProgress', progress);
}

export async function getAllMaterialProgress(): Promise<MaterialProgress[]> {
  const db = await getDB();
  return db.getAll('materialProgress');
}

/**
 * 練習セッション実施時にmaterialProgressを更新する（無ければ新規作成）。
 * daysPracticedはユニークな日付のみ保持し、loopsは加算する。
 *
 * get→putを単一のreadwriteトランザクション内で行うことで、同一materialIdに対する
 * 呼び出しが同時に走ってもロストアップデート（片方の加算が消える）を起こさないようにする。
 * IndexedDBは同一storeに対するreadwriteトランザクションを直列化するため、これでアトミックになる。
 */
export async function touchMaterialProgress(
  materialId: string,
  date: string,
  step: PracticeStep,
  loopsDelta = 0,
): Promise<MaterialProgress> {
  const db = await getDB();
  const tx = db.transaction('materialProgress', 'readwrite');
  const existing = await tx.store.get(materialId);
  const daysPracticed = existing ? [...existing.daysPracticed] : [];
  if (!daysPracticed.includes(date)) {
    daysPracticed.push(date);
  }
  const next: MaterialProgress = {
    materialId,
    daysPracticed,
    totalLoops: (existing?.totalLoops ?? 0) + loopsDelta,
    lastStep: step,
    status: daysPracticed.length > 0 ? 'active' : 'not-started',
  };
  await tx.store.put(next);
  await tx.done;
  return next;
}

/**
 * ストリーク計算用に、sessions/submissions両方から学習日(date)の集合を取得する。
 * DESIGN.md §3: 「streak計算はsubmissions/sessionsから導出」。
 */
export async function getAllPracticedDates(): Promise<string[]> {
  const db = await getDB();
  const [sessions, submissions] = await Promise.all([db.getAll('sessions'), db.getAll('submissions')]);
  const dates = new Set<string>();
  for (const s of sessions) dates.add(s.date);
  for (const s of submissions) dates.add(s.date);
  return [...dates];
}

// ---- appState ----

export async function getAppState<T extends AppStateValue = AppStateValue>(
  key: string,
): Promise<T | undefined> {
  const db = await getDB();
  const record = await db.get('appState', key);
  return record?.value as T | undefined;
}

export async function setAppState(key: string, value: AppStateValue): Promise<void> {
  const db = await getDB();
  await db.put('appState', { key, value });
}

// ---- bundled材料の同期 ----

function isValidBundledMaterial(item: unknown): item is Material {
  if (!item || typeof item !== 'object') return false;
  const m = item as Record<string, unknown>;
  return (
    typeof m.id === 'string' &&
    typeof m.title === 'string' &&
    m.source === 'voa' &&
    Array.isArray(m.sentences)
  );
}

/**
 * アプリ起動時に `materials/index.json`（VOAバンドル教材のメタ情報。fetch-voa.mjsが生成）を
 * 取得し、IndexedDBのbundled教材(source: 'voa')を同期する。
 *
 * DESIGN.md §7末尾: 追加・更新に加え、**indexから消えたbundled教材はIndexedDBからも削除**する
 * （§7bでセクション分割に伴い記事の再分割・差し替えが起こるため）。既存のローカル取り込み教材
 * (source: 'local')には一切触れない。削除されたbundled教材のmaterialProgress/submissionsは
 * 履歴として残す（明示的には削除しない）。オフライン等でfetchに失敗しても例外を投げず、既存DB
 * のまま動作を継続する。
 *
 * @param baseUrl `import.meta.env.BASE_URL` を渡す（末尾スラッシュ付き想定）。
 */
export async function syncBundledMaterials(baseUrl: string): Promise<void> {
  try {
    const res = await fetch(`${baseUrl}materials/index.json`);
    if (!res.ok) return;
    const data: unknown = await res.json();
    if (!Array.isArray(data)) return;

    const validItems = data.filter(isValidBundledMaterial);
    const indexIds = new Set(validItems.map((item) => item.id));

    const db = await getDB();
    const tx = db.transaction('materials', 'readwrite');
    const existingBundled = await tx.store.index('by-source').getAllKeys('voa');
    for (const item of validItems) {
      await tx.store.put(item);
    }
    for (const key of existingBundled) {
      if (!indexIds.has(key as string)) {
        await tx.store.delete(key);
      }
    }
    await tx.done;
  } catch {
    // オフライン・fetch失敗時は何もせず既存DBのまま継続する。
  }
}

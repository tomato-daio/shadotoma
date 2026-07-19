import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { PhenomenonIssue, PreviousIssueOutcome } from './phenomena';

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
  // status==='sub'のときに実際に認識された語（M7でalign.tsが設定済み。M8で判定結果画面の
  // 「(→ 聞こえた語)」表示に使う。既存データに無くてもoptionalのため後方互換）。
  recognized?: string;
}

// JudgeResult（M3で実装。型だけ先に定義）
export interface JudgeResult {
  matchRate: number; // 0-1
  wpm: number;
  wordMarks: WordMark[];
  goodPoints: string[]; // 3件
  devPoints: string[]; // 3件
  engine: 'whisper-local' | 'manual';
  // ---- 音声現象ベースの指摘と前回比較（M7・DESIGN.md §8 5b）----
  // 既存データ（issuesを持たないJudgeResult）はoptionalのため後方互換。
  issues?: PhenomenonIssue[]; // Development Pointの根拠にした音声現象（優先度順・最大3件）
  previousIssueOutcomes?: PreviousIssueOutcome[]; // 前回提出issuesの改善判定（前回提出が無い/issues無しなら未設定）
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

// store: quizResults（確認テスト＝穴埋めテストの結果。DESIGN.md §8b M5）
export interface QuizResult {
  id: string;
  articleId: string; // 出題対象の記事グループキー（Material.articleId）
  date: string; // 実施した学習日（learningDate基準、"YYYY-MM-DD"）
  sectionIds: string[]; // 出題対象にしたセクション（Material.id）の一覧
  total: number;
  correct: number;
  createdAt: number; // epoch ms
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
  quizResults: {
    key: string;
    value: QuizResult;
    indexes: { 'by-article': string };
  };
}

const DB_NAME = 'shadotoma';
// v1→v2（M5）: quizResults ストアを追加（DESIGN.md §8b）。既存ストアはif存在チェックで
// 触らないため、v1で作成済みのユーザーデータもそのまま残る。
// v2→v3: 「バージョンだけ2に上がりquizResults未作成」の壊れたDB（更新途中のタブ多重等で発生しうる）を
// 自己修復するための再実行。upgradeは全ストア冪等なので何度走っても安全。
const DB_VERSION = 3;

let dbPromise: Promise<IDBPDatabase<ShadotomaDBSchema>> | null = null;

export function getDB(): Promise<IDBPDatabase<ShadotomaDBSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<ShadotomaDBSchema>(DB_NAME, DB_VERSION, {
      // 新しいバージョンのタブがアップグレードを待っているとき、この接続を手放して
      // 全タブが永久に固まるのを防ぐ（この接続の次回利用時は再オープンされる）。
      blocking(_currentVersion, _blockedVersion, _event) {
        void dbPromise?.then((db) => db.close());
        dbPromise = null;
      },
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
        if (!db.objectStoreNames.contains('quizResults')) {
          const store = db.createObjectStore('quizResults', { keyPath: 'id' });
          store.createIndex('by-article', 'articleId');
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

/**
 * 同一記事（Material.articleId）に属するセクション一覧をpart順で取得する（DESIGN.md §8b: 確認テストの出題対象探索用）。
 * 教材数は個人利用規模のため、getAllMaterialsしてメモリ上でフィルタする。
 */
export async function getMaterialsByArticleId(articleId: string): Promise<Material[]> {
  const all = await getAllMaterials();
  return all.filter((m) => m.articleId === articleId).sort((a, b) => (a.part ?? 0) - (b.part ?? 0));
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
    // 既にdone（DESIGN.md §8b）になっている教材は、その後も継続練習した場合にactiveへ
    // 巻き戻さない（doneセクションは確認テストの出題対象になるため、状態を保つ）。
    status: existing?.status === 'done' ? 'done' : daysPracticed.length > 0 ? 'active' : 'not-started',
  };
  await tx.store.put(next);
  await tx.done;
  return next;
}

/**
 * MaterialProgress.status を 'done' に確定する（DESIGN.md §8b前提: 提出のjudge.matchRate≥0.85、
 * または4日目の練習完了時）。
 *
 * 呼び出し時点でレコードが無い場合（例: ステップを飛ばして直接提出した場合）も、
 * `date` を daysPracticed に含めた新規レコードを作って done にする（安全側に倒す）。
 * 既に done なら何もせずそのまま返す（冪等）。
 */
export async function markMaterialProgressDone(materialId: string, date: string): Promise<MaterialProgress> {
  const db = await getDB();
  const tx = db.transaction('materialProgress', 'readwrite');
  const existing = await tx.store.get(materialId);
  if (existing?.status === 'done') {
    await tx.done;
    return existing;
  }
  const daysPracticed = existing ? [...existing.daysPracticed] : [];
  if (!daysPracticed.includes(date)) {
    daysPracticed.push(date);
  }
  const next: MaterialProgress = {
    materialId,
    daysPracticed,
    totalLoops: existing?.totalLoops ?? 0,
    lastStep: existing?.lastStep ?? 'shadowing',
    status: 'done',
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

// ---- quizResults（DESIGN.md §8b M5） ----

export async function addQuizResult(result: QuizResult): Promise<void> {
  const db = await getDB();
  await db.put('quizResults', result);
}

/** 指定記事の確認テスト結果を新しい順で取得する。 */
export async function getQuizResultsByArticle(articleId: string): Promise<QuizResult[]> {
  const db = await getDB();
  const list = await db.getAllFromIndex('quizResults', 'by-article', articleId);
  return list.sort((a, b) => b.createdAt - a.createdAt);
}

/** 進捗ページの「最近のテスト結果」表示用に、全記事横断で新しい順に最大limit件取得する。 */
export async function getRecentQuizResults(limit = 5): Promise<QuizResult[]> {
  const db = await getDB();
  const list = await db.getAll('quizResults');
  return list.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
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

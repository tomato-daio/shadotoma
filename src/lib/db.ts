import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { PhenomenonIssue, PreviousIssueOutcome } from './phenomena';
import type { ReferenceComparison, SpeechProfile } from './referenceComparison';
import { mergeSentenceAnnotations } from './scriptAnnotations';

export type PracticeStep = 'listening' | 'script' | 'overlapping' | 'shadowing';

/** 重要語彙1件（scriptAnnotations.tsのクリップボード往復取り込みで付与する）。 */
export interface VocabItem {
  term: string; // 単語・熟語（スクリプト中の表記のまま）
  ja: string; // 簡潔な意味
}

export interface Sentence {
  en: string;
  ja?: string;
  /** この文の重要語彙（0〜数個）。未付与・旧データはundefined（後方互換）。 */
  vocab?: VocabItem[];
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
  // ---- 音素情報（M13・DESIGN.md §8d）----
  /**
   * このセクションの語をCMUdictで音素列化し、対象15音素（phonemeAdvice.tsと同じARPAbet大文字キー
   * 体系。例: 'R','TH','AE'）ごとの出現数を数えたもの（scripts/annotate-phonemes.mjsが付与）。
   * bundled教材のみ・fetch-voa完了時に自動生成。ローカル取り込み教材や旧データにはoptional（undefined）。
   * recommend.ts の「苦手音素×phonemeCounts密度」スコアリングに使う。
   */
  phonemeCounts?: Record<string, number>;
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
  // 対応した認識語のindex（ok/sub時のみ。M15でalign.tsが設定。旧データはundefined）。
  ri?: number;
}

// ---- Azure発音評価（M9・任意機能・DESIGN.md §8c）----

/** 発音評価における単語1つぶんのスコア（Azure Speechの応答をそのまま反映）。 */
export interface AzureWordScore {
  word: string;
  accuracyScore: number; // 0-100
  /** Azureが返すエラー種別をそのまま保持する（例: 'None' | 'Omission' | 'Insertion' | 'Mispronunciation' 等）。 */
  errorType?: string;
}

// ---- Azureコメント用の拡張データ（M12・DESIGN.md §8c）----

/**
 * 低スコア音素1件ぶん（Words[].Phonemesを集計したもの）。
 * phonemeはARPAbet大文字キー（例: 'R','TH','AE'。azurePronunciation.tsのnormalizePhonemeKeyで正規化
 * 済み。SDKのphonemeAlphabetは既定のSAPIのままにしているため、en-USでは元々ARPAbet相当の大文字表記
 * で返ってくる）。phonemeAdvice.tsの辞書キーと同じ体系だが、辞書に無いキーが入ることもある
 * （その場合はコメント側で「コツ文なし」にフォールバックする）。
 */
export interface AzureWeakPhoneme {
  phoneme: string;
  avgScore: number; // この提出内での平均AccuracyScore
  examples: string[]; // スコアが低かった該当語（重複除去・最大2件）
}

/** 韻律のFeedback集計（Words[].PronunciationAssessment.Feedback.Prosodyを集計したもの）。 */
export interface AzureProsodyFeedback {
  unexpectedBreaks: number; // ErrorTypesに'UnexpectedBreak'を含む語の数
  missingBreaks: number; // ErrorTypesに'MissingBreak'を含む語の数
  monotone: boolean; // いずれかの語のIntonation.ErrorTypesに'Monotone'を含むか
}

/** Azure発音評価の統合結果（複数フレーズ結果を音声長加重で統合済み）。 */
export interface AzurePronunciationResult {
  pronScore: number; // 総合 0-100
  accuracyScore: number; // 正確さ 0-100
  fluencyScore: number; // 流暢さ 0-100
  /**
   * 韻律 0-100。リージョンにより韻律採点が未対応の場合があり（DESIGN.md §8c M10）、
   * 韻律ありでの実行が失敗し韻律なしで自動リトライして成功した場合はundefined
   * （既存データ・韻律対応リージョンでは常に数値が入るため後方互換）。
   */
  prosodyScore?: number;
  completenessScore: number; // 完全性 0-100
  words: AzureWordScore[];
  /**
   * 低スコア音素トップ3（M12・DESIGN.md §8c）。音素ごとの平均スコア昇順。
   * Phoneme granularityのデータが取れなかった場合や後方互換のため既存データではundefined。
   */
  weakPhonemes?: AzureWeakPhoneme[];
  /**
   * 韻律Feedbackの集計（M12）。韻律なし設定で成功した場合（M10フォールバック）はprosodyScore同様
   * undefinedにする（データが取れていないのを「問題なし」と誤解させないため）。既存データも
   * undefined（後方互換）。
   */
  prosodyFeedback?: AzureProsodyFeedback;
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
  // ---- Azure発音評価（M9・DESIGN.md §8c。完全に付加的な任意機能）----
  // キー未設定時・失敗時はどちらもundefinedのまま。既存データ・Whisper採点には一切影響しない。
  azure?: AzurePronunciationResult;
  /** azure採点が失敗した場合の一行エラーメッセージ（表示用。成功時・未実行時はundefined）。 */
  azureError?: string;
  /**
   * お手本音声との比較（M15・DESIGN.md §8f）。お手本解析が未実行・失敗の場合と
   * 旧データではundefined（後方互換。表示側は比較セクションを出さない）。
   */
  referenceComparison?: ReferenceComparison;
}

// store: referenceAnalysis（お手本音声の解析キャッシュ。M15・DESIGN.md §8f）
// 教材×Whisperモデルごとに1回だけ解析し、以降の提出で再利用する。音声Blobは持たない（数KB/教材）。
// bundled教材がindexから消えたときはsyncBundledMaterialsが一緒に削除する（純キャッシュのため）。
export interface ReferenceAnalysisRecord {
  materialId: string; // keyPath
  /**
   * 解析に使ったWhisperモデルキー（'high'|'fast'）。選択モデルと不一致なら再解析する。
   * WhisperModelKey型はfeatures側にあり循環importになるためstringで持つ。
   */
  modelKey: string;
  analyzedAt: number; // epoch ms
  /** 解析したお手本PCMの長さ(秒)。タイムスタンプ品質ゲートの入力に使う。 */
  pcmDurationSec: number;
  /** DSPプロファイル（速度・間・抑揚。①）。無音等で作れなければnull。 */
  profile: SpeechProfile | null;
  /** お手本のWhisper transcript。 */
  transcript?: string;
  /** 品質ゲート（validateTimedWords）通過済みの単語タイムスタンプ（②）。縮退時はundefined。 */
  words?: { word: string; startSec: number; endSec: number }[];
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
  /**
   * 不正解だった空欄の正答語（スクリプト上の元の表記。M13・DESIGN.md §8d）。
   * weakness.ts の「苦手単語（missed/sub/Azure低スコア語/クイズ誤答が2回以上重なった語）」の
   * 集計対象に使う。新storeは追加せずquizResultsへ追記する形にしたため、旧データにはoptional。
   */
  wrongWords?: string[];
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
  referenceAnalysis: {
    key: string;
    value: ReferenceAnalysisRecord;
  };
}

const DB_NAME = 'shadotoma';
// v1→v2（M5）: quizResults ストアを追加（DESIGN.md §8b）。既存ストアはif存在チェックで
// 触らないため、v1で作成済みのユーザーデータもそのまま残る。
// v2→v3: 「バージョンだけ2に上がりquizResults未作成」の壊れたDB（更新途中のタブ多重等で発生しうる）を
// 自己修復するための再実行。upgradeは全ストア冪等なので何度走っても安全。
// v3→v4（M15）: referenceAnalysis ストア（お手本音声の解析キャッシュ）を追加（DESIGN.md §8f）。
const DB_VERSION = 4;

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
        if (!db.objectStoreNames.contains('referenceAnalysis')) {
          db.createObjectStore('referenceAnalysis', { keyPath: 'materialId' });
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

// ---- referenceAnalysis（お手本解析キャッシュ。M15）----

export async function getReferenceAnalysis(materialId: string): Promise<ReferenceAnalysisRecord | undefined> {
  const db = await getDB();
  return db.get('referenceAnalysis', materialId);
}

export async function putReferenceAnalysis(record: ReferenceAnalysisRecord): Promise<void> {
  const db = await getDB();
  await db.put('referenceAnalysis', record);
}

export async function deleteReferenceAnalysis(materialId: string): Promise<void> {
  const db = await getDB();
  await db.delete('referenceAnalysis', materialId);
}

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
  const list = await getAllQuizResults();
  return list.slice(0, limit);
}

/**
 * 全記事横断の確認テスト結果を新しい順で取得する（M13・DESIGN.md §8d）。
 * weakness.ts の buildWeaknessProfile は苦手単語集計に全件（直近だけでなく）を使うため、
 * getRecentQuizResultsとは別に上限なしの取得口を用意する。
 */
export async function getAllQuizResults(): Promise<QuizResult[]> {
  const db = await getDB();
  const list = await db.getAll('quizResults');
  return list.sort((a, b) => b.createdAt - a.createdAt);
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
    const tx = db.transaction(['materials', 'referenceAnalysis'], 'readwrite');
    const materialsStore = tx.objectStore('materials');
    const referenceStore = tx.objectStore('referenceAnalysis');
    const existingBundled = await materialsStore.index('by-source').getAllKeys('voa');
    for (const item of validItems) {
      // 既存レコードへ後付けした訳・語彙(ja/vocab)を、indexからの丸ごと上書きで消さないよう引き継ぐ
      // （scriptAnnotations.tsのクリップボード往復取り込みで付与されたデータの保護）。
      const existing = await materialsStore.get(item.id);
      const merged = existing
        ? { ...item, sentences: mergeSentenceAnnotations(existing.sentences, item.sentences) }
        : item;
      await materialsStore.put(merged);
    }
    for (const key of existingBundled) {
      if (!indexIds.has(key as string)) {
        await materialsStore.delete(key);
        // お手本解析キャッシュも一緒に削除する（M15: 記事の再分割で音声が差し替わったときに
        // 陳腐化したタイミング・プロファイルを残さないため。submissionsは履歴として残す方針と異なり、
        // これは再生成可能な純キャッシュなので消してよい）。
        await referenceStore.delete(key as string);
      }
    }
    await tx.done;
  } catch {
    // オフライン・fetch失敗時は何もせず既存DBのまま継続する。
  }
}

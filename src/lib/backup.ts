/**
 * 全IndexedDBデータのエクスポート/インポート（DESIGN.md §10 M3・設定ページ）。
 *
 * 音声Blob（Material.audioBlob / Submission.audioBlob）はJSONにできないため、base64文字列へ
 * 変換して1つのJSONファイルに含める。エクスポート/インポートいずれも端末内で完結し、
 * 外部へは一切送信しない。
 */

import { getDB, type AppStateValue, type Material, type MaterialProgress, type PracticeSession, type QuizResult, type Submission } from './db';

// v2: quizResults を追加（v1のバックアップも読み込み可能: quizResults不在なら空として復元）
const BACKUP_VERSION = 2;
const BACKUP_APP_ID = 'shadotoma';

interface BlobField {
  base64: string;
  mimeType: string;
}

interface ExportedMaterial extends Omit<Material, 'audioBlob'> {
  audioBlob?: BlobField;
}

interface ExportedSubmission extends Omit<Submission, 'audioBlob'> {
  audioBlob: BlobField;
}

interface AppStateEntry {
  key: string;
  value: AppStateValue;
}

export interface BackupBundle {
  app: typeof BACKUP_APP_ID;
  version: number;
  exportedAt: number;
  materials: ExportedMaterial[];
  sessions: PracticeSession[];
  submissions: ExportedSubmission[];
  materialProgress: MaterialProgress[];
  appState: AppStateEntry[];
  quizResults?: QuizResult[];
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Blobの読み込みに失敗しました'));
        return;
      }
      const commaIdx = result.indexOf(',');
      resolve(commaIdx === -1 ? result : result.slice(commaIdx + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Blobの読み込みに失敗しました'));
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

async function exportMaterial(m: Material): Promise<ExportedMaterial> {
  const { audioBlob, ...rest } = m;
  if (!audioBlob) return rest;
  const base64 = await blobToBase64(audioBlob);
  return { ...rest, audioBlob: { base64, mimeType: audioBlob.type || 'application/octet-stream' } };
}

async function exportSubmission(s: Submission): Promise<ExportedSubmission> {
  const { audioBlob, ...rest } = s;
  const base64 = await blobToBase64(audioBlob);
  return { ...rest, audioBlob: { base64, mimeType: s.mimeType || audioBlob.type || 'application/octet-stream' } };
}

/** 全データをエクスポート用のJSON Blobにまとめる。 */
export async function exportAllData(): Promise<Blob> {
  const db = await getDB();
  const [materials, sessions, submissions, materialProgress, appState, quizResults] = await Promise.all([
    db.getAll('materials'),
    db.getAll('sessions'),
    db.getAll('submissions'),
    db.getAll('materialProgress'),
    db.getAll('appState'),
    db.getAll('quizResults'),
  ]);

  const [exportedMaterials, exportedSubmissions] = await Promise.all([
    Promise.all(materials.map(exportMaterial)),
    Promise.all(submissions.map(exportSubmission)),
  ]);

  const bundle: BackupBundle = {
    app: BACKUP_APP_ID,
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    materials: exportedMaterials,
    sessions,
    submissions: exportedSubmissions,
    materialProgress,
    appState,
    quizResults,
  };

  return new Blob([JSON.stringify(bundle)], { type: 'application/json' });
}

/** エクスポートファイルのファイル名（例: shadotoma-backup-20260718.json）を組み立てる。 */
export function buildBackupFileName(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `shadotoma-backup-${y}${m}${d}.json`;
}

function isBackupBundle(data: unknown): data is BackupBundle {
  if (!data || typeof data !== 'object') return false;
  const b = data as Record<string, unknown>;
  return (
    b.app === BACKUP_APP_ID &&
    typeof b.version === 'number' &&
    Array.isArray(b.materials) &&
    Array.isArray(b.submissions) &&
    Array.isArray(b.sessions) &&
    Array.isArray(b.materialProgress) &&
    Array.isArray(b.appState) &&
    (b.quizResults === undefined || Array.isArray(b.quizResults))
  );
}

function importMaterial(m: ExportedMaterial): Material {
  const { audioBlob, ...rest } = m;
  if (!audioBlob) return rest;
  return { ...rest, audioBlob: base64ToBlob(audioBlob.base64, audioBlob.mimeType) };
}

function importSubmission(s: ExportedSubmission): Submission {
  const { audioBlob, ...rest } = s;
  return { ...rest, audioBlob: base64ToBlob(audioBlob.base64, audioBlob.mimeType) };
}

/**
 * バックアップJSONから全データを復元する。既存の全ストアをクリアしてから書き込む
 * （「復元は上書き確認あり」— この関数を呼ぶ前にUI側で確認ダイアログを出すこと）。
 */
export async function importAllData(file: Blob): Promise<void> {
  const text = await file.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('JSONとして読み込めませんでした');
  }
  if (!isBackupBundle(data)) {
    throw new Error('シャドとまのバックアップファイルではないようです');
  }

  const materials = data.materials.map(importMaterial);
  const submissions = data.submissions.map(importSubmission);

  const db = await getDB();
  const storeNames = ['materials', 'sessions', 'submissions', 'materialProgress', 'appState', 'quizResults'] as const;
  const tx = db.transaction(storeNames, 'readwrite');
  await Promise.all(storeNames.map((name) => tx.objectStore(name).clear()));
  await Promise.all([
    ...materials.map((m) => tx.objectStore('materials').put(m)),
    ...data.sessions.map((s) => tx.objectStore('sessions').put(s)),
    ...submissions.map((s) => tx.objectStore('submissions').put(s)),
    ...data.materialProgress.map((p) => tx.objectStore('materialProgress').put(p)),
    ...data.appState.map((a) => tx.objectStore('appState').put(a)),
    ...(data.quizResults ?? []).map((q) => tx.objectStore('quizResults').put(q)),
  ]);
  await tx.done;
}

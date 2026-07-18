import { useState, type FormEvent } from 'react';
import { countWords, loadAudioDuration } from '../../lib/audio';
import { newId, putMaterial, type Material, type Sentence } from '../../lib/db';

export interface LocalMaterialImportProps {
  onCreated: (material: Material) => void;
  onCancel: () => void;
}

/**
 * 簡易的な文分割。正式な実装は M2 の `src/lib/sentences.ts`（略語考慮・Vitestテスト付き）で行う。
 * ここでは開発確認用の一時教材作成のためだけに使う。
 */
function naiveSplitSentences(raw: string): Sentence[] {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length > 1) {
    return lines.map((en) => ({ en }));
  }

  const bySentence = raw
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  return bySentence.length > 0 ? bySentence.map((en) => ({ en })) : [{ en: raw.trim() }];
}

export function LocalMaterialImport({ onCreated, onCancel }: LocalMaterialImportProps) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [script, setScript] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFileChange = (f: File | null) => {
    setFile(f);
    if (f && !title) {
      setTitle(f.name.replace(/\.[^/.]+$/, ''));
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) {
      setError('音声ファイルを選んでください');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const durationSec = await loadAudioDuration(file).catch(() => undefined);
      const sentences = naiveSplitSentences(script);
      const material: Material = {
        id: newId('local'),
        source: 'local',
        title: title.trim() || 'ローカル教材',
        level: 0,
        category: 'Local',
        audioBlob: file,
        sentences,
        durationSec,
        wordCount: countWords(script || sentences.map((s) => s.en).join(' ')),
        addedAt: Date.now(),
      };
      await putMaterial(material);
      onCreated(material);
    } catch (err) {
      setError(err instanceof Error ? err.message : '教材の作成に失敗しました');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="flex flex-col gap-3 rounded-lg border border-tomato-200 bg-tomato-50/40 p-4"
    >
      <p className="text-sm font-medium text-tomato-700">音声ファイルを開く（開発確認用の一時教材）</p>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-neutral-600">音声ファイル</span>
        <input
          type="file"
          accept="audio/*"
          onChange={(e) => handleFileChange(e.target.files?.[0] ?? null)}
          className="text-sm"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-neutral-600">タイトル</span>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="教材のタイトル"
          className="rounded-md border border-neutral-300 px-3 py-2"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-neutral-600">スクリプト貼り付け（英語。1行1文推奨）</span>
        <textarea
          value={script}
          onChange={(e) => setScript(e.target.value)}
          rows={5}
          placeholder="This is a sample sentence."
          className="rounded-md border border-neutral-300 px-3 py-2 text-sm"
        />
      </label>

      {error ? <p className="text-xs text-red-600">{error}</p> : null}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-600"
        >
          キャンセル
        </button>
        <button
          type="submit"
          disabled={busy}
          className="flex-1 rounded-md bg-tomato-500 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? '作成中…' : '開く'}
        </button>
      </div>
    </form>
  );
}

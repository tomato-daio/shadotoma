import { useState, type FormEvent } from 'react';
import { countWords, loadAudioDuration } from '../../lib/audio';
import { newId, putMaterial, type Material } from '../../lib/db';
import { sentencesFromText } from '../../lib/sentences';

export interface LocalMaterialImportProps {
  onCreated: (material: Material) => void;
  onCancel: () => void;
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
      const sentences = sentencesFromText(script);
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
      <p className="text-sm font-medium text-tomato-700">ローカル教材を追加</p>
      <p className="text-xs text-neutral-500">
        音声ファイルとスクリプトはこの端末のIndexedDBにのみ保存され、外部へは送信されません。
      </p>

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
          {busy ? '追加中…' : '追加する'}
        </button>
      </div>
    </form>
  );
}

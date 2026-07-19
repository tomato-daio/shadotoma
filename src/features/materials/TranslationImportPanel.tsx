import { useState } from 'react';
import { putMaterial, type Material } from '../../lib/db';
import { applyAnnotations, buildTranslationPrompt, parseTranslationResponse } from '../../lib/scriptAnnotations';
import { copyTextToClipboard } from '../judge/clipboardFallback';

export interface TranslationImportPanelProps {
  material: Material;
  /** 訳・語彙を保存した後の最新Materialを親へ通知する（画面へ即反映するため）。 */
  onUpdated: (material: Material) => void;
}

/**
 * 日本語訳・重要語彙のクリップボード往復取り込みパネル（練習画面下部の折りたたみセクション）。
 * 依頼文をコピー → ChatGPT/Claude等に貼り付け → 返ってきたJSONを貼り戻して保存する。
 * 外部へは一切送信しない（clipboardFallback.tsと同じ方式）。
 */
export function TranslationImportPanel({ material, onUpdated }: TranslationImportPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [response, setResponse] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const annotatedCount = material.sentences.filter((s) => s.ja || (s.vocab && s.vocab.length > 0)).length;
  const totalCount = material.sentences.length;

  const handleCopy = async () => {
    setError(null);
    setSaved(false);
    const prompt = buildTranslationPrompt({ title: material.title, sentences: material.sentences });
    const ok = await copyTextToClipboard(prompt);
    setCopied(ok);
    if (!ok) setError('クリップボードへのコピーに失敗しました。もう一度お試しください。');
  };

  const handleImport = async () => {
    setError(null);
    setSaved(false);
    const result = parseTranslationResponse(response, totalCount);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setBusy(true);
    try {
      const updated: Material = { ...material, sentences: applyAnnotations(material.sentences, result.annotations) };
      await putMaterial(updated);
      onUpdated(updated);
      setSaved(true);
      setResponse('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存に失敗しました');
    } finally {
      setBusy(false);
    }
  };

  if (totalCount === 0) return null;

  return (
    <section className="rounded-lg border border-neutral-200 bg-neutral-50/60">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-2 p-3 text-left"
      >
        <span className="text-sm font-semibold text-neutral-700">
          日本語訳・重要語彙
          <span className="ml-2 text-xs font-normal text-neutral-400">
            {annotatedCount > 0 ? `付与済み ${annotatedCount}/${totalCount}文` : '未付与'}
          </span>
        </span>
        <span className="text-xs text-neutral-400">{expanded ? '▲ 閉じる' : '▼ 表示'}</span>
      </button>

      {expanded ? (
        <div className="flex flex-col gap-3 border-t border-neutral-100 p-3">
          <p className="text-xs text-neutral-500">
            ①依頼文をコピー → ②ChatGPTやClaudeのアプリに貼り付け → ③返ってきたJSONを下の欄に貼って取り込みます。
            外部への自動送信はありません。
          </p>

          <button
            type="button"
            onClick={() => void handleCopy()}
            className="self-start rounded-md border border-tomato-300 px-3 py-1.5 text-xs font-medium text-tomato-600 active:bg-tomato-50"
          >
            {copied ? '✓ コピーしました' : '① 依頼文をコピー'}
          </button>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-neutral-600">③ AIの返答（JSON）を貼り付け</span>
            <textarea
              value={response}
              onChange={(e) => setResponse(e.target.value)}
              rows={4}
              placeholder='{"sentences":[{"i":1,"ja":"...","vocab":[...]}]}'
              className="rounded-md border border-neutral-300 bg-white px-3 py-2 font-mono text-xs"
            />
          </label>

          {error ? <p className="text-xs text-red-600">{error}</p> : null}
          {saved ? <p className="text-xs text-green-700">✓ 取り込みました。スクリプトに訳と語彙が表示されます。</p> : null}

          <button
            type="button"
            onClick={() => void handleImport()}
            disabled={busy || response.trim().length === 0}
            className="rounded-md bg-tomato-500 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50 active:bg-tomato-600"
          >
            {busy ? '取り込み中…' : '取り込む'}
          </button>
        </div>
      ) : null}
    </section>
  );
}

import { useState } from 'react';
import type { Sentence } from '../lib/db';

export interface ScriptViewProps {
  sentences: Sentence[];
  className?: string;
}

/**
 * 練習画面のスクリプト表示（PlayerUI/RecorderUIで共用）。
 * 各文の英文(en)と、あれば日本語訳(ja)・重要語彙(vocab)を表示する。
 * 訳・語彙はトグルで隠せる（英語だけで練習したいとき用。初期は表示）。
 */
export function ScriptView({ sentences, className = '' }: ScriptViewProps) {
  const hasAnnotations = sentences.some((s) => s.ja || (s.vocab && s.vocab.length > 0));
  const [showJa, setShowJa] = useState(true);

  return (
    <div className={`max-h-40 overflow-y-auto rounded-lg bg-neutral-50 p-3 text-sm leading-relaxed ${className}`}>
      {hasAnnotations ? (
        <div className="mb-2 flex gap-1.5">
          <ToggleChip label="訳・語彙" active={showJa} onClick={() => setShowJa((v) => !v)} />
        </div>
      ) : null}

      {sentences.length === 0 ? (
        <p className="text-neutral-400">スクリプトがありません</p>
      ) : (
        sentences.map((s, i) => (
          <div key={i} className="mb-1.5">
            <p>
              <span className="text-neutral-800">{s.en}</span>
            </p>
            {showJa && s.ja ? <p className="text-xs text-neutral-500">{s.ja}</p> : null}
            {showJa && s.vocab && s.vocab.length > 0 ? (
              <p className="mt-0.5 flex flex-wrap gap-1">
                {s.vocab.map((v, j) => (
                  <span key={j} className="rounded bg-neutral-200/60 px-1.5 py-0.5 text-[10px] text-neutral-600">
                    <span className="font-semibold">{v.term}</span> {v.ja}
                  </span>
                ))}
              </p>
            ) : null}
          </div>
        ))
      )}
    </div>
  );
}

function ToggleChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
        active ? 'border-tomato-300 bg-tomato-50 text-tomato-600' : 'border-neutral-300 text-neutral-400'
      }`}
    >
      {label}
    </button>
  );
}

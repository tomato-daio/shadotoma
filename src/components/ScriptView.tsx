import type { Sentence } from '../lib/db';

export interface ScriptViewProps {
  sentences: Sentence[];
  className?: string;
}

/**
 * 練習画面のスクリプト表示（PlayerUI/RecorderUIで共用）。
 * 各文の英文(en)と、あれば日本語訳(ja)を表示する。
 */
export function ScriptView({ sentences, className = '' }: ScriptViewProps) {
  return (
    <div className={`max-h-40 overflow-y-auto rounded-lg bg-neutral-50 p-3 text-sm leading-relaxed ${className}`}>
      {sentences.length === 0 ? (
        <p className="text-neutral-400">スクリプトがありません</p>
      ) : (
        sentences.map((s, i) => (
          <p key={i} className="mb-1">
            <span className="text-neutral-800">{s.en}</span>
            {s.ja ? <span className="ml-2 block text-xs text-neutral-500">{s.ja}</span> : null}
          </p>
        ))
      )}
    </div>
  );
}

import { useMemo, useState } from 'react';
import type { JudgeResult, Sentence } from '../lib/db';
import { PHENOMENON_LABEL } from '../lib/phenomena';
import { buildScriptFeedback, hasAnyFeedback, type WordHighlight } from '../lib/scriptFeedback';

export interface ScriptViewProps {
  sentences: Sentence[];
  /** この教材の直近の判定結果。指定時は前回できた/できなかった箇所のハイライトとカードを重ねる。 */
  previousJudge?: JudgeResult;
  className?: string;
}

/** ピンク=前回できなかった箇所 / 青緑=前回指摘から改善した箇所（シャドテン風の配色）。 */
const HIGHLIGHT_CLASS: Record<WordHighlight, string> = {
  miss: 'rounded bg-rose-100 px-0.5 text-rose-700',
  improved: 'rounded bg-teal-100 px-0.5 text-teal-700',
};

/**
 * 練習画面のスクリプト表示（PlayerUI/RecorderUIで共用）。
 * - 各文の英文(en)と、あれば日本語訳(ja)・重要語彙(vocab)を表示する（トグルで隠せる・初期表示）。
 * - previousJudgeがあれば、前回の提出でできなかった語をピンク・改善した語を青緑でハイライトし、
 *   該当文の直下に Development / Good のコメントカードを出す（トグルで隠せる・初期表示）。
 */
export function ScriptView({ sentences, previousJudge, className = '' }: ScriptViewProps) {
  const hasAnnotations = sentences.some((s) => s.ja || (s.vocab && s.vocab.length > 0));
  const [showJa, setShowJa] = useState(true);
  const [showFeedback, setShowFeedback] = useState(true);

  const feedback = useMemo(() => buildScriptFeedback(sentences, previousJudge), [sentences, previousJudge]);
  const feedbackAvailable = previousJudge !== undefined && hasAnyFeedback(feedback);

  return (
    <div className={`max-h-40 overflow-y-auto rounded-lg bg-neutral-50 p-3 text-sm leading-relaxed ${className}`}>
      {hasAnnotations || feedbackAvailable ? (
        <div className="mb-2 flex gap-1.5">
          {hasAnnotations ? <ToggleChip label="訳・語彙" active={showJa} onClick={() => setShowJa((v) => !v)} /> : null}
          {feedbackAvailable ? (
            <ToggleChip label="前回の添削" active={showFeedback} onClick={() => setShowFeedback((v) => !v)} />
          ) : null}
        </div>
      ) : null}

      {sentences.length === 0 ? (
        <p className="text-neutral-400">スクリプトがありません</p>
      ) : (
        sentences.map((s, i) => {
          const fb = showFeedback && feedbackAvailable ? feedback[i] : undefined;
          return (
            <div key={i} className="mb-1.5">
              <p>
                {fb?.words ? (
                  fb.words.map((w, k) => (
                    <span key={k}>
                      <span className={w.highlight ? HIGHLIGHT_CLASS[w.highlight] : 'text-neutral-800'}>{w.text}</span>{' '}
                    </span>
                  ))
                ) : (
                  <span className="text-neutral-800">{s.en}</span>
                )}
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
              {fb?.devIssues.map((issue, j) => (
                <p key={`dev-${j}`} className="mt-1 rounded-md border border-rose-200 bg-rose-50 px-2 py-1.5 text-xs text-rose-700">
                  <span className="font-semibold">🔥 Development</span>{' '}
                  「{issue.words.join(' ')}」の{PHENOMENON_LABEL[issue.type]}を意識して発話してみましょう
                </p>
              ))}
              {fb?.improvedOutcomes.map((outcome, j) => (
                <p key={`good-${j}`} className="mt-1 rounded-md border border-teal-200 bg-teal-50 px-2 py-1.5 text-xs text-teal-700">
                  <span className="font-semibold">✓ Good</span>{' '}
                  「{outcome.words.join(' ')}」の{PHENOMENON_LABEL[outcome.type]}、前回より良くなっています
                </p>
              ))}
            </div>
          );
        })
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

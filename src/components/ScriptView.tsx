import { memo, useMemo, useState } from 'react';
import type { JudgeResult, Sentence } from '../lib/db';
import { PHENOMENON_LABEL } from '../lib/phenomena';
import { buildScriptFeedback, hasAnyFeedback, type FeedbackCard, type WordHighlight } from '../lib/scriptFeedback';

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
 * - previousJudgeがあれば、前回の提出でできなかった語をピンク・改善した語を青緑でハイライトする
 *   （トグルで隠せる・初期表示）。Development / Good のコメントカードは初期状態では出さず、
 *   点線下線付きのハイライト語をタップしたときに該当文の直下へ開く（再タップ・カードタップで閉じる）。
 *   タップアンカーが無いカード（anchored=false）のみ常時表示にフォールバックする。
 *
 * memo化必須: RecorderUIは録音中レベルメーターのためほぼ60fpsで再レンダーされ、PlayerUIも
 * timeupdate毎に再レンダーされる。ハイライト時は単語単位のspanが数百要素になるため、
 * props（すべて参照安定）が変わらない限り再レンダーをスキップする。
 */
function ScriptViewImpl({ sentences, previousJudge, className = '' }: ScriptViewProps) {
  const hasAnnotations = sentences.some((s) => s.ja || (s.vocab && s.vocab.length > 0));
  const [showJa, setShowJa] = useState(true);
  const [showFeedback, setShowFeedback] = useState(true);
  // 開いているカード（キー: `${si}:${cardIndex}`）。閉じ状態が初期値。
  const [openCards, setOpenCards] = useState<ReadonlySet<string>>(new Set());

  const feedback = useMemo(() => buildScriptFeedback(sentences, previousJudge), [sentences, previousJudge]);
  const feedbackAvailable = previousJudge !== undefined && hasAnyFeedback(feedback);
  const hasTapTargets = useMemo(() => feedback.some((f) => f.cards.some((c) => c.anchored)), [feedback]);

  // 語→カードは多対多（ペア指摘の2語が同じカードを指す・1語がdev+good両方に属す）のため、
  // タップは「対象カードが全部openなら全部閉じる、1つでも閉じていれば全部開く」の一括トグルにする。
  const toggleCards = (si: number, indices: number[]) => {
    setOpenCards((prev) => {
      const keys = indices.map((ci) => `${si}:${ci}`);
      const allOpen = keys.every((key) => prev.has(key));
      const next = new Set(prev);
      for (const key of keys) {
        if (allOpen) {
          next.delete(key);
        } else {
          next.add(key);
        }
      }
      return next;
    });
  };

  return (
    <div className={`max-h-40 overflow-y-auto rounded-lg bg-neutral-50 p-3 text-sm leading-relaxed ${className}`}>
      {hasAnnotations || feedbackAvailable ? (
        <div className="mb-2 flex flex-col gap-1">
          <div className="flex gap-1.5">
            {hasAnnotations ? <ToggleChip label="訳・語彙" active={showJa} onClick={() => setShowJa((v) => !v)} /> : null}
            {feedbackAvailable ? (
              <ToggleChip label="前回の添削" active={showFeedback} onClick={() => setShowFeedback((v) => !v)} />
            ) : null}
          </div>
          {showFeedback && feedbackAvailable && hasTapTargets ? (
            <p className="text-[10px] text-neutral-400">下線付きのハイライトをタップすると詳細が開きます</p>
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
                      {w.cardIndices.length > 0 ? (
                        <button
                          type="button"
                          onClick={() => toggleCards(i, w.cardIndices)}
                          aria-expanded={w.cardIndices.every((ci) => openCards.has(`${i}:${ci}`))}
                          className={`${
                            w.highlight ? HIGHLIGHT_CLASS[w.highlight] : 'text-neutral-800'
                          } cursor-pointer touch-manipulation underline decoration-dotted decoration-1 underline-offset-2 [-webkit-tap-highlight-color:transparent]`}
                        >
                          {w.text}
                        </button>
                      ) : (
                        <span className={w.highlight ? HIGHLIGHT_CLASS[w.highlight] : 'text-neutral-800'}>{w.text}</span>
                      )}{' '}
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
              {fb?.cards.map((card, ci) => {
                const key = `${i}:${ci}`;
                if (card.anchored && !openCards.has(key)) return null;
                return (
                  <p
                    key={key}
                    onClick={card.anchored ? () => toggleCards(i, [ci]) : undefined}
                    className={`mt-1 rounded-md border px-2 py-1.5 text-xs ${
                      card.kind === 'dev'
                        ? 'border-rose-200 bg-rose-50 text-rose-700'
                        : 'border-teal-200 bg-teal-50 text-teal-700'
                    } ${card.anchored ? 'cursor-pointer' : ''}`}
                  >
                    <CardText card={card} />
                  </p>
                );
              })}
            </div>
          );
        })
      )}
    </div>
  );
}

export const ScriptView = memo(ScriptViewImpl);

function CardText({ card }: { card: FeedbackCard }) {
  if (card.kind === 'dev') {
    return (
      <>
        <span className="font-semibold">🔥 Development</span>{' '}
        「{card.words.join(' ')}」の{PHENOMENON_LABEL[card.type]}を意識して発話してみましょう
      </>
    );
  }
  return (
    <>
      <span className="font-semibold">✓ Good</span>{' '}
      「{card.words.join(' ')}」の{PHENOMENON_LABEL[card.type]}、前回より良くなっています
    </>
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

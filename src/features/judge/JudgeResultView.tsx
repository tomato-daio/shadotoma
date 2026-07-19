import { useState } from 'react';
import type { WordMark } from '../../lib/align';
import type { AzurePronunciationResult, AzureWordScore, JudgeResult } from '../../lib/db';
import type { PhenomenonType, PreviousIssueOutcome } from '../../lib/phenomena';
import { generateAzureComments } from './azureComments';
import { worstWords } from './azurePronunciation';

export interface JudgeResultViewProps {
  judge: JudgeResult;
  /** 前回提出のmatchRate。指定時は前回比を表示する。 */
  previousMatchRate?: number;
  /**
   * Whisperが聴き取った発話の書き起こし（Submission.transcript。M8）。
   * 指定時のみ「あなたの発話」折りたたみセクションを表示する（transcriptの無い古い提出では非表示）。
   */
  transcript?: string;
  className?: string;
}

/**
 * 判定結果画面（DESIGN.md §8手順7）。
 * 色分けスクリプト（ok=緑/missed=赤/sub=黄。subは聞こえた語も併記）、matchRate・WPM、
 * Good/Development Points、あなたの発話（書き起こし）、前回提出との比較を表示する。
 */
export function JudgeResultView({ judge, previousMatchRate, transcript, className = '' }: JudgeResultViewProps) {
  const matchRatePercent = Math.round(judge.matchRate * 100);
  const deltaPercent =
    previousMatchRate !== undefined ? Math.round((judge.matchRate - previousMatchRate) * 100) : null;

  return (
    <div className={`flex flex-col gap-4 ${className}`}>
      <div className="grid grid-cols-2 gap-3">
        <StatCard label="一致率" value={`${matchRatePercent}%`} />
        <StatCard label="速さ" value={`${Math.round(judge.wpm)} WPM`} note="発話区間ベース" />
      </div>

      {deltaPercent !== null ? (
        <p
          className={`rounded-md px-3 py-2 text-center text-xs font-medium ${
            deltaPercent >= 0 ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'
          }`}
        >
          前回比 {deltaPercent >= 0 ? `+${deltaPercent}` : deltaPercent}pt
        </p>
      ) : null}

      {judge.azure ? (
        <AzureScoreCard azure={judge.azure} />
      ) : judge.azureError ? (
        <AzureErrorNotice message={judge.azureError} />
      ) : null}

      <section className="flex flex-col gap-2">
        <p className="text-xs font-medium text-neutral-500">
          添削結果（<span className="text-green-700">緑</span>=正解 / <span className="text-red-600">赤</span>
          =聞き取れず / <span className="text-amber-600">黄</span>=別の語）
        </p>
        <ColoredScript wordMarks={judge.wordMarks} />
      </section>

      <PointsList title="Good Points" points={judge.goodPoints} tone="good" />
      <PointsList title="Development Points" points={judge.devPoints} tone="dev" />

      <TranscriptSection transcript={transcript} />

      <PreviousIssuesSection outcomes={judge.previousIssueOutcomes} />
    </div>
  );
}

const PHENOMENON_LABEL: Record<PhenomenonType, string> = {
  linking: '連結',
  flap: 'フラップ（tの軽い音）',
  elision: '脱落',
  weak: '弱形',
  ending: '語尾(-s/-ed)',
};

/**
 * 「前回の指摘」欄（DESIGN.md §8 5b）。前回提出にissuesが無い（初回提出など）場合は欄ごと非表示にする。
 */
function PreviousIssuesSection({ outcomes }: { outcomes?: PreviousIssueOutcome[] }) {
  if (!outcomes || outcomes.length === 0) return null;

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-neutral-50/60 p-3">
      <p className="text-sm font-semibold text-neutral-700">前回の指摘</p>
      <ul className="flex flex-col gap-1.5 text-xs text-neutral-700">
        {outcomes.map((outcome, i) => (
          <li key={i} className="flex gap-1.5">
            <span className={outcome.improved ? 'text-green-600' : 'text-amber-600'}>
              {outcome.improved ? '✅ 改善' : '△ もう一歩'}
            </span>
            <span>
              「{outcome.words.join(' ')}」の{PHENOMENON_LABEL[outcome.type]}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * 「あなたの発話（AIが聴き取った内容）」の折りたたみ表示（M8）。
 * 初期状態は閉じており、タップで展開する。transcriptが無い（添削なし提出・古いデータ）場合は
 * セクションごと表示しない。
 */
function TranscriptSection({ transcript }: { transcript?: string }) {
  const [expanded, setExpanded] = useState(false);
  if (!transcript || transcript.trim().length === 0) return null;

  return (
    <section className="rounded-lg border border-neutral-200 bg-neutral-50/60">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-2 p-3 text-left"
      >
        <span className="text-sm font-semibold text-neutral-700">あなたの発話（AIが聴き取った内容）</span>
        <span className="text-xs text-neutral-400">{expanded ? '▲ 閉じる' : '▼ 表示'}</span>
      </button>
      {expanded ? (
        <p className="max-h-40 overflow-y-auto border-t border-neutral-100 p-3 text-sm leading-relaxed text-neutral-600">
          {transcript}
        </p>
      ) : null}
    </section>
  );
}

/** 80以上=緑/60-79=黄/60未満=赤（DESIGN.md §8c）。 */
function scoreToneClass(score: number): string {
  if (score >= 80) return 'text-green-700';
  if (score >= 60) return 'text-amber-600';
  return 'text-red-600';
}

function scoreBgClass(score: number): string {
  if (score >= 80) return 'border-green-200 bg-green-50';
  if (score >= 60) return 'border-amber-200 bg-amber-50';
  return 'border-red-200 bg-red-50';
}

/**
 * 「発音スコア」カード（DESIGN.md §8c）。総合/正確さ/流暢さ/韻律/完全性の5項目と、
 * スコアの低い単語ワースト5（点数付き）を表示する。judge.azureが無い提出では呼ばれない。
 */
function AzureScoreCard({ azure }: { azure: AzurePronunciationResult }) {
  const worst = worstWords(azure.words, 5);
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-3">
      <p className="text-sm font-semibold text-neutral-700">発音スコア（Azure）</p>
      <div className="grid grid-cols-5 gap-1.5">
        <AzureScoreTile label="総合" score={azure.pronScore} />
        <AzureScoreTile label="正確さ" score={azure.accuracyScore} />
        <AzureScoreTile label="流暢さ" score={azure.fluencyScore} />
        <AzureScoreTile label="韻律" score={azure.prosodyScore} />
        <AzureScoreTile label="完全性" score={azure.completenessScore} />
      </div>
      {worst.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-neutral-500">スコアの低い単語</p>
          <ul className="flex flex-wrap gap-1.5">
            {worst.map((w, i) => (
              <AzureWordChip key={`${w.word}-${i}`} word={w} />
            ))}
          </ul>
        </div>
      ) : null}

      <AzureCommentsList azure={azure} />
    </section>
  );
}

/**
 * Azureコメント（DESIGN.md §8c M12）。weakPhonemes/prosodyFeedbackのどちらも無い過去データ
 * （M12以前の提出）では欄ごと非表示にする（DESIGN.md §8c M12: 「過去データでweakPhonemes等が
 * 無い場合はコメント欄を出さない」）。
 */
function AzureCommentsList({ azure }: { azure: AzurePronunciationResult }) {
  if (azure.weakPhonemes === undefined && azure.prosodyFeedback === undefined) return null;
  const comments = generateAzureComments(azure);
  if (comments.length === 0) return null;

  return (
    <div className="flex flex-col gap-1 border-t border-neutral-100 pt-2">
      <p className="text-xs font-medium text-neutral-500">コメント</p>
      <ul className="flex flex-col gap-1.5 text-xs text-neutral-700">
        {comments.map((c, i) => (
          <li key={i} className="flex gap-1.5">
            <span className="text-tomato-500">・</span>
            <span>{c}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * scoreがundefined（M10: 韻律採点が未対応リージョンで自動リトライ後のフォールバック）の場合は
 * 「―」を表示し、色分けもしない（DESIGN.md §8c M10:「カードの韻律欄は―」）。
 */
function AzureScoreTile({ label, score }: { label: string; score?: number }) {
  if (score === undefined) {
    return (
      <div className="rounded-md border border-neutral-200 bg-neutral-50 p-1.5 text-center">
        <p className="text-sm font-bold text-neutral-400">―</p>
        <p className="text-[10px] text-neutral-500">{label}</p>
      </div>
    );
  }
  return (
    <div className={`rounded-md border p-1.5 text-center ${scoreBgClass(score)}`}>
      <p className={`text-sm font-bold ${scoreToneClass(score)}`}>{Math.round(score)}</p>
      <p className="text-[10px] text-neutral-500">{label}</p>
    </div>
  );
}

function AzureWordChip({ word }: { word: AzureWordScore }) {
  return (
    <li className={`rounded-md border px-2 py-1 text-xs ${scoreBgClass(word.accuracyScore)}`}>
      <span className="font-medium text-neutral-700">{word.word}</span>
      <span className={`ml-1 font-semibold ${scoreToneClass(word.accuracyScore)}`}>{Math.round(word.accuracyScore)}</span>
    </li>
  );
}

/** Azure採点が失敗した場合の一行メッセージ表示（DESIGN.md §8c: 「エラー時は1行メッセージ」）。 */
function AzureErrorNotice({ message }: { message: string }) {
  return <p className="rounded-md bg-neutral-50 px-3 py-2 text-xs text-neutral-500">発音スコア: {message}</p>;
}

function StatCard({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-xl border border-neutral-200 p-3 text-center">
      <p className="text-xl font-bold text-tomato-600">{value}</p>
      <p className="text-xs text-neutral-400">{label}</p>
      {note ? <p className="text-[10px] text-neutral-400">（{note}）</p> : null}
    </div>
  );
}

const STATUS_CLASS: Record<WordMark['status'], string> = {
  ok: 'text-green-700',
  missed: 'text-red-600 line-through decoration-red-300',
  sub: 'text-amber-600 font-semibold underline decoration-amber-300',
};

function ColoredScript({ wordMarks }: { wordMarks: WordMark[] }) {
  if (wordMarks.length === 0) {
    return <p className="text-xs text-neutral-400">スクリプトがありません</p>;
  }

  // 文index(si)ごとに改行して読みやすくする
  const bySentence = new Map<number, WordMark[]>();
  for (const mark of wordMarks) {
    const list = bySentence.get(mark.si) ?? [];
    list.push(mark);
    bySentence.set(mark.si, list);
  }

  return (
    <div className="max-h-52 overflow-y-auto rounded-lg bg-neutral-50 p-3 text-sm leading-relaxed">
      {[...bySentence.entries()].map(([si, marks]) => (
        <p key={si} className="mb-1">
          {marks.map((m, i) => (
            <span key={i}>
              <span className={STATUS_CLASS[m.status]}>{m.word}</span>
              {m.status === 'sub' && m.recognized ? (
                // 置換語（黄）には実際に聴き取られた語を添える（M8。recognizedはM7で保存済み）
                <span className="text-[10px] font-normal text-amber-500">(→ {m.recognized})</span>
              ) : null}{' '}
            </span>
          ))}
        </p>
      ))}
    </div>
  );
}

function PointsList({ title, points, tone }: { title: string; points: string[]; tone: 'good' | 'dev' }) {
  const toneClass = tone === 'good' ? 'border-green-200 bg-green-50/60' : 'border-amber-200 bg-amber-50/60';
  const titleClass = tone === 'good' ? 'text-green-700' : 'text-amber-700';
  return (
    <section className={`flex flex-col gap-2 rounded-lg border p-3 ${toneClass}`}>
      <p className={`text-sm font-semibold ${titleClass}`}>{title}</p>
      <ul className="flex flex-col gap-1.5 text-xs text-neutral-700">
        {points.map((p, i) => (
          <li key={i} className="flex gap-1.5">
            <span className={titleClass}>・</span>
            <span>{p}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

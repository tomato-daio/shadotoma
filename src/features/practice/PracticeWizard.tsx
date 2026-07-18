import { useEffect, useState } from 'react';
import type { Material } from '../../lib/db';
import { NEXT_MATERIAL_SUGGEST_DAY } from '../../lib/practiceFlow';
import { PlayerUI } from '../player/PlayerUI';
import { RecorderUI } from '../recorder/RecorderUI';
import { usePracticeWizard } from './usePracticeWizard';

export interface PracticeWizardProps {
  material: Material;
  audioSrc: string;
  onSubmit: (blob: Blob, mimeType: string) => Promise<void> | void;
  onGoToMaterials: () => void;
}

/**
 * 練習画面のステップウィザード本体（DESIGN.md §4）。
 * 教材のMaterialProgressから「何日目か」を求め、その日の推奨ステップ（1日目:
 * リスニング→スクリプト確認→オーバーラッピング / 2〜4日目: シャドーイング→録音提出）を
 * 順に案内する。ステップは自由にスキップ・前後移動でき、進めるたびに sessions /
 * materialProgress へ記録する。
 */
export function PracticeWizard({ material, audioSrc, onSubmit, onGoToMaterials }: PracticeWizardProps) {
  const wizard = usePracticeWizard(material.id);
  const [loopCount, setLoopCount] = useState(0);

  useEffect(() => {
    setLoopCount(0);
  }, [wizard.currentStep?.key, wizard.currentIndex]);

  if (wizard.loading) {
    return <p className="p-4 text-center text-sm text-neutral-400">読み込み中…</p>;
  }

  if (wizard.suggestNext) {
    return (
      <NextMaterialSuggestion
        dayNumber={wizard.dayNumber}
        onContinue={wizard.continueAnyway}
        onGoToMaterials={onGoToMaterials}
      />
    );
  }

  if (wizard.finished) {
    if (wizard.dayNumber >= NEXT_MATERIAL_SUGGEST_DAY) {
      return (
        <NextMaterialSuggestion
          dayNumber={wizard.dayNumber}
          onContinue={wizard.continueAnyway}
          onGoToMaterials={onGoToMaterials}
        />
      );
    }
    return (
      <div className="flex flex-col items-center gap-4 rounded-xl border border-neutral-200 p-6 text-center">
        <p className="text-base font-semibold text-neutral-800">{wizard.dayNumber}日目、お疲れさまでした！</p>
        <p className="text-sm text-neutral-500">また明日も続けましょう。</p>
        <button
          type="button"
          onClick={onGoToMaterials}
          className="rounded-full bg-tomato-500 px-4 py-2 text-sm font-semibold text-white active:bg-tomato-600"
        >
          教材一覧に戻る
        </button>
      </div>
    );
  }

  const step = wizard.currentStep;
  if (!step) return null;

  const isLastStep = wizard.currentIndex === wizard.steps.length - 1;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-neutral-400">{wizard.dayNumber}日目の練習</span>
        <div className="flex gap-1">
          {wizard.steps.map((s, i) => (
            <button
              key={s.key}
              type="button"
              onClick={() => wizard.goToIndex(i)}
              aria-label={s.label}
              className={`h-2 w-6 rounded-full ${
                i === wizard.currentIndex ? 'bg-tomato-500' : i < wizard.currentIndex ? 'bg-tomato-200' : 'bg-neutral-200'
              }`}
            />
          ))}
        </div>
      </div>

      <div className="rounded-lg bg-tomato-50/60 p-3 text-sm text-tomato-800">
        <p className="font-semibold">{step.label}</p>
        <p className="mt-1 text-xs text-tomato-700">{step.instruction}</p>
      </div>

      {step.kind === 'player' ? (
        <PlayerUI
          key={`${material.id}-${step.key}`}
          src={audioSrc}
          sentences={material.sentences}
          initialScriptVisible={step.initialScriptVisible}
          loopTarget={step.loopTarget}
          onLoopCountChange={setLoopCount}
        />
      ) : (
        <RecorderUI referenceSrc={audioSrc} onSubmit={onSubmit} />
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={wizard.goBack}
          disabled={wizard.currentIndex === 0}
          className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-600 disabled:opacity-40"
        >
          前のステップへ
        </button>
        <button
          type="button"
          onClick={() => void wizard.completeCurrentStep(step.kind === 'player' ? loopCount : 0)}
          className="flex-1 rounded-md bg-tomato-500 px-3 py-2 text-sm font-semibold text-white active:bg-tomato-600"
        >
          {isLastStep ? '完了' : '次へ'}
        </button>
      </div>
    </div>
  );
}

interface NextMaterialSuggestionProps {
  dayNumber: number;
  onContinue: () => void;
  onGoToMaterials: () => void;
}

function NextMaterialSuggestion({ dayNumber, onContinue, onGoToMaterials }: NextMaterialSuggestionProps) {
  return (
    <div className="flex flex-col items-center gap-4 rounded-xl border border-tomato-200 bg-tomato-50/40 p-6 text-center">
      <p className="text-base font-semibold text-tomato-700">{dayNumber}日目、お疲れさまでした！</p>
      <p className="text-sm text-neutral-600">
        マンネリ防止のため、そろそろ新しい教材に挑戦してみませんか？
      </p>
      <div className="flex w-full gap-2">
        <button
          type="button"
          onClick={onContinue}
          className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-600 active:bg-neutral-100"
        >
          この教材を続ける
        </button>
        <button
          type="button"
          onClick={onGoToMaterials}
          className="flex-1 rounded-md bg-tomato-500 px-3 py-2 text-sm font-semibold text-white active:bg-tomato-600"
        >
          他の教材を探す
        </button>
      </div>
    </div>
  );
}

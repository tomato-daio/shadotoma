import { useCallback, useEffect, useState } from 'react';
import { addSession, getMaterialProgress, newId, touchMaterialProgress, type MaterialProgress } from '../../lib/db';
import { learningDate } from '../../lib/dates';
import { computeDayNumber, getWizardSteps, shouldSuggestNextMaterial, type WizardStepConfig } from '../../lib/practiceFlow';

export interface UsePracticeWizardResult {
  loading: boolean;
  /** 今日は何日目か（MaterialProgress.daysPracticed基準）。 */
  dayNumber: number;
  steps: WizardStepConfig[];
  currentIndex: number;
  currentStep: WizardStepConfig | null;
  /** そのステップまで一通り終えた状態か。 */
  finished: boolean;
  /** 「次の教材へ」を提案する画面を表示すべきか（4日目以降かつ、まだ「続ける」を選んでいない）。 */
  suggestNext: boolean;
  /** 現在のステップを完了として記録し、次のステップへ進む（最終ステップならfinished=trueにする）。 */
  completeCurrentStep: (loops: number) => Promise<void>;
  /** 1つ前のステップへ戻る（記録はしない。自由な戻りのため）。 */
  goBack: () => void;
  /** 任意のステップへジャンプする（記録はしない。自由なスキップのため）。 */
  goToIndex: (index: number) => void;
  /** 4日目以降の提案を無視してこのまま続ける場合に呼ぶ。 */
  continueAnyway: () => void;
}

/**
 * 練習フローウィザードの状態管理フック（DESIGN.md §4）。
 * MaterialProgressから「何日目か」を求め、その日の推奨ステップ構成に沿って進行を管理する。
 * ステップ完了のたびに sessions への記録・materialProgress の更新を行う。
 */
export function usePracticeWizard(materialId: string | undefined): UsePracticeWizardResult {
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<MaterialProgress | undefined>(undefined);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [finished, setFinished] = useState(false);
  const [forceContinue, setForceContinue] = useState(false);

  useEffect(() => {
    if (!materialId) return;
    let cancelled = false;
    setLoading(true);
    setCurrentIndex(0);
    setFinished(false);
    setForceContinue(false);
    void getMaterialProgress(materialId).then((p) => {
      if (!cancelled) {
        setProgress(p);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [materialId]);

  const today = learningDate(new Date());
  const dayNumber = computeDayNumber(progress?.daysPracticed ?? [], today);
  const steps = getWizardSteps(dayNumber);
  const currentStep = steps[currentIndex] ?? null;
  const suggestNext = !forceContinue && !finished && shouldSuggestNextMaterial(dayNumber);

  const completeCurrentStep = useCallback(
    async (loops: number) => {
      if (!materialId || !currentStep) return;
      await addSession({
        id: newId('session'),
        materialId,
        date: today,
        step: currentStep.step,
        loops,
        startedAt: Date.now(),
      });
      const nextProgress = await touchMaterialProgress(materialId, today, currentStep.step, loops);
      setProgress(nextProgress);
      setCurrentIndex((i) => {
        if (i + 1 >= steps.length) {
          setFinished(true);
          return i;
        }
        return i + 1;
      });
    },
    [materialId, currentStep, today, steps.length],
  );

  const goBack = useCallback(() => {
    setCurrentIndex((i) => Math.max(0, i - 1));
  }, []);

  const goToIndex = useCallback(
    (index: number) => {
      setCurrentIndex(Math.min(Math.max(0, index), steps.length - 1));
    },
    [steps.length],
  );

  const continueAnyway = useCallback(() => {
    setForceContinue(true);
  }, []);

  return {
    loading,
    dayNumber,
    steps,
    currentIndex,
    currentStep,
    finished,
    suggestNext,
    completeCurrentStep,
    goBack,
    goToIndex,
    continueAnyway,
  };
}

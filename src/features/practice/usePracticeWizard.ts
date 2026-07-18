import { useCallback, useEffect, useRef, useState } from 'react';
import {
  addSession,
  getMaterialProgress,
  getSubmissionsByMaterial,
  markMaterialProgressDone,
  newId,
  touchMaterialProgress,
  type MaterialProgress,
} from '../../lib/db';
import { learningDate } from '../../lib/dates';
import {
  computeDayNumber,
  getWizardSteps,
  NEXT_MATERIAL_SUGGEST_DAY,
  shouldSuggestNextMaterial,
  type WizardStepConfig,
} from '../../lib/practiceFlow';

export interface UsePracticeWizardResult {
  loading: boolean;
  /** 今日は何日目か（MaterialProgress.daysPracticed基準）。 */
  dayNumber: number;
  steps: WizardStepConfig[];
  currentIndex: number;
  currentStep: WizardStepConfig | null;
  /** そのステップまで一通り終えた状態か。 */
  finished: boolean;
  /** 「次の教材へ」を提案する画面を表示すべきか（ステップ開始前。4日目以降かつ、まだ「続ける」を選んでいない）。 */
  suggestNext: boolean;
  /**
   * 「次の教材へ」提案の対象条件を満たしているか（finished状態に関わらず判定）。
   * 4日目到達、またはmatchRate>=0.85（DESIGN.md §4）。ステップ完了直後の画面分岐に使う。
   */
  nextMaterialEligible: boolean;
  /** 現在のステップを完了として記録し、次のステップへ進む（最終ステップならfinished=trueにする）。 */
  completeCurrentStep: (loops: number) => Promise<void>;
  /** completeCurrentStepが実行中（IndexedDB書き込み待ち）か。多重クリック防止のボタン無効化に使う。 */
  completing: boolean;
  /** 1つ前のステップへ戻る（記録はしない。自由な戻りのため）。 */
  goBack: () => void;
  /** 任意のステップへジャンプする（記録はしない。自由なスキップのため）。 */
  goToIndex: (index: number) => void;
  /** 4日目以降の提案を無視してこのまま続ける場合に呼ぶ。 */
  continueAnyway: () => void;
  /** 添削結果のmatchRateが判明した時点で呼び、早期提案の判定に反映する。 */
  applyLatestMatchRate: (matchRate: number) => void;
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
  // このセッション開始時点でのmatchRate（固定値。ステップ開始前ゲートに使う）。
  const [mountMatchRate, setMountMatchRate] = useState<number | undefined>(undefined);
  // 現在時点でのmatchRate（今回の提出で更新されうる。完了後ゲートに使う）。
  const [latestMatchRate, setLatestMatchRate] = useState<number | undefined>(undefined);
  const [completing, setCompleting] = useState(false);
  // completeCurrentStepの多重実行防止用（stateの更新は非同期なため、同期的に判定できるrefを併用する）。
  const completingRef = useRef(false);

  useEffect(() => {
    if (!materialId) return;
    let cancelled = false;
    setLoading(true);
    setCurrentIndex(0);
    setFinished(false);
    setForceContinue(false);
    setMountMatchRate(undefined);
    setLatestMatchRate(undefined);
    void Promise.all([getMaterialProgress(materialId), getSubmissionsByMaterial(materialId)]).then(
      ([p, submissions]) => {
        if (cancelled) return;
        setProgress(p);
        // getSubmissionsByMaterialは新しい順。judge結果を持つ直近の提出のmatchRateを初期値にする
        // （前回セッションで既に0.85以上だった場合も早期提案の判定に反映するため）。
        const latestJudged = submissions.find((s) => s.judge);
        const rate = latestJudged?.judge?.matchRate;
        setMountMatchRate(rate);
        setLatestMatchRate(rate);
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [materialId]);

  const today = learningDate(new Date());
  const dayNumber = computeDayNumber(progress?.daysPracticed ?? [], today);
  const steps = getWizardSteps(dayNumber);
  const currentStep = steps[currentIndex] ?? null;
  // ステップ開始前ゲート: セッション開始時点のmatchRateで判定する（今回の提出結果でいきなり
  // ステップ画面が差し替わらないよう、finished前は固定値を見る）。
  const suggestNext = !forceContinue && !finished && shouldSuggestNextMaterial(dayNumber, mountMatchRate);
  // 完了後ゲート: 今回の提出結果（applyLatestMatchRate）も反映した最新値で判定する。
  const nextMaterialEligible = !forceContinue && shouldSuggestNextMaterial(dayNumber, latestMatchRate);

  const completeCurrentStep = useCallback(
    async (loops: number) => {
      if (!materialId || !currentStep) return;
      // 連打・二重タップでの多重実行を防ぐ（in-flight中の再入は無視する）。
      if (completingRef.current) return;
      completingRef.current = true;
      setCompleting(true);
      try {
        await addSession({
          id: newId('session'),
          materialId,
          date: today,
          step: currentStep.step,
          loops,
          startedAt: Date.now(),
        });
        let nextProgress = await touchMaterialProgress(materialId, today, currentStep.step, loops);
        const isLastStep = currentIndex + 1 >= steps.length;
        // DESIGN.md §8b前提: 4日目の練習完了時（＝その日の最終ステップを完了した時点）にdone確定する。
        // matchRate>=0.85側のdone確定はPracticePage側の提出ハンドラで行う。
        if (isLastStep && dayNumber >= NEXT_MATERIAL_SUGGEST_DAY) {
          nextProgress = await markMaterialProgressDone(materialId, today);
        }
        setProgress(nextProgress);
        setCurrentIndex((i) => {
          if (i + 1 >= steps.length) {
            setFinished(true);
            return i;
          }
          return i + 1;
        });
      } finally {
        completingRef.current = false;
        setCompleting(false);
      }
    },
    [materialId, currentStep, today, steps.length, currentIndex, dayNumber],
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

  const applyLatestMatchRate = useCallback((matchRate: number) => {
    setLatestMatchRate(matchRate);
  }, []);

  return {
    loading,
    dayNumber,
    steps,
    currentIndex,
    currentStep,
    finished,
    suggestNext,
    nextMaterialEligible,
    completeCurrentStep,
    completing,
    goBack,
    goToIndex,
    continueAnyway,
    applyLatestMatchRate,
  };
}

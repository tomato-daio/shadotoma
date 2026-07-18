import { describe, expect, it } from 'vitest';
import {
  computeDayNumber,
  getWizardSteps,
  latestDate,
  NEXT_MATERIAL_SUGGEST_DAY,
  shouldSuggestNextMaterial,
} from './practiceFlow';

describe('computeDayNumber', () => {
  it('練習履歴が空なら1日目', () => {
    expect(computeDayNumber([], '2026-07-18')).toBe(1);
  });

  it('今日すでに練習済みならその日数のまま', () => {
    expect(computeDayNumber(['2026-07-17', '2026-07-18'], '2026-07-18')).toBe(2);
  });

  it('今日はまだ練習していなければ+1日目', () => {
    expect(computeDayNumber(['2026-07-16', '2026-07-17'], '2026-07-18')).toBe(3);
  });

  it('重複した日付は1日として数える', () => {
    expect(computeDayNumber(['2026-07-17', '2026-07-17'], '2026-07-18')).toBe(2);
  });
});

describe('getWizardSteps', () => {
  it('1日目はリスニング→スクリプト確認→オーバーラッピングの3ステップ', () => {
    const steps = getWizardSteps(1);
    expect(steps.map((s) => s.step)).toEqual(['listening', 'script', 'overlapping']);
    expect(steps[0].initialScriptVisible).toBe(false);
    expect(steps[1].initialScriptVisible).toBe(true);
    expect(steps[2].initialScriptVisible).toBe(true);
  });

  it('2〜4日目はシャドーイング→録音提出の2ステップ', () => {
    for (const day of [2, 3, 4]) {
      const steps = getWizardSteps(day);
      expect(steps.map((s) => s.kind)).toEqual(['player', 'recorder']);
      expect(steps[0].step).toBe('shadowing');
      expect(steps[1].step).toBe('shadowing');
    }
  });

  it('5日目以降も2〜4日目と同じ構成にフォールバックする', () => {
    expect(getWizardSteps(5)).toEqual(getWizardSteps(2));
  });
});

describe('shouldSuggestNextMaterial', () => {
  it('4日目未満は提案しない', () => {
    expect(shouldSuggestNextMaterial(1)).toBe(false);
    expect(shouldSuggestNextMaterial(3)).toBe(false);
  });

  it('4日目以降は提案する', () => {
    expect(shouldSuggestNextMaterial(NEXT_MATERIAL_SUGGEST_DAY)).toBe(true);
    expect(shouldSuggestNextMaterial(5)).toBe(true);
  });
});

describe('latestDate', () => {
  it('空配列は空文字列', () => {
    expect(latestDate([])).toBe('');
  });

  it('最新の日付を返す（順不同でも）', () => {
    expect(latestDate(['2026-07-10', '2026-07-18', '2026-07-15'])).toBe('2026-07-18');
  });
});

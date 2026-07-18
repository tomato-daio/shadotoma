/**
 * 練習フローウィザードの純関数ロジック（DESIGN.md §4）。
 *
 * 教材の練習日数(`MaterialProgress.daysPracticed`)から「今日は何日目か」を求め、
 * その日数に応じた推奨ステップ構成を返す。DB/React には依存しない純関数のみを公開する。
 */

import type { PracticeStep } from './db';

export interface WizardStepConfig {
  /** ウィザード内で一意なキー（同じPracticeStepが複数フェーズに現れる場合の区別用）。 */
  key: string;
  /** sessions.step / materialProgress.lastStep に記録するステップ種別。 */
  step: PracticeStep;
  /** 画面種別。player=プレーヤー中心の練習、recorder=録音・提出。 */
  kind: 'player' | 'recorder';
  label: string;
  instruction: string;
  /** このステップに入った時点でのスクリプト表示初期値。 */
  initialScriptVisible: boolean;
  /** ループ回数の目安。nullなら目安表示なし。 */
  loopTarget: number | null;
}

const DAY1_STEPS: WizardStepConfig[] = [
  {
    key: 'listening',
    step: 'listening',
    kind: 'player',
    label: '① リスニング',
    instruction: 'スクリプトを見ずに、まず3回聴いてみましょう。',
    initialScriptVisible: false,
    loopTarget: 3,
  },
  {
    key: 'script',
    step: 'script',
    kind: 'player',
    label: '② スクリプト確認',
    instruction: '英文と意味を確認しましょう。必要なら聴き直してもOKです。',
    initialScriptVisible: true,
    loopTarget: null,
  },
  {
    key: 'overlapping',
    step: 'overlapping',
    kind: 'player',
    label: '③ オーバーラッピング',
    instruction: 'スクリプトを見ながら、音声と同時に声に出しましょう。',
    initialScriptVisible: true,
    loopTarget: 10,
  },
];

const DAY2_4_STEPS: WizardStepConfig[] = [
  {
    key: 'shadowing',
    step: 'shadowing',
    kind: 'player',
    label: '④ シャドーイング',
    instruction: 'スクリプトを見ずに、音声を追いかけて声に出しましょう。',
    initialScriptVisible: false,
    loopTarget: 15,
  },
  {
    key: 'submit',
    step: 'shadowing',
    kind: 'recorder',
    label: '⑤ 録音・提出',
    instruction: '録音してお手本と聴き比べ、提出しましょう。',
    initialScriptVisible: false,
    loopTarget: null,
  },
];

/** マンネリ防止の「次の教材へ」提案を出す日数のしきい値（DESIGN.md §4: 4日目終了時）。 */
export const NEXT_MATERIAL_SUGGEST_DAY = 4;

/**
 * 教材の練習日数から「今日は何日目か」を求める。
 * `daysPracticed` に今日の日付が既に含まれていればその日数のまま
 * （今日すでに練習を開始している）、含まれていなければ+1日目として扱う。
 */
export function computeDayNumber(daysPracticed: string[], today: string): number {
  const uniqueCount = new Set(daysPracticed).size;
  return daysPracticed.includes(today) ? uniqueCount : uniqueCount + 1;
}

/**
 * 指定の日数に応じた推奨ステップ構成を返す。
 * - 1日目: リスニング → スクリプト確認 → オーバーラッピング
 * - 2日目以降: シャドーイング → 録音・提出
 *
 * 4日目を超えても同じ構成を返す（「このまま続ける」を選んだ場合の継続練習用フォールバック）。
 */
export function getWizardSteps(dayNumber: number): WizardStepConfig[] {
  if (dayNumber <= 1) return DAY1_STEPS;
  return DAY2_4_STEPS;
}

/** matchRateがこの値以上なら、日数に関わらず「次の教材へ」を早期提案する（DESIGN.md §4）。 */
export const NEXT_MATERIAL_SUGGEST_MATCH_RATE = 0.85;

/**
 * 「次の教材へ」を提案すべきかどうか（マンネリ防止、DESIGN.md §4）。
 * - 4日目に到達した場合（日数条件。既存仕様）
 * - または、直近の提出のmatchRateが0.85以上の場合（早期提案。M3で追加）
 *
 * `latestMatchRate` は直近の提出（同一教材内で最新のjudge結果）のmatchRateを渡す。
 * まだ添削結果が無い場合はundefinedを渡せば日数条件のみで判定する。
 */
export function shouldSuggestNextMaterial(dayNumber: number, latestMatchRate?: number): boolean {
  if (dayNumber >= NEXT_MATERIAL_SUGGEST_DAY) return true;
  if (latestMatchRate !== undefined && latestMatchRate >= NEXT_MATERIAL_SUGGEST_MATCH_RATE) return true;
  return false;
}

/** 日付文字列("YYYY-MM-DD")配列から最新の日付を返す。空配列なら空文字列。 */
export function latestDate(dates: string[]): string {
  return dates.reduce((latest, d) => (d > latest ? d : latest), '');
}

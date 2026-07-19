/**
 * 弱点プロファイルの構築（DESIGN.md §8d M13「弱点分析とパーソナライズ推薦」）。
 *
 * 新storeは作らず、提出データ（submissions）と確認テスト結果（quizResults）から都度導出する。
 * 純関数のみを公開し、DOM/ブラウザAPIには依存しない（Vitestでテストする）。
 */

import { normalizeWord } from '../../lib/align';
import type { QuizResult, Submission } from '../../lib/db';
import type { PhenomenonType } from '../../lib/phenomena';

// ---- 苦手音素 ----

export interface WeakPhonemeProfileEntry {
  phoneme: string; // ARPAbet大文字キー（phonemeAdvice.tsと同じ体系）
  /** 時間減衰加重平均スコア（半減期10提出）。低いほど苦手。 */
  score: number;
  /** 集計に使ったAzure提出（この音素がweakPhonemesに含まれていた提出）の件数。 */
  occurrences: number;
  /** 直近の出現と、それより前の出現を比べた傾向。1件しかない場合は判断材料不足として'stagnant'。 */
  trend: 'improving' | 'stagnant';
}

/** 半減期10提出（DESIGN.md §8d）。weight = 0.5^(rank/half-life)。rank=0が最新のAzure付き提出。 */
const PHONEME_HALF_LIFE = 10;
/** 直近平均がこの値以上になったら「克服」扱い（DESIGN.md §8d）。 */
const OVERCOME_THRESHOLD = 75;
/** 「直近平均」を計算する際に使う、直近何件の出現を見るか。 */
const RECENT_WINDOW = 3;
/** 進捗タブ「苦手音トップ3」用の上限（DESIGN.md §8d）。 */
const WEAK_PHONEME_TOP_LIMIT = 3;

interface PhonemeOccurrence {
  rank: number; // 0=最新のAzure付き提出
  avgScore: number;
}

/**
 * Azure付き提出（judge.azure.weakPhonemesを持つもの）から、音素ごとの時間減衰加重平均・傾向・
 * 克服判定を求める。戻り値は「克服していない音素（scoreの低い順）」と「克服した音素のキー一覧」。
 */
function buildPhonemeStats(azureSubmissionsDesc: Submission[]): {
  weakPhonemes: WeakPhonemeProfileEntry[];
  overcomePhonemes: string[];
} {
  const byPhoneme = new Map<string, PhonemeOccurrence[]>();
  azureSubmissionsDesc.forEach((submission, rank) => {
    for (const wp of submission.judge?.azure?.weakPhonemes ?? []) {
      const list = byPhoneme.get(wp.phoneme) ?? [];
      list.push({ rank, avgScore: wp.avgScore });
      byPhoneme.set(wp.phoneme, list);
    }
  });

  const weakPhonemes: WeakPhonemeProfileEntry[] = [];
  const overcomePhonemes: string[] = [];

  for (const [phoneme, occurrencesUnsorted] of byPhoneme) {
    // rank昇順(新しい順)に揃える。
    const occurrences = [...occurrencesUnsorted].sort((a, b) => a.rank - b.rank);

    const weightOf = (rank: number) => 0.5 ** (rank / PHONEME_HALF_LIFE);
    const weightSum = occurrences.reduce((sum, o) => sum + weightOf(o.rank), 0);
    const score = occurrences.reduce((sum, o) => sum + o.avgScore * weightOf(o.rank), 0) / weightSum;

    const recentWindow = occurrences.slice(0, RECENT_WINDOW);
    const recentAvg = recentWindow.reduce((sum, o) => sum + o.avgScore, 0) / recentWindow.length;
    const overcome = recentAvg >= OVERCOME_THRESHOLD;

    let trend: WeakPhonemeProfileEntry['trend'] = 'stagnant';
    if (occurrences.length >= 2) {
      const half = Math.ceil(occurrences.length / 2);
      const newerHalf = occurrences.slice(0, half);
      const olderHalf = occurrences.slice(half);
      const newerAvg = newerHalf.reduce((sum, o) => sum + o.avgScore, 0) / newerHalf.length;
      const olderAvg = olderHalf.reduce((sum, o) => sum + o.avgScore, 0) / olderHalf.length;
      trend = newerAvg > olderAvg ? 'improving' : 'stagnant';
    }

    if (overcome) {
      overcomePhonemes.push(phoneme);
    } else {
      weakPhonemes.push({ phoneme, score, occurrences: occurrences.length, trend });
    }
  }

  weakPhonemes.sort((a, b) => a.score - b.score);
  return { weakPhonemes: weakPhonemes.slice(0, WEAK_PHONEME_TOP_LIMIT), overcomePhonemes: overcomePhonemes.sort() };
}

// ---- 苦手現象 ----

export interface WeakPhenomenonEntry {
  type: PhenomenonType;
  /** judge.issuesに現れた回数（全提出合算）。 */
  frequency: number;
  /**
   * 優先度スコア = frequency × 未改善率（DESIGN.md §8d M13検収時に確定した定義）。
   * 未改善率 = 1 − improvedRatio（improvedRatioは同typeのpreviousIssueOutcomesのうちimproved=trueの割合）。
   * 「頻繁に指摘され、かつ改善できていない現象」こそがユーザーの持続的な苦手であり最優先。
   * - 比較実績が無いtypeは未改善率=1（改善の証拠が無い＝苦手のまま扱う）
   * - 未改善率には下限0.1を設ける（改善済みでも直近まで頻出していた現象を完全には消さない）
   */
  score: number;
}

function buildWeakPhenomena(submissions: Submission[]): WeakPhenomenonEntry[] {
  const frequency = new Map<PhenomenonType, number>();
  for (const s of submissions) {
    for (const issue of s.judge?.issues ?? []) {
      frequency.set(issue.type, (frequency.get(issue.type) ?? 0) + 1);
    }
  }

  const improvedCount = new Map<PhenomenonType, number>();
  const outcomeTotal = new Map<PhenomenonType, number>();
  for (const s of submissions) {
    for (const outcome of s.judge?.previousIssueOutcomes ?? []) {
      outcomeTotal.set(outcome.type, (outcomeTotal.get(outcome.type) ?? 0) + 1);
      if (outcome.improved) improvedCount.set(outcome.type, (improvedCount.get(outcome.type) ?? 0) + 1);
    }
  }

  const entries: WeakPhenomenonEntry[] = [];
  for (const [type, freq] of frequency) {
    const total = outcomeTotal.get(type) ?? 0;
    const improvedRatio = total > 0 ? (improvedCount.get(type) ?? 0) / total : 0;
    const unresolvedRate = Math.max(0.1, 1 - improvedRatio);
    entries.push({ type, frequency: freq, score: freq * unresolvedRate });
  }

  return entries.sort((a, b) => b.score - a.score || b.frequency - a.frequency);
}

// ---- 苦手単語 ----

export interface WeakWordEntry {
  /** 表示用の原文表記（最初に検出された際の表記）。 */
  word: string;
  /** 正規化後（normalizeWord）に同一視された出現回数の合計。 */
  count: number;
}

const WEAK_WORD_MIN_COUNT = 2; // DESIGN.md §8d: 「2回以上重なった語」
const WEAK_WORD_TOP_LIMIT = 5; // 進捗タブ「繰り返し間違う単語トップ5」

/** Azure単語スコアを「低スコア語」とみなすしきい値（azureComments.tsの音素しきい値と揃える）。 */
const AZURE_LOW_WORD_SCORE_THRESHOLD = 60;

function buildWeakWords(submissions: Submission[], quizResults: QuizResult[]): WeakWordEntry[] {
  const counts = new Map<string, { count: number; display: string }>();
  const bump = (rawWord: string) => {
    const key = normalizeWord(rawWord);
    if (key === '') return;
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(key, { count: 1, display: rawWord });
    }
  };

  for (const s of submissions) {
    for (const mark of s.judge?.wordMarks ?? []) {
      if (mark.status !== 'ok') bump(mark.word);
    }
    for (const w of s.judge?.azure?.words ?? []) {
      if (w.accuracyScore < AZURE_LOW_WORD_SCORE_THRESHOLD) bump(w.word);
    }
  }
  for (const q of quizResults) {
    for (const w of q.wrongWords ?? []) bump(w);
  }

  return [...counts.values()]
    .filter((v) => v.count >= WEAK_WORD_MIN_COUNT)
    .sort((a, b) => b.count - a.count)
    .slice(0, WEAK_WORD_TOP_LIMIT)
    .map((v) => ({ word: v.display, count: v.count }));
}

// ---- レベル適正 ----

const RECENT_MATCH_RATE_WINDOW = 5;

function computeRecentMatchRateAvg(submissions: Submission[]): number | null {
  const judged = submissions
    .filter((s): s is Submission & { judge: NonNullable<Submission['judge']> } => Boolean(s.judge))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, RECENT_MATCH_RATE_WINDOW);
  if (judged.length === 0) return null;
  return judged.reduce((sum, s) => sum + s.judge.matchRate, 0) / judged.length;
}

// ---- 統合 ----

export interface WeaknessProfile {
  /** 克服していない苦手音素（scoreの低い順・最大3件）。進捗タブ「苦手音トップ3」に使う。 */
  weakPhonemes: WeakPhonemeProfileEntry[];
  /** 克服した音素のARPAbetキー一覧（進捗タブの克服バッジに使う）。 */
  overcomePhonemes: string[];
  /** 苦手現象（scoreの高い順）。 */
  weakPhenomena: WeakPhenomenonEntry[];
  /** 繰り返し間違う単語（countの多い順・最大5件）。 */
  weakWords: WeakWordEntry[];
  /**
   * weakPhonemes集計に使ったAzure付き提出数（judge.azure.weakPhonemesを持つ提出の数）。
   * recommend.tsのコールドスタート判定（3件未満）や、進捗タブの「データ不足」判定に使う。
   */
  azureSubmissionCount: number;
  /** 直近最大5件のjudge付き提出のmatchRate平均（0-1）。データが無ければnull。 */
  recentMatchRateAvg: number | null;
}

/**
 * 提出データ・確認テスト結果から弱点プロファイルを構築する（DESIGN.md §8d）。
 * submissions/quizResultsの並び順は問わない（内部でcreatedAt順に並べ直す）。
 */
export function buildWeaknessProfile(submissions: Submission[], quizResults: QuizResult[]): WeaknessProfile {
  const azureSubmissionsDesc = submissions
    .filter((s) => (s.judge?.azure?.weakPhonemes?.length ?? 0) > 0)
    .sort((a, b) => b.createdAt - a.createdAt);

  const { weakPhonemes, overcomePhonemes } = buildPhonemeStats(azureSubmissionsDesc);

  return {
    weakPhonemes,
    overcomePhonemes,
    weakPhenomena: buildWeakPhenomena(submissions),
    weakWords: buildWeakWords(submissions, quizResults),
    azureSubmissionCount: azureSubmissionsDesc.length,
    recentMatchRateAvg: computeRecentMatchRateAvg(submissions),
  };
}

/**
 * 進捗タブ「苦手分析」セクションの表示可否判定用（DESIGN.md §8d: 「データ不足時は
 * 『提出が増えると分析が表示されます』」）。全カテゴリが空なら分析として見せるものが無い。
 */
export function isWeaknessProfileEmpty(profile: WeaknessProfile): boolean {
  return (
    profile.weakPhonemes.length === 0 &&
    profile.overcomePhonemes.length === 0 &&
    profile.weakPhenomena.length === 0 &&
    profile.weakWords.length === 0
  );
}

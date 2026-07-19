/**
 * 弱点プロファイルに基づく教材推薦（DESIGN.md §8d M13「弱点分析とパーソナライズ推薦」）。
 *
 * スコア = 苦手音素×phonemeCounts密度 + 苦手現象の練習機会数 + 苦手単語出現 + レベル適正。
 * 対象はdone以外のbundled教材（source: 'voa'）。プロファイルが薄い（Azure付き提出3件未満）
 * 間はコールドスタート（レベル順の未着手教材）にフォールバックする。
 *
 * 純関数のみを公開し、DOM/ブラウザAPIには依存しない（Vitestでテストする）。
 */

import { buildScriptWords, normalizeWord, type WordMark } from '../../lib/align';
import type { Material, MaterialProgress } from '../../lib/db';
import { detectPhenomena, type PhenomenonType } from '../../lib/phenomena';
import { phonemeDisplayName } from '../judge/phonemeAdvice';
import type { WeaknessProfile } from './weakness';

export interface MaterialRecommendation {
  material: Material;
  /** 推薦理由（1文・日本語）。 */
  reason: string;
}

/** プロファイルが薄い（Azure付き提出がこれ未満）とみなし、コールドスタートへフォールバックする閾値（DESIGN.md §8d）。 */
const COLD_START_MIN_AZURE_SUBMISSIONS = 3;
/** 上位何件を返すか（DESIGN.md §8d: 「上位2件」）。 */
const TOP_N = 2;

const PHONEME_WEIGHT = 3;
const PHENOMENON_WEIGHT = 2;
const WORD_WEIGHT = 2;
/** レベル適正が合致したときの加点（他の成分と混ぜても支配的になりすぎない程度の固定値）。 */
const LEVEL_FIT_BONUS = 0.6;

const LOW_MATCH_RATE_THRESHOLD = 0.6; // DESIGN.md §8d: 「直近平均一致率<60%→低レベル優先」
const HIGH_MATCH_RATE_THRESHOLD = 0.85; // DESIGN.md §8d: 「>85%→上へ」

const PHENOMENON_LABEL: Record<PhenomenonType, string> = {
  linking: '連結',
  flap: 'フラップ（tの軽い音）',
  elision: '脱落',
  weak: '弱形',
  ending: '語尾(-s/-ed)',
};

// ---- 対象教材の絞り込み ----

function isDone(progressByMaterial: Map<string, MaterialProgress>, materialId: string): boolean {
  return progressByMaterial.get(materialId)?.status === 'done';
}

/** DESIGN.md §8d: 「対象はdone以外のbundled対象」。source:'voa'（bundled）のみ、doneは除外する。 */
function selectCandidates(materials: Material[], progressByMaterial: Map<string, MaterialProgress>): Material[] {
  return materials.filter((m) => m.source === 'voa' && !isDone(progressByMaterial, m.id));
}

// ---- コールドスタート（DESIGN.md §8d） ----

function coldStartCandidates(candidates: Material[], progressByMaterial: Map<string, MaterialProgress>): Material[] {
  const notStarted = candidates.filter((m) => (progressByMaterial.get(m.id)?.status ?? 'not-started') === 'not-started');
  // 未着手が無い場合（既に全て手を付けている等）でも、done以外のcandidatesから選べるようにする安全策。
  return notStarted.length > 0 ? notStarted : candidates;
}

function sortByLevelThenOrder(materials: Material[]): Material[] {
  return [...materials].sort((a, b) => {
    // level=0（ローカル取り込み相当・bundledでは通常出ない）は最後に回す。
    const levelA = a.level === 0 ? Number.POSITIVE_INFINITY : a.level;
    const levelB = b.level === 0 ? Number.POSITIVE_INFINITY : b.level;
    if (levelA !== levelB) return levelA - levelB;
    const partA = a.part ?? 0;
    const partB = b.part ?? 0;
    if (partA !== partB) return partA - partB;
    return a.addedAt - b.addedAt;
  });
}

// ---- 苦手現象の練習機会数（DESIGN.md §8d: 「phenomena.tsの検出器を教材sentencesに適用」） ----

/**
 * 教材のスクリプトに、各音声現象の構造的な出現（=練習機会）が何箇所あるかを数える。
 * phenomena.tsの検出器はwordMarks（ok/missed/subの実際の判定結果）を前提にしているため、
 * 「全語がまだ言えていない（status:'missed'）」という仮のwordMarksを作って適用し、
 * 判定に依存せず構造的にパターンへ合致する箇所を全て拾う（=このスクリプトで practice できる回数）。
 *
 * 既知の制限: 'ending'（語尾-s/-ed）はスクリプト単独では検出できない（実際の誤認識語との
 * 語幹比較が前提のため）。この関数では常に0件になる。
 */
function countPhenomenonOpportunities(sentences: Material['sentences']): Map<PhenomenonType, number> {
  const scriptWords = buildScriptWords(sentences);
  const syntheticMarks: WordMark[] = scriptWords.map((w) => ({ word: w.word, si: w.si, status: 'missed' }));
  const issues = detectPhenomena(sentences, syntheticMarks);
  const counts = new Map<PhenomenonType, number>();
  for (const issue of issues) counts.set(issue.type, (counts.get(issue.type) ?? 0) + 1);
  return counts;
}

/** 教材のスクリプト中で、指定語（正規化して比較）が何回出現するかを数える。 */
function countWordOccurrences(sentences: Material['sentences'], targetWord: string): number {
  const normalizedTarget = normalizeWord(targetWord);
  if (normalizedTarget === '') return 0;
  return sentences.reduce((sum, s) => {
    const tokens = s.en.split(/\s+/).filter(Boolean);
    return sum + tokens.filter((t) => normalizeWord(t) === normalizedTarget).length;
  }, 0);
}

// ---- レベル適正 ----

function levelFitBonus(level: Material['level'], recentMatchRateAvg: number | null): number {
  if (recentMatchRateAvg === null || level === 0) return 0;
  if (recentMatchRateAvg < LOW_MATCH_RATE_THRESHOLD) {
    // 低レベル優先: レベル1に最大の加点、レベルが上がるほど加点を減らす。
    return level === 1 ? LEVEL_FIT_BONUS : level === 2 ? LEVEL_FIT_BONUS / 2 : 0;
  }
  if (recentMatchRateAvg > HIGH_MATCH_RATE_THRESHOLD) {
    // 上のレベルへ: レベル3に最大の加点。
    return level === 3 ? LEVEL_FIT_BONUS : level === 2 ? LEVEL_FIT_BONUS / 2 : 0;
  }
  return 0;
}

// ---- スコアリング ----

interface ScoredMaterial {
  material: Material;
  score: number;
  reason: string;
}

function scoreMaterial(material: Material, profile: WeaknessProfile): ScoredMaterial {
  const wordCountForDensity = Math.max(material.wordCount, 1);

  // 苦手音素×phonemeCounts密度
  let phonemeComponent = 0;
  let topPhoneme: { phoneme: string; count: number; contribution: number } | null = null;
  for (const wp of profile.weakPhonemes) {
    const count = material.phonemeCounts?.[wp.phoneme] ?? 0;
    if (count === 0) continue;
    const severity = Math.min(1, Math.max(0, (100 - wp.score) / 100));
    const contribution = severity * (count / wordCountForDensity);
    phonemeComponent += contribution;
    if (!topPhoneme || contribution > topPhoneme.contribution) topPhoneme = { phoneme: wp.phoneme, count, contribution };
  }

  // 苦手現象の練習機会数
  const opportunities = countPhenomenonOpportunities(material.sentences);
  const phenomenonScoreTotal = profile.weakPhenomena.reduce((sum, p) => sum + p.score, 0);
  let phenomenaComponent = 0;
  let topPhenomenon: { type: PhenomenonType; count: number; contribution: number } | null = null;
  if (phenomenonScoreTotal > 0) {
    for (const p of profile.weakPhenomena) {
      const count = opportunities.get(p.type) ?? 0;
      if (count === 0) continue;
      const weight = p.score / phenomenonScoreTotal;
      const contribution = weight * count;
      phenomenaComponent += contribution;
      if (!topPhenomenon || contribution > topPhenomenon.contribution) topPhenomenon = { type: p.type, count, contribution };
    }
  }

  // 苦手単語出現
  const weakWordTotal = profile.weakWords.reduce((sum, w) => sum + w.count, 0);
  let wordComponent = 0;
  let topWord: { word: string; count: number; contribution: number } | null = null;
  if (weakWordTotal > 0) {
    for (const w of profile.weakWords) {
      const occurrences = countWordOccurrences(material.sentences, w.word);
      if (occurrences === 0) continue;
      const weight = w.count / weakWordTotal;
      const contribution = weight * (occurrences / wordCountForDensity);
      wordComponent += contribution;
      if (!topWord || contribution > topWord.contribution) topWord = { word: w.word, count: occurrences, contribution };
    }
  }

  const levelBonus = levelFitBonus(material.level, profile.recentMatchRateAvg);

  const score =
    PHONEME_WEIGHT * phonemeComponent + PHENOMENON_WEIGHT * phenomenaComponent + WORD_WEIGHT * wordComponent + levelBonus;

  const reason = buildReason({ topPhoneme, topPhenomenon, topWord, levelBonus });

  return { material, score, reason };
}

function buildReason(parts: {
  topPhoneme: { phoneme: string; count: number } | null;
  topPhenomenon: { type: PhenomenonType; count: number } | null;
  topWord: { word: string; count: number } | null;
  levelBonus: number;
}): string {
  if (parts.topPhoneme) {
    return `苦手な${phonemeDisplayName(parts.topPhoneme.phoneme)}の練習になります（この教材に${parts.topPhoneme.count}回登場します）。`;
  }
  if (parts.topPhenomenon) {
    return `苦手な${PHENOMENON_LABEL[parts.topPhenomenon.type]}の練習機会が多い教材です（${parts.topPhenomenon.count}箇所）。`;
  }
  if (parts.topWord) {
    return `繰り返し間違えている「${parts.topWord.word}」が含まれています。`;
  }
  if (parts.levelBonus > 0) {
    return '今のレベルに合った教材です。';
  }
  return 'おすすめの教材です。';
}

// ---- 公開関数 ----

/**
 * 弱点プロファイルに基づき、教材を上位{@link TOP_N}件おすすめする（DESIGN.md §8d）。
 * プロファイルが薄い場合（Azure付き提出が{@link COLD_START_MIN_AZURE_SUBMISSIONS}件未満）は
 * コールドスタート（レベル順の未着手教材、reason=「まずはここから」）にフォールバックする。
 */
export function recommendMaterials(
  profile: WeaknessProfile,
  materials: Material[],
  progresses: MaterialProgress[],
): MaterialRecommendation[] {
  const progressByMaterial = new Map(progresses.map((p) => [p.materialId, p]));
  const candidates = selectCandidates(materials, progressByMaterial);
  if (candidates.length === 0) return [];

  if (profile.azureSubmissionCount < COLD_START_MIN_AZURE_SUBMISSIONS) {
    const ordered = sortByLevelThenOrder(coldStartCandidates(candidates, progressByMaterial));
    return ordered.slice(0, TOP_N).map((material) => ({ material, reason: 'まずはここから。' }));
  }

  const scored = candidates
    .map((m) => scoreMaterial(m, profile))
    // 同点はレベル・part・addedAtの決定論的な順で安定させる（全成分0（データがまだ薄い）等の
    // 稀なケースでも、呼び出しごとに順序がぶれないようにするため）。
    .sort((a, b) => b.score - a.score || (a.material.level || 99) - (b.material.level || 99) || a.material.addedAt - b.material.addedAt);

  return scored.slice(0, TOP_N).map((s) => ({ material: s.material, reason: s.reason }));
}

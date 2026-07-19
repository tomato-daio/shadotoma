/**
 * Azureの詳細データから日本語の短いコメントを最大3件生成する（DESIGN.md §8c M12「Azureコメント」）。
 *
 * 優先度順に評価し、上位から最大3件を採用する（該当なしなら肯定コメント1件のみ）:
 *   ① 苦手音素（平均60点未満・weakPhonemes） -- 各音素ごとに1件（phonemeAdvice.tsのコツ文つき）
 *   ② 流暢さ<75 かつ unexpectedBreaks>0
 *   ③ 抑揚が平坦（monotone）または韻律<70
 *   ④ 完全性<80
 * weakPhonemesは最大3件しか保存していないため（M12・azurePronunciation.ts computeWeakPhonemes）、
 * ①だけで3件の枠を使い切ることもある（②③④はその場合出さない）。
 *
 * 純関数のみを公開し、DOM/ブラウザAPIには依存しない。
 */

import type { AzurePronunciationResult } from '../../lib/db';
import { getPhonemeAdvice, phonemeDisplayName } from './phonemeAdvice';

const MAX_COMMENTS = 3;
const WEAK_PHONEME_SCORE_THRESHOLD = 60; // DESIGN.md §8c M12: 「低スコア音素（平均60点未満）」
const FLUENCY_THRESHOLD = 75;
const PROSODY_THRESHOLD = 70;
const COMPLETENESS_THRESHOLD = 80;

const POSITIVE_FALLBACK_COMMENT = '発音は安定しています。この調子で練習を続けましょう。';

/** ①苦手音素1件ぶんのコメント文言を組み立てる。辞書に無い音素は記号と例語のみでコツ文を付けない。 */
function buildWeakPhonemeComment(weakPhoneme: { phoneme: string; avgScore: number; examples: string[] }): string {
  const displayName = phonemeDisplayName(weakPhoneme.phoneme);
  const scoreText = `${Math.round(weakPhoneme.avgScore)}点`;
  const exampleText = weakPhoneme.examples.length > 0 ? `${weakPhoneme.examples.join('・')} ${scoreText}` : scoreText;
  const base = `${displayName}が苦手です（${exampleText}）`;

  const advice = getPhonemeAdvice(weakPhoneme.phoneme);
  return advice ? `${base}: ${advice.advice}` : `${base}。`;
}

/**
 * Azure発音評価の結果からコメントを最大3件生成する（DESIGN.md §8c M12）。
 * weakPhonemes/prosodyFeedbackが無い過去データ（M12以前の提出）でも呼び出しは壊れないが、
 * 呼び出し側（JudgeResultView）は「weakPhonemes等が無い場合は欄ごと非表示」にする方針のため、
 * 表示の可否はこの関数の外側で判定すること（本関数はデータがあればあるだけ使う）。
 */
export function generateAzureComments(azure: AzurePronunciationResult): string[] {
  const comments: string[] = [];

  // ① 苦手音素（平均60点未満）: 音素ごとに1件、コツ文つきで生成する。
  for (const weakPhoneme of azure.weakPhonemes ?? []) {
    if (comments.length >= MAX_COMMENTS) break;
    if (weakPhoneme.avgScore >= WEAK_PHONEME_SCORE_THRESHOLD) continue;
    comments.push(buildWeakPhonemeComment(weakPhoneme));
  }

  // ② 流暢さ<75 かつ unexpectedBreaks>0
  const unexpectedBreaks = azure.prosodyFeedback?.unexpectedBreaks ?? 0;
  if (comments.length < MAX_COMMENTS && azure.fluencyScore < FLUENCY_THRESHOLD && unexpectedBreaks > 0) {
    comments.push(`不要な間が${unexpectedBreaks}箇所ありました。区切らずに一息で発話することを意識してみましょう。`);
  }

  // ③ monotone（抑揚が平坦）または 韻律<70
  const isMonotone = azure.prosodyFeedback?.monotone ?? false;
  const isLowProsody = azure.prosodyScore !== undefined && azure.prosodyScore < PROSODY_THRESHOLD;
  if (comments.length < MAX_COMMENTS && (isMonotone || isLowProsody)) {
    comments.push('抑揚が平坦気味です。文の中で強く読む語とそうでない語の差を意識してみましょう。');
  }

  // ④ 完全性<80
  if (comments.length < MAX_COMMENTS && azure.completenessScore < COMPLETENESS_THRESHOLD) {
    comments.push('読み飛ばした語があるようです。スクリプトの語を1つも落とさず発話することを意識しましょう。');
  }

  // 該当なしなら肯定コメント1件のみ（DESIGN.md §8c M12）。
  if (comments.length === 0) {
    comments.push(POSITIVE_FALLBACK_COMMENT);
  }

  return comments.slice(0, MAX_COMMENTS);
}

/**
 * お手本音声と録音音声の比較（M15・DESIGN.md §8f）。
 *
 * segmentSpeech（発話区間列）とextractPitchStats（F0統計）から音声1本ぶんのプロファイルを作り、
 * お手本・録音の2プロファイルを速度/間(ポーズ)/抑揚の観点で突き合わせる純関数群。
 * 判定のしきい値はfeedback.tsの文言生成と共用するためexportする。
 */

import { segmentSpeech, type SpeechSegment } from './audio';
import { extractPitchStats, type PitchStats } from './pitch';

/** 発話中の間(ポーズ)1つぶん。 */
export interface SpeechPause {
  /** 音声先頭からの開始秒。 */
  startSec: number;
  durationSec: number;
}

/** 音声1本ぶんの解析プロファイル。 */
export interface SpeechProfile {
  /** 発話区間（先頭末尾の無音を除いた範囲）の長さ(秒)。WPMの分母と同じ定義。 */
  speechSpanSec: number;
  /** 発話区間内の間（連続無音 >= PAUSE_MIN_SEC）。 */
  pauses: SpeechPause[];
  /** F0統計。抽出不能（無音・雑音のみ等）ならnull。 */
  pitch: PitchStats | null;
}

/** お手本と録音の比較結果（JudgeResult.referenceComparisonとして保存する）。 */
export interface ReferenceComparison {
  /** 話速比 = 録音WPM / お手本WPM（どちらも発話区間ベース）。1未満=録音が遅い。 */
  speedRatio: number;
  userWpm: number;
  referenceWpm: number;
  userPauseCount: number;
  referencePauseCount: number;
  userLongestPauseSec: number;
  referenceLongestPauseSec: number;
  /** 半音標準偏差（抑揚の大きさ）。どちらか抽出不能ならその側undefined。 */
  userPitchSd?: number;
  referencePitchSd?: number;
}

/** これ以上の連続無音を「間(ポーズ)」と数える(秒)。 */
export const PAUSE_MIN_SEC = 0.35;
/** 録音の間の数がお手本より+この数以上多いとき「お手本に無い間がある」と指摘する。 */
export const EXTRA_PAUSE_COUNT_DIFF = 2;
/** 録音の半音SDがお手本のこの割合未満なら「平坦」と指摘する。 */
export const PITCH_FLAT_RATIO = 0.6;
/** 録音の半音SDがお手本のこの割合以上なら「お手本並みの抑揚」と褒める。 */
export const PITCH_GOOD_RATIO = 0.8;
/** お手本自体の半音SDがこの値未満（平坦な読み上げ）なら抑揚コメント自体をしない。 */
export const PITCH_MIN_MEANINGFUL_SD = 1.5;

/** 発話区間列から、区間同士の間隙のうちPAUSE_MIN_SEC以上のものを間(ポーズ)として列挙する。 */
function pausesFromSegments(segments: SpeechSegment[]): SpeechPause[] {
  const pauses: SpeechPause[] = [];
  for (let i = 1; i < segments.length; i++) {
    const gap = segments[i].startSec - segments[i - 1].endSec;
    if (gap >= PAUSE_MIN_SEC) {
      pauses.push({ startSec: segments[i - 1].endSec, durationSec: gap });
    }
  }
  return pauses;
}

/**
 * PCMから音声1本ぶんのプロファイルを組み立てる。発話区間が1つも無い場合はnull
 * （呼び出し側は比較なしに縮退する）。
 */
export function buildSpeechProfile(pcm: Float32Array, sampleRate: number): SpeechProfile | null {
  const segments = segmentSpeech(pcm, sampleRate);
  if (segments.length === 0) return null;
  const speechSpanSec = segments[segments.length - 1].endSec - segments[0].startSec;
  if (speechSpanSec <= 0) return null;
  return {
    speechSpanSec,
    pauses: pausesFromSegments(segments),
    pitch: extractPitchStats(pcm, sampleRate),
  };
}

/** お手本と録音のプロファイル+WPMから比較結果を組み立てる。 */
export function buildReferenceComparison(args: {
  userProfile: SpeechProfile;
  referenceProfile: SpeechProfile;
  userWpm: number;
  referenceWpm: number;
}): ReferenceComparison {
  const { userProfile, referenceProfile, userWpm, referenceWpm } = args;
  const longest = (pauses: SpeechPause[]): number =>
    pauses.reduce((max, p) => Math.max(max, p.durationSec), 0);
  return {
    speedRatio: referenceWpm > 0 ? userWpm / referenceWpm : 1,
    userWpm,
    referenceWpm,
    userPauseCount: userProfile.pauses.length,
    referencePauseCount: referenceProfile.pauses.length,
    userLongestPauseSec: longest(userProfile.pauses),
    referenceLongestPauseSec: longest(referenceProfile.pauses),
    userPitchSd: userProfile.pitch?.semitoneSd,
    referencePitchSd: referenceProfile.pitch?.semitoneSd,
  };
}

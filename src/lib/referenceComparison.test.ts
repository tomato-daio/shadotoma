import { describe, expect, it } from 'vitest';
import { buildReferenceComparison, buildSpeechProfile, type SpeechProfile } from './referenceComparison';

const SAMPLE_RATE = 16000;

function silence(sec: number): Float32Array {
  return new Float32Array(Math.round(sec * SAMPLE_RATE));
}

function tone(sec: number, amplitude = 0.5): Float32Array {
  const n = Math.round(sec * SAMPLE_RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE);
  }
  return out;
}

function concat(...chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

describe('buildSpeechProfile', () => {
  it('先頭末尾の無音を除いた発話区間長と、途中の間(>=0.35s)を検出する', () => {
    const pcm = concat(silence(0.5), tone(1.0), silence(0.6), tone(1.0), silence(0.5));
    const profile = buildSpeechProfile(pcm, SAMPLE_RATE);
    expect(profile).not.toBeNull();
    // 発話区間: 約0.5s〜3.1s = 約2.6s
    expect(profile!.speechSpanSec).toBeGreaterThan(2.3);
    expect(profile!.speechSpanSec).toBeLessThan(2.9);
    expect(profile!.pauses).toHaveLength(1);
    expect(profile!.pauses[0].durationSec).toBeGreaterThan(0.4);
    expect(profile!.pauses[0].durationSec).toBeLessThan(0.8);
    expect(profile!.pauses[0].startSec).toBeGreaterThan(1.3);
    expect(profile!.pauses[0].startSec).toBeLessThan(1.7);
    // 220Hzトーンなのでピッチも取れる
    expect(profile!.pitch).not.toBeNull();
  });

  it('0.35秒未満の間隙は間として数えない', () => {
    const pcm = concat(tone(1.0), silence(0.25), tone(1.0));
    const profile = buildSpeechProfile(pcm, SAMPLE_RATE);
    expect(profile).not.toBeNull();
    expect(profile!.pauses).toHaveLength(0);
  });

  it('無音のみはnullを返す', () => {
    expect(buildSpeechProfile(silence(2), SAMPLE_RATE)).toBeNull();
  });
});

describe('buildReferenceComparison', () => {
  const profile = (over: Partial<SpeechProfile> = {}): SpeechProfile => ({
    speechSpanSec: 10,
    pauses: [],
    pitch: null,
    ...over,
  });

  it('速度比・間の数・最長の間・ピッチSDをまとめる', () => {
    const comparison = buildReferenceComparison({
      userProfile: profile({
        pauses: [
          { startSec: 1, durationSec: 0.5 },
          { startSec: 3, durationSec: 1.2 },
        ],
        pitch: { medianHz: 120, semitoneSd: 1.0, voicedRatio: 0.7 },
      }),
      referenceProfile: profile({
        pauses: [{ startSec: 2, durationSec: 0.4 }],
        pitch: { medianHz: 180, semitoneSd: 2.5, voicedRatio: 0.8 },
      }),
      userWpm: 96,
      referenceWpm: 120,
    });
    expect(comparison.speedRatio).toBeCloseTo(0.8);
    expect(comparison.userPauseCount).toBe(2);
    expect(comparison.referencePauseCount).toBe(1);
    expect(comparison.userLongestPauseSec).toBeCloseTo(1.2);
    expect(comparison.referenceLongestPauseSec).toBeCloseTo(0.4);
    expect(comparison.userPitchSd).toBeCloseTo(1.0);
    expect(comparison.referencePitchSd).toBeCloseTo(2.5);
  });

  it('ピッチ抽出不能な側はundefinedになる', () => {
    const comparison = buildReferenceComparison({
      userProfile: profile(),
      referenceProfile: profile({ pitch: { medianHz: 180, semitoneSd: 2.0, voicedRatio: 0.8 } }),
      userWpm: 100,
      referenceWpm: 100,
    });
    expect(comparison.userPitchSd).toBeUndefined();
    expect(comparison.referencePitchSd).toBeCloseTo(2.0);
  });

  it('referenceWpmが0でも例外にならずspeedRatio=1にする', () => {
    const comparison = buildReferenceComparison({
      userProfile: profile(),
      referenceProfile: profile(),
      userWpm: 100,
      referenceWpm: 0,
    });
    expect(comparison.speedRatio).toBe(1);
  });
});

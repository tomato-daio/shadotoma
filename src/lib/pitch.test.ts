import { describe, expect, it } from 'vitest';
import { extractPitchStats } from './pitch';

const SAMPLE_RATE = 16000;

/** 指定周波数・秒数のサイン波を生成する。 */
function tone(freq: number, sec: number, amplitude = 0.5): Float32Array {
  const n = Math.round(sec * SAMPLE_RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE);
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

/** 決定的な疑似ホワイトノイズ（LCG。テストのflaky化を避けるためMath.randomは使わない）。 */
function noise(sec: number, amplitude = 0.5): Float32Array {
  const n = Math.round(sec * SAMPLE_RATE);
  const out = new Float32Array(n);
  let state = 123456789;
  for (let i = 0; i < n; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    out[i] = amplitude * ((state / 0x7fffffff) * 2 - 1);
  }
  return out;
}

describe('extractPitchStats', () => {
  it('220Hz正弦波はmedian≈220Hz・半音SDほぼ0になる', () => {
    const stats = extractPitchStats(tone(220, 2), SAMPLE_RATE);
    expect(stats).not.toBeNull();
    expect(stats!.medianHz).toBeGreaterThan(210);
    expect(stats!.medianHz).toBeLessThan(230);
    expect(stats!.semitoneSd).toBeLessThan(1);
    expect(stats!.voicedRatio).toBeGreaterThan(0.8);
  });

  it('150Hzと250Hzが半分ずつなら、半音SDは約4.4(=12·log2(250/150)/2)になる', () => {
    const stats = extractPitchStats(concat(tone(150, 1), tone(250, 1)), SAMPLE_RATE);
    expect(stats).not.toBeNull();
    expect(stats!.medianHz).toBeGreaterThan(140);
    expect(stats!.medianHz).toBeLessThan(260);
    expect(stats!.semitoneSd).toBeGreaterThan(2.9);
    expect(stats!.semitoneSd).toBeLessThan(5.9);
  });

  it('低め(110Hz)・高め(330Hz)でもオクターブ誤りせずmedianを推定できる', () => {
    const low = extractPitchStats(tone(110, 2), SAMPLE_RATE);
    expect(low).not.toBeNull();
    expect(low!.medianHz).toBeGreaterThan(100);
    expect(low!.medianHz).toBeLessThan(120);

    const high = extractPitchStats(tone(330, 2), SAMPLE_RATE);
    expect(high).not.toBeNull();
    expect(high!.medianHz).toBeGreaterThan(315);
    expect(high!.medianHz).toBeLessThan(345);
  });

  it('F0範囲未満の低周波(50Hzハム)のみは有声とみなさずnullを返す（境界アーティファクト対策）', () => {
    expect(extractPitchStats(tone(50, 2), SAMPLE_RATE)).toBeNull();
  });

  it('無音はnullを返す', () => {
    expect(extractPitchStats(new Float32Array(SAMPLE_RATE * 2), SAMPLE_RATE)).toBeNull();
    expect(extractPitchStats(new Float32Array(0), SAMPLE_RATE)).toBeNull();
  });

  it('ホワイトノイズのみは有声フレーム不足でnullを返す', () => {
    expect(extractPitchStats(noise(2), SAMPLE_RATE)).toBeNull();
  });

  it('サンプルレートが不正なら例外を投げずnullを返す', () => {
    expect(extractPitchStats(tone(220, 1), 0)).toBeNull();
    expect(extractPitchStats(tone(220, 1), Number.NaN)).toBeNull();
  });
});

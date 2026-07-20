import { describe, expect, it } from 'vitest';
import { segmentSpeech, speechBounds } from './audio';

const SAMPLE_RATE = 16000;

/** 指定秒数ぶんの無音(0)サンプルを生成する。 */
function silence(sec: number): Float32Array {
  return new Float32Array(Math.round(sec * SAMPLE_RATE));
}

/** 指定秒数ぶんの疑似音声（440Hzのサイン波、振幅0.5）を生成する。RMS窓の閾値を十分に超える。 */
function tone(sec: number, amplitude = 0.5): Float32Array {
  const n = Math.round(sec * SAMPLE_RATE);
  const out = new Float32Array(n);
  const freq = 440;
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

describe('speechBounds', () => {
  it('無音のみの録音はnullを返す', () => {
    const pcm = silence(2);
    expect(speechBounds(pcm, SAMPLE_RATE)).toBeNull();
  });

  it('空配列はnullを返す', () => {
    expect(speechBounds(new Float32Array(0), SAMPLE_RATE)).toBeNull();
  });

  it('先頭に無音があるとき、発話開始時刻をその後ろとして検出する（冒頭BGM等の待ち時間を除く）', () => {
    const pcm = concat(silence(1.5), tone(1.0));
    const bounds = speechBounds(pcm, SAMPLE_RATE);
    expect(bounds).not.toBeNull();
    expect(bounds!.startSec).toBeGreaterThan(1.0);
    expect(bounds!.startSec).toBeLessThan(1.6);
    // 末尾は録音の終わり付近（無音が続いていないため）
    expect(bounds!.endSec).toBeGreaterThan(2.4);
  });

  it('末尾に無音があるとき、発話終了時刻をその手前として検出する（停止ボタンまでの空白を除く）', () => {
    const pcm = concat(tone(1.0), silence(1.5));
    const bounds = speechBounds(pcm, SAMPLE_RATE);
    expect(bounds).not.toBeNull();
    expect(bounds!.startSec).toBeLessThan(0.2);
    expect(bounds!.endSec).toBeGreaterThan(0.9);
    expect(bounds!.endSec).toBeLessThan(1.2);
  });

  it('全区間が発話の場合、ほぼ録音全体を返す', () => {
    const pcm = tone(2.0);
    const bounds = speechBounds(pcm, SAMPLE_RATE);
    expect(bounds).not.toBeNull();
    expect(bounds!.startSec).toBeLessThan(0.05);
    expect(bounds!.endSec).toBeGreaterThan(1.95);
  });

  it('先頭・末尾の両方に無音があるとき、発話区間だけを切り出す', () => {
    const pcm = concat(silence(1.0), tone(1.0), silence(1.0));
    const bounds = speechBounds(pcm, SAMPLE_RATE);
    expect(bounds).not.toBeNull();
    expect(bounds!.startSec).toBeGreaterThan(0.9);
    expect(bounds!.startSec).toBeLessThan(1.1);
    expect(bounds!.endSec).toBeGreaterThan(1.9);
    expect(bounds!.endSec).toBeLessThan(2.1);
    // 発話区間の長さがおよそ1秒（前後無音を含まない）
    expect(bounds!.endSec - bounds!.startSec).toBeGreaterThan(0.85);
    expect(bounds!.endSec - bounds!.startSec).toBeLessThan(1.15);
  });

  it('短い突発ノイズ（数十ms）だけでは発話開始とみなさない', () => {
    // 30msの短いノイズ → 1.9秒の無音 → 1秒の実際の発話、という並び。
    // 冒頭の短いノイズに反応せず、実際の発話区間だけを検出できることを確認する。
    const pcm = concat(tone(0.03), silence(1.9), tone(1.0));
    const bounds = speechBounds(pcm, SAMPLE_RATE);
    expect(bounds).not.toBeNull();
    // 冒頭のノイズ(0付近)ではなく、後半の発話(1.93秒以降)が開始点として検出される
    expect(bounds!.startSec).toBeGreaterThan(1.8);
  });

  it('短い突発ノイズが発話の後にある場合、それを終了時刻に含めない', () => {
    // 1秒の発話 → 1.9秒の無音 → 30msの短いノイズ、という並び。
    const pcm = concat(tone(1.0), silence(1.9), tone(0.03));
    const bounds = speechBounds(pcm, SAMPLE_RATE);
    expect(bounds).not.toBeNull();
    // 末尾の短いノイズ(2.9秒付近)ではなく、最初の発話の終わり(1秒付近)が終了点として検出される
    expect(bounds!.endSec).toBeLessThan(1.2);
  });

  it('突発ノイズのみ（十分な長さの発話が無い）の場合はnullを返す', () => {
    const pcm = concat(silence(1.0), tone(0.03), silence(1.0));
    expect(speechBounds(pcm, SAMPLE_RATE)).toBeNull();
  });

  it('サンプルレートが不正なら例外を投げずnullを返す', () => {
    expect(speechBounds(tone(1.0), 0)).toBeNull();
    expect(speechBounds(tone(1.0), Number.NaN)).toBeNull();
  });
});

describe('segmentSpeech（M15: 発話区間の列）', () => {
  it('発話の途中に十分な無音があるとき、2つの区間に分かれる', () => {
    const pcm = concat(tone(1.0), silence(0.5), tone(1.0));
    const segments = segmentSpeech(pcm, SAMPLE_RATE);
    expect(segments).toHaveLength(2);
    expect(segments[0].startSec).toBeLessThan(0.1);
    expect(segments[0].endSec).toBeGreaterThan(0.9);
    expect(segments[0].endSec).toBeLessThan(1.2);
    expect(segments[1].startSec).toBeGreaterThan(1.4);
    expect(segments[1].startSec).toBeLessThan(1.6);
    expect(segments[1].endSec).toBeGreaterThan(2.4);
  });

  it('間隙が結合しきい値(0.15秒)未満なら1区間へ結合する（破裂音の閉鎖を間と数えない）', () => {
    const pcm = concat(tone(1.0), silence(0.1), tone(1.0));
    const segments = segmentSpeech(pcm, SAMPLE_RATE);
    expect(segments).toHaveLength(1);
    expect(segments[0].startSec).toBeLessThan(0.1);
    expect(segments[0].endSec).toBeGreaterThan(2.0);
  });

  it('無音のみ・突発ノイズのみは空配列を返す', () => {
    expect(segmentSpeech(silence(2), SAMPLE_RATE)).toHaveLength(0);
    expect(segmentSpeech(concat(silence(1.0), tone(0.03), silence(1.0)), SAMPLE_RATE)).toHaveLength(0);
  });

  it('speechBoundsはsegmentSpeechの先頭start〜末尾endと一致する', () => {
    const pcm = concat(silence(0.5), tone(0.8), silence(0.6), tone(0.8), silence(0.5));
    const segments = segmentSpeech(pcm, SAMPLE_RATE);
    const bounds = speechBounds(pcm, SAMPLE_RATE);
    expect(segments).toHaveLength(2);
    expect(bounds).toEqual({ startSec: segments[0].startSec, endSec: segments[1].endSec });
  });
});

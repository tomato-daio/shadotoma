import { describe, expect, it } from 'vitest';
import { clampRate, isValidABWindow, MIN_LOOP_WINDOW_SEC, resolveRestartTime } from './AudioPlayer';

describe('resolveRestartTime（ended後の自動リプレイ再開位置）', () => {
  it('A未設定なら0秒から再開する', () => {
    expect(resolveRestartTime(null, 30)).toBe(0);
  });

  it('A地点が通常の位置ならA地点から再開する', () => {
    expect(resolveRestartTime(5, 30)).toBe(5);
  });

  it('A地点が末尾ぎりぎり（残りが最小窓未満）なら0秒へフォールバックする（暴走ループ防止）', () => {
    expect(resolveRestartTime(29.8, 30)).toBe(0);
    expect(resolveRestartTime(30 - MIN_LOOP_WINDOW_SEC / 2, 30)).toBe(0);
  });

  it('A地点が末尾ちょうど・末尾超過でも0秒へフォールバックする', () => {
    expect(resolveRestartTime(30, 30)).toBe(0);
    expect(resolveRestartTime(35, 30)).toBe(0);
  });

  it('残りがちょうど最小窓ならA地点のまま', () => {
    expect(resolveRestartTime(30 - MIN_LOOP_WINDOW_SEC, 30)).toBe(30 - MIN_LOOP_WINDOW_SEC);
  });

  it('負のA地点は0に丸める', () => {
    expect(resolveRestartTime(-3, 30)).toBe(0);
  });

  it('durationが未確定(NaN/Infinity/0)のときはA地点をそのまま使う', () => {
    expect(resolveRestartTime(5, NaN)).toBe(5);
    expect(resolveRestartTime(5, Infinity)).toBe(5);
    expect(resolveRestartTime(5, 0)).toBe(5);
  });
});

describe('isValidABWindow（AB区間の有効判定）', () => {
  it('A・Bどちらかが未設定なら無効', () => {
    expect(isValidABWindow(null, null)).toBe(false);
    expect(isValidABWindow(3, null)).toBe(false);
    expect(isValidABWindow(null, 8)).toBe(false);
  });

  it('A≧Bの退化区間は無効（timeupdate毎にAへ戻り続けるライブロック防止）', () => {
    expect(isValidABWindow(8, 3)).toBe(false);
    expect(isValidABWindow(5, 5)).toBe(false);
  });

  it('区間が最小窓未満なら無効', () => {
    expect(isValidABWindow(3, 3 + MIN_LOOP_WINDOW_SEC / 2)).toBe(false);
  });

  it('A<Bかつ最小窓以上なら有効', () => {
    expect(isValidABWindow(3, 3 + MIN_LOOP_WINDOW_SEC)).toBe(true);
    expect(isValidABWindow(0, 10)).toBe(true);
  });
});

describe('clampRate', () => {
  it('範囲外の速度を0.5〜2.0にクランプする', () => {
    expect(clampRate(0.1)).toBeCloseTo(0.5);
    expect(clampRate(3)).toBeCloseTo(2.0);
  });

  it('0.05刻みに丸める', () => {
    expect(clampRate(0.87)).toBeCloseTo(0.85);
    expect(clampRate(1.13)).toBeCloseTo(1.15);
  });
});

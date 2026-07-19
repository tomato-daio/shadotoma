import { describe, expect, it } from 'vitest';
import { PHONEME_ADVICE, TARGET_PHONEME_KEYS, getPhonemeAdvice, phonemeDisplayName } from './phonemeAdvice';

describe('PHONEME_ADVICE', () => {
  it('15種程度（DESIGN.md §8c M12）のエントリを持つ', () => {
    expect(TARGET_PHONEME_KEYS.length).toBeGreaterThanOrEqual(14);
    expect(TARGET_PHONEME_KEYS.length).toBeLessThanOrEqual(16);
  });

  it('各エントリはkey/displayName/adviceを全て持ち、キーは大文字ARPAbet表記', () => {
    for (const key of TARGET_PHONEME_KEYS) {
      const entry = PHONEME_ADVICE[key];
      expect(entry.key).toBe(key);
      expect(key).toBe(key.toUpperCase());
      expect(entry.displayName.length).toBeGreaterThan(0);
      expect(entry.advice.length).toBeGreaterThan(0);
    }
  });

  it('代表的な音（R/TH/AE）を含む', () => {
    expect(TARGET_PHONEME_KEYS).toContain('R');
    expect(TARGET_PHONEME_KEYS).toContain('TH');
    expect(TARGET_PHONEME_KEYS).toContain('AE');
  });
});

describe('getPhonemeAdvice', () => {
  it('辞書にあるキーはエントリを返す', () => {
    expect(getPhonemeAdvice('R')?.displayName).toBe('rの音');
  });

  it('辞書に無いキーはundefined', () => {
    expect(getPhonemeAdvice('ZZ')).toBeUndefined();
  });
});

describe('phonemeDisplayName', () => {
  it('辞書にあるキーは表示名を返す', () => {
    expect(phonemeDisplayName('TH')).toBe('thの音（無声・think等）');
  });

  it('辞書に無いキーは「{キー}の音」にフォールバックする', () => {
    expect(phonemeDisplayName('NG')).toBe('NGの音');
  });
});

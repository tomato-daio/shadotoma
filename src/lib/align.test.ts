import { describe, expect, it } from 'vitest';
import { alignWords, buildScriptWords, normalizeWord, type ScriptWord } from './align';

describe('normalizeWord', () => {
  it('大文字小文字を同一視する', () => {
    expect(normalizeWord('Korea')).toBe(normalizeWord('korea'));
  });

  it('前後の約物を除去する', () => {
    expect(normalizeWord('Korea,')).toBe('korea');
    expect(normalizeWord('"Hello."')).toBe('hello');
    expect(normalizeWord('(fusion)')).toBe('fusion');
  });

  it('短縮形のアポストロフィ有無を同一視する', () => {
    expect(normalizeWord("don't")).toBe(normalizeWord('dont'));
    expect(normalizeWord("Korea's")).toBe(normalizeWord('koreas'));
  });

  it('カーリークォートの短縮形も同一視する', () => {
    expect(normalizeWord('don’t')).toBe(normalizeWord("don't"));
  });

  it('数字表記のカンマ区切りを同一視する', () => {
    expect(normalizeWord('238,300')).toBe('238300');
    expect(normalizeWord('238,300,')).toBe('238300');
  });

  it('小数点はそのまま保持する', () => {
    expect(normalizeWord('3.5')).toBe('3.5');
  });

  it('スペルアウトされた小さい数字語を数字表記に揃える', () => {
    expect(normalizeWord('three')).toBe('3');
    expect(normalizeWord('Three')).toBe('3');
    expect(normalizeWord('twenty')).toBe('20');
  });

  it('空文字列は空文字列を返す', () => {
    expect(normalizeWord('---')).toBe('');
  });
});

describe('buildScriptWords', () => {
  it('文indexつきの単語配列を組み立てる', () => {
    const words = buildScriptWords([{ en: 'Hello world.' }, { en: 'Nice to meet you.' }]);
    expect(words).toEqual([
      { word: 'Hello', si: 0 },
      { word: 'world.', si: 0 },
      { word: 'Nice', si: 1 },
      { word: 'to', si: 1 },
      { word: 'meet', si: 1 },
      { word: 'you.', si: 1 },
    ]);
  });
});

function scriptWordsFrom(words: string[]): ScriptWord[] {
  return words.map((word, i) => ({ word, si: i < 3 ? 0 : 1 }));
}

describe('alignWords', () => {
  it('完全一致: すべてokになる', () => {
    const script = scriptWordsFrom(['Hello', 'world', 'today.']);
    const result = alignWords(script, ['hello', 'world', 'today']);

    expect(result.wordMarks).toEqual([
      { word: 'Hello', si: 0, status: 'ok' },
      { word: 'world', si: 0, status: 'ok' },
      { word: 'today.', si: 0, status: 'ok' },
    ]);
    expect(result.insertions).toEqual([]);
    expect(result.matchedCount).toBe(3);
  });

  it('部分欠落: 発話されなかった語がmissedになる', () => {
    const script = scriptWordsFrom(['The', 'quick', 'brown', 'fox', 'jumps']);
    const result = alignWords(script, ['the', 'quick', 'fox', 'jumps']);

    expect(result.wordMarks.map((w) => w.status)).toEqual(['ok', 'ok', 'missed', 'ok', 'ok']);
    expect(result.wordMarks[2].word).toBe('brown');
    expect(result.matchedCount).toBe(4);
    expect(result.insertions).toEqual([]);
  });

  it('置換: 別の語に言い換えられた場合はsubになる', () => {
    const script = scriptWordsFrom(['I', 'like', 'cats']);
    const result = alignWords(script, ['i', 'like', 'dogs']);

    expect(result.wordMarks).toEqual([
      { word: 'I', si: 0, status: 'ok' },
      { word: 'like', si: 0, status: 'ok' },
      { word: 'cats', si: 0, status: 'sub', recognized: 'dogs' },
    ]);
    expect(result.insertions).toEqual([]);
  });

  it('認識ゼロ: 認識語が無ければ全語がmissedになる', () => {
    const script = scriptWordsFrom(['Hello', 'world']);
    const result = alignWords(script, []);

    expect(result.wordMarks).toEqual([
      { word: 'Hello', si: 0, status: 'missed' },
      { word: 'world', si: 0, status: 'missed' },
    ]);
    expect(result.matchedCount).toBe(0);
    expect(result.insertions).toEqual([]);
  });

  it('スクリプトに無い挿入語: 余分な発話語はinsertionsに入り、他の語をsub扱いしない', () => {
    const script = scriptWordsFrom(['I', 'am', 'happy']);
    const result = alignWords(script, ['i', 'am', 'very', 'happy']);

    expect(result.wordMarks).toEqual([
      { word: 'I', si: 0, status: 'ok' },
      { word: 'am', si: 0, status: 'ok' },
      { word: 'happy', si: 0, status: 'ok' },
    ]);
    expect(result.insertions).toEqual(['very']);
    expect(result.matchedCount).toBe(3);
  });

  it('スクリプトが空なら全認識語が挿入語になる', () => {
    const result = alignWords([], ['hello', 'world']);
    expect(result.wordMarks).toEqual([]);
    expect(result.insertions).toEqual(['hello', 'world']);
  });

  it('数字と短縮形の揺れを吸収してokと判定する', () => {
    const script = scriptWordsFrom(["We'll", 'need', 'three']);
    const result = alignWords(script, ['well', 'need', '3']);

    expect(result.wordMarks.map((w) => w.status)).toEqual(['ok', 'ok', 'ok']);
  });

  it('文をまたぐ複数文でも文index(si)を保持する', () => {
    const script = buildScriptWords([{ en: 'Hello world.' }, { en: 'See you soon.' }]);
    const result = alignWords(script, ['hello', 'world', 'see', 'you', 'soon']);

    expect(result.wordMarks.filter((w) => w.si === 1).map((w) => w.word)).toEqual(['See', 'you', 'soon.']);
    expect(result.matchedCount).toBe(5);
  });
});

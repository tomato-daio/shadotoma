import { describe, expect, it } from 'vitest';
import type { Sentence } from './db';
import {
  applyAnnotations,
  buildTranslationPrompt,
  mergeSentenceAnnotations,
  parseTranslationResponse,
} from './scriptAnnotations';

const SENTENCES: Sentence[] = [{ en: 'We often project our current feelings.' }, { en: "They won't last forever." }];

function validResponse(): string {
  return JSON.stringify({
    sentences: [
      { i: 1, ja: '私たちは今の感情を投影しがちです。', vocab: [{ term: 'project', ja: '投影する' }] },
      { i: 2, ja: 'それは永遠には続きません。', vocab: [] },
    ],
  });
}

describe('buildTranslationPrompt', () => {
  it('番号付きの全文とJSON形式の指定を含む', () => {
    const prompt = buildTranslationPrompt({ title: 'Test Article', sentences: SENTENCES });
    expect(prompt).toContain('【教材】Test Article');
    expect(prompt).toContain('1. We often project our current feelings.');
    expect(prompt).toContain("2. They won't last forever.");
    expect(prompt).toContain('"sentences"');
    expect(prompt).toContain('全2文');
  });
});

describe('parseTranslationResponse', () => {
  it('正常なJSONを解析できる', () => {
    const result = parseTranslationResponse(validResponse(), 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.annotations).toHaveLength(2);
    expect(result.annotations[0].ja).toBe('私たちは今の感情を投影しがちです。');
    expect(result.annotations[0].vocab).toEqual([{ term: 'project', ja: '投影する' }]);
    expect(result.annotations[1].vocab).toEqual([]);
  });

  it('コードフェンス付きの返答も解析できる', () => {
    const text = '```json\n' + validResponse() + '\n```';
    const result = parseTranslationResponse(text, 2);
    expect(result.ok).toBe(true);
  });

  it('前後に説明文が付いた返答も解析できる', () => {
    const text = 'はい、こちらが結果です。\n' + validResponse() + '\n以上です。';
    const result = parseTranslationResponse(text, 2);
    expect(result.ok).toBe(true);
  });

  it('JSONとして読めないテキストはエラーにする', () => {
    const result = parseTranslationResponse('すみません、できませんでした。', 2);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('JSON');
  });

  it('sentences配列が無いJSONはエラーにする', () => {
    const result = parseTranslationResponse('{"translations": []}', 2);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('sentences');
  });

  it('文数不一致は期待数・実際数入りのエラーにする', () => {
    const text = JSON.stringify({ sentences: [{ i: 1, ja: '訳' }] });
    const result = parseTranslationResponse(text, 2);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('2文');
    expect(result.error).toContain('1文');
  });

  it('iの順序がバラバラでもi順に整列する', () => {
    const text = JSON.stringify({
      sentences: [
        { i: 2, ja: '2番目の訳', vocab: [] },
        { i: 1, ja: '1番目の訳', vocab: [] },
      ],
    });
    const result = parseTranslationResponse(text, 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.annotations[0].ja).toBe('1番目の訳');
    expect(result.annotations[1].ja).toBe('2番目の訳');
  });

  it('iが不正（重複・範囲外・非数値）なら配列順をそのまま使う', () => {
    const text = JSON.stringify({
      sentences: [
        { i: 5, ja: '先頭の訳', vocab: [] },
        { i: 5, ja: '2番目の訳', vocab: [] },
      ],
    });
    const result = parseTranslationResponse(text, 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.annotations[0].ja).toBe('先頭の訳');
  });

  it('vocabの不正要素（term/ja欠落・空文字）は除外し、上限を超えたら切り詰める', () => {
    const text = JSON.stringify({
      sentences: [
        {
          i: 1,
          ja: '訳',
          vocab: [
            { term: 'ok1', ja: '良い1' },
            { term: '', ja: '空term' },
            { ja: 'termなし' },
            'ただの文字列',
            { term: 'ok2', ja: '良い2' },
            { term: 'ok3', ja: '良い3' },
            { term: 'ok4', ja: '良い4' },
            { term: 'ok5', ja: '良い5' },
            { term: 'over', ja: '6個目' },
          ],
        },
        { i: 2, ja: '訳2', vocab: [] },
      ],
    });
    const result = parseTranslationResponse(text, 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.annotations[0].vocab).toHaveLength(5);
    expect(result.annotations[0].vocab.map((v) => v.term)).toEqual(['ok1', 'ok2', 'ok3', 'ok4', 'ok5']);
  });

  it('jaが空文字・欠落の文はja undefinedとして受け入れる', () => {
    const text = JSON.stringify({
      sentences: [
        { i: 1, ja: '  ', vocab: [] },
        { i: 2, vocab: [{ term: 'last', ja: '続く' }] },
      ],
    });
    const result = parseTranslationResponse(text, 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.annotations[0].ja).toBeUndefined();
    expect(result.annotations[1].ja).toBeUndefined();
    expect(result.annotations[1].vocab).toHaveLength(1);
  });
});

describe('applyAnnotations', () => {
  it('enを変えずにja/vocabを適用する', () => {
    const result = parseTranslationResponse(validResponse(), 2);
    if (!result.ok) throw new Error('unexpected');
    const applied = applyAnnotations(SENTENCES, result.annotations);
    expect(applied[0].en).toBe(SENTENCES[0].en);
    expect(applied[0].ja).toBe('私たちは今の感情を投影しがちです。');
    expect(applied[0].vocab).toEqual([{ term: 'project', ja: '投影する' }]);
    // 元の配列は変更しない
    expect(SENTENCES[0].ja).toBeUndefined();
  });

  it('返答側に値が無い項目は既存の値を残す', () => {
    const existing: Sentence[] = [{ en: 'Hello.', ja: '既存の訳', vocab: [{ term: 'hello', ja: 'こんにちは' }] }];
    const applied = applyAnnotations(existing, [{ ja: undefined, vocab: [] }]);
    expect(applied[0].ja).toBe('既存の訳');
    expect(applied[0].vocab).toEqual([{ term: 'hello', ja: 'こんにちは' }]);
  });
});

describe('mergeSentenceAnnotations（バンドル教材同期時の引き継ぎ）', () => {
  it('enが一致する文の訳・語彙を新レコードへ引き継ぐ', () => {
    const existing: Sentence[] = [{ en: 'Hello world.', ja: 'こんにちは世界。', vocab: [{ term: 'world', ja: '世界' }] }];
    const incoming: Sentence[] = [{ en: 'Hello world.' }];
    const merged = mergeSentenceAnnotations(existing, incoming);
    expect(merged[0].ja).toBe('こんにちは世界。');
    expect(merged[0].vocab).toEqual([{ term: 'world', ja: '世界' }]);
  });

  it('enが変わった文（再分割等）は引き継がない', () => {
    const existing: Sentence[] = [{ en: 'Old sentence.', ja: '古い訳' }];
    const incoming: Sentence[] = [{ en: 'New sentence.' }];
    const merged = mergeSentenceAnnotations(existing, incoming);
    expect(merged[0].ja).toBeUndefined();
  });

  it('incoming側が既に訳を持つ場合はincomingを優先する', () => {
    const existing: Sentence[] = [{ en: 'Hello world.', ja: '古い訳' }];
    const incoming: Sentence[] = [{ en: 'Hello world.', ja: '新しい訳' }];
    const merged = mergeSentenceAnnotations(existing, incoming);
    expect(merged[0].ja).toBe('新しい訳');
  });

  it('文数が増減しても対応するindexの範囲だけ処理する', () => {
    const existing: Sentence[] = [{ en: 'One.', ja: '1' }];
    const incoming: Sentence[] = [{ en: 'One.' }, { en: 'Two.' }];
    const merged = mergeSentenceAnnotations(existing, incoming);
    expect(merged).toHaveLength(2);
    expect(merged[0].ja).toBe('1');
    expect(merged[1].ja).toBeUndefined();
  });
});

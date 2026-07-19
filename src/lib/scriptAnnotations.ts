/**
 * スクリプトへの日本語訳・重要語彙の付与（クリップボード往復方式）。
 *
 * LLM APIは使わず、依頼プロンプトを組み立ててクリップボードへコピー →
 * ユーザーがChatGPT/Claude等に貼り付け → 返ってきたJSONをアプリへ貼り戻す、という
 * clipboardFallback.tsと同じ「外部へは一切送信しない」方式を取る。
 * このモジュールはプロンプト生成・貼り戻しJSONの解析/検証・教材への適用を担う純関数のみ。
 */

import type { Sentence, VocabItem } from './db';

/** 1文に付与された訳・語彙（貼り戻しJSONの解析結果）。 */
export interface SentenceAnnotation {
  ja?: string;
  vocab: VocabItem[];
}

export type ParseTranslationResult =
  | { ok: true; annotations: SentenceAnnotation[] }
  | { ok: false; error: string };

/** 1文あたりの語彙の上限。依頼では0〜3個を求めるが、多めに返されても切り詰めて受け入れる。 */
const MAX_VOCAB_PER_SENTENCE = 5;

/** ChatGPT/Claude等に貼り付ける依頼プロンプトを組み立てる。 */
export function buildTranslationPrompt({ title, sentences }: { title: string; sentences: Sentence[] }): string {
  const n = sentences.length;
  const numbered = sentences.map((s, i) => `${i + 1}. ${s.en}`).join('\n');
  return [
    '英語シャドーイング教材のスクリプトに、日本語訳と重要語彙を付けてください。',
    '',
    `【教材】${title}`,
    `【スクリプト（全${n}文・番号付き）】`,
    numbered,
    '',
    '次の形式のJSONだけを出力してください（コードブロックや説明文は不要です）。',
    '{"sentences":[{"i":1,"ja":"この文の自然な日本語訳","vocab":[{"term":"重要な単語や熟語","ja":"意味"}]}]}',
    '',
    `- 全${n}文について、iを1〜${n}の連番で必ず出力する`,
    '- jaは英語学習者向けの自然な日本語訳にする',
    '- vocabはその文の重要な単語・熟語を0〜3個（無ければ[]）。termはスクリプト中の表記のまま書く',
  ].join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * 貼り付けテキストからJSONを取り出す。全体のparseに失敗したら、コードフェンスや前後の説明文を
 * 想定して最初の `{` 〜最後の `}` を切り出して再試行する。
 */
function tryParseJson(text: string): { value: unknown } | null {
  const candidates = [text.trim()];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    candidates.push(text.slice(start, end + 1));
  }
  for (const candidate of candidates) {
    try {
      return { value: JSON.parse(candidate) };
    } catch {
      // 次の候補を試す
    }
  }
  return null;
}

function sanitizeVocab(raw: unknown): VocabItem[] {
  if (!Array.isArray(raw)) return [];
  const items: VocabItem[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const term = typeof entry.term === 'string' ? entry.term.trim() : '';
    const ja = typeof entry.ja === 'string' ? entry.ja.trim() : '';
    if (!term || !ja) continue;
    items.push({ term, ja });
    if (items.length >= MAX_VOCAB_PER_SENTENCE) break;
  }
  return items;
}

/**
 * AIの返答テキストを解析して文ごとの訳・語彙に変換する。
 * 不正JSONと文数不一致は別々の日本語エラーメッセージで返す（ユーザーが対処法を判断できるように）。
 */
export function parseTranslationResponse(text: string, sentenceCount: number): ParseTranslationResult {
  const parsed = tryParseJson(text);
  if (!parsed) {
    return {
      ok: false,
      error: '貼り付けた内容をJSONとして読み取れませんでした。AIの返答のJSON部分をそのまま貼り付けてください。',
    };
  }
  const root = parsed.value;
  const rawSentences = isRecord(root) ? root.sentences : undefined;
  if (!Array.isArray(rawSentences)) {
    return {
      ok: false,
      error: 'JSONに sentences 配列が見つかりません。依頼文で指定した形式の返答を貼り付けてください。',
    };
  }
  if (rawSentences.length !== sentenceCount) {
    return {
      ok: false,
      error: `文の数が一致しません（この教材は${sentenceCount}文ですが、返答は${rawSentences.length}文でした）。依頼文をもう一度コピーして全文ぶんの返答をもらってください。`,
    };
  }

  const entries = rawSentences.map((raw) => (isRecord(raw) ? raw : {}));
  // iが全て1〜Nの一意な整数として揃っていればi順に整列する。揃っていなければ配列順をそのまま使う。
  const indices = entries.map((e) => e.i);
  const useIndexOrder =
    indices.every((i): i is number => typeof i === 'number' && Number.isInteger(i) && i >= 1 && i <= sentenceCount) &&
    new Set(indices).size === sentenceCount;
  const ordered = useIndexOrder ? [...entries].sort((a, b) => (a.i as number) - (b.i as number)) : entries;

  const annotations = ordered.map((e) => {
    const ja = typeof e.ja === 'string' && e.ja.trim().length > 0 ? e.ja.trim() : undefined;
    return { ja, vocab: sanitizeVocab(e.vocab) };
  });
  return { ok: true, annotations };
}

/**
 * 解析済みの訳・語彙を文へ適用する（enは変更しない）。
 * 返答側に値が無い項目は既存の値を残す（部分的な再取り込みで訳が消えないように）。
 */
export function applyAnnotations(sentences: Sentence[], annotations: SentenceAnnotation[]): Sentence[] {
  return sentences.map((s, i) => {
    const a = annotations[i];
    if (!a) return s;
    const next: Sentence = { ...s };
    if (a.ja !== undefined) next.ja = a.ja;
    if (a.vocab.length > 0) next.vocab = a.vocab;
    return next;
  });
}

/**
 * バンドル教材の同期（index.jsonからの丸ごと上書き）時に、既存レコードへ後付けした訳・語彙を
 * 新レコードへ引き継ぐ。同一indexで en が一致（trim比較）する文だけ引き継ぎ、
 * 記事の再分割などで文が変わった箇所は破棄する（古い訳を誤った文に付けないため）。
 */
export function mergeSentenceAnnotations(existing: Sentence[], incoming: Sentence[]): Sentence[] {
  return incoming.map((s, i) => {
    const prev = existing[i];
    if (!prev || prev.en.trim() !== s.en.trim()) return s;
    const merged: Sentence = { ...s };
    if (merged.ja === undefined && prev.ja !== undefined) merged.ja = prev.ja;
    if (merged.vocab === undefined && prev.vocab !== undefined) merged.vocab = prev.vocab;
    return merged;
  });
}

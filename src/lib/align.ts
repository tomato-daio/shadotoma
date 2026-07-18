/**
 * スクリプト語列 vs Whisper認識語列のアライン（DESIGN.md §8手順3）。
 *
 * 正規化した単語同士をNeedleman-Wunsch法（一致+1/不一致-1/ギャップ-1）でグローバルアラインし、
 * スクリプト側の各単語に ok（一致）/ missed（欠落）/ sub（別の語に置換）を付与する。
 * スクリプトに無い挿入語（ユーザーが余分に発話した語、または認識誤り）は `insertions` に集める。
 *
 * 純関数のみを公開し、DOM/ブラウザAPIには依存しない。
 */

export type WordStatus = 'ok' | 'missed' | 'sub';

export interface WordMark {
  /** スクリプト上の元の表記（大文字小文字・約物を保持した表示用テキスト）。 */
  word: string;
  /** 文index（Material.sentencesのインデックス）。 */
  si: number;
  status: WordStatus;
}

export interface ScriptWord {
  word: string;
  si: number;
}

export interface AlignResult {
  /** スクリプトの語順のまま、各語にok/missed/subを付与したもの。 */
  wordMarks: WordMark[];
  /** スクリプトに対応が無い認識語（挿入語）。表示用の原文のまま。 */
  insertions: string[];
  /** status==='ok' の件数（matchRate計算に使う）。 */
  matchedCount: number;
}

/**
 * スペルアウトされた小さい数字語 → 数字表記の対応（単独トークンのみ対応する簡易的な揺れ吸収）。
 * 例: "three" と "3" が同じ語として扱われる。複数語にまたがる数字（"twenty five" 等）や
 * 序数（"third"）は対象外（既知の制限）。
 */
const NUMBER_WORDS: Record<string, string> = {
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
  eleven: '11',
  twelve: '12',
  thirteen: '13',
  fourteen: '14',
  fifteen: '15',
  sixteen: '16',
  seventeen: '17',
  eighteen: '18',
  nineteen: '19',
  twenty: '20',
  thirty: '30',
  forty: '40',
  fifty: '50',
  sixty: '60',
  seventy: '70',
  eighty: '80',
  ninety: '90',
  hundred: '100',
  thousand: '1000',
  million: '1000000',
};

/** タイポグラフィック文字（カーリークォート・ダッシュ等）をASCII相当へ寄せる。 */
function toAsciiPunctuation(s: string): string {
  return s
    .replace(/[‘’ʼʹ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-');
}

/**
 * 単語を比較用に正規化する。
 *
 * 同一視する揺れ:
 * - 大文字/小文字（"Korea" と "korea"）
 * - 前後の約物（引用符・カンマ・ピリオド・カッコ等。"Korea," と "Korea"）
 * - 短縮形のアポストロフィ有無（"don't" と "dont"、"Korea's" と "Koreas"）
 * - 数字表記のカンマ区切り（"238,300" と "238300"）
 * - スペルアウトされた小さい数字語と数字表記（"three" と "3"。単独トークンのみ）
 *
 * 対象外（既知の制限）: 複数語にまたがる数字（"twenty five" vs "25"）、
 * 複数語への短縮形展開（"won't" vs "will not"）。
 */
export function normalizeWord(raw: string): string {
  let w = toAsciiPunctuation(raw).toLowerCase();

  // 前後の約物（英数字以外）を除去する
  w = w.replace(/^[^a-z0-9]+/, '').replace(/[^a-z0-9]+$/, '');

  if (w.length === 0) return '';

  // 数字表記（カンマ区切り・小数点を許容）: カンマを除去して正規化
  if (/^\d[\d,]*(\.\d+)?$/.test(w)) {
    return w.replace(/,/g, '');
  }

  // 短縮形: 内部のアポストロフィを除去する（"don't"->"dont", "korea's"->"koreas"）
  w = w.replace(/'/g, '');

  // スペルアウトされた小さい数字語 -> 数字表記
  const asNumber = NUMBER_WORDS[w];
  if (asNumber !== undefined) return asNumber;

  return w;
}

/** Material.sentencesから、文indexつきの単語配列を組み立てる。 */
export function buildScriptWords(sentences: { en: string }[]): ScriptWord[] {
  const words: ScriptWord[] = [];
  sentences.forEach((sentence, si) => {
    for (const word of sentence.en.split(/\s+/)) {
      if (word.length > 0) words.push({ word, si });
    }
  });
  return words;
}

const MATCH_SCORE = 1;
const MISMATCH_SCORE = -1;
const GAP_SCORE = -1;

/**
 * スクリプト語列と認識語列をNeedleman-Wunsch法でグローバルアラインする。
 *
 * @param scriptWords スクリプト側の単語列（文indexつき）。
 * @param recognizedWords Whisperの認識結果を空白分割した単語列（表示用の原文のまま）。
 */
export function alignWords(scriptWords: ScriptWord[], recognizedWords: string[]): AlignResult {
  const n = scriptWords.length;
  const m = recognizedWords.length;
  const scriptNorm = scriptWords.map((w) => normalizeWord(w.word));
  const recognizedNorm = recognizedWords.map((w) => normalizeWord(w));

  // dp[i][j] = scriptNorm[0..i) と recognizedNorm[0..j) をアラインした場合の最良スコア
  const dp: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = 1; i <= n; i++) dp[i][0] = dp[i - 1][0] + GAP_SCORE;
  for (let j = 1; j <= m; j++) dp[0][j] = dp[0][j - 1] + GAP_SCORE;

  for (let i = 1; i <= n; i++) {
    const row = dp[i];
    const prevRow = dp[i - 1];
    for (let j = 1; j <= m; j++) {
      const isMatch = scriptNorm[i - 1] === recognizedNorm[j - 1];
      const diag = prevRow[j - 1] + (isMatch ? MATCH_SCORE : MISMATCH_SCORE);
      const up = prevRow[j] + GAP_SCORE; // スクリプト語を認識語に対応させない -> missed
      const left = row[j - 1] + GAP_SCORE; // 認識語をスクリプト語に対応させない -> insertion
      row[j] = Math.max(diag, up, left);
    }
  }

  // トレースバック（末尾から先頭へ）。同点の場合は 対応(diag) > missed(up) > insertion(left) の順で優先する。
  const marksReversed: WordMark[] = [];
  const insertionsReversed: string[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const isMatch = scriptNorm[i - 1] === recognizedNorm[j - 1];
      const diagScore = dp[i - 1][j - 1] + (isMatch ? MATCH_SCORE : MISMATCH_SCORE);
      if (dp[i][j] === diagScore) {
        marksReversed.push({
          word: scriptWords[i - 1].word,
          si: scriptWords[i - 1].si,
          status: isMatch ? 'ok' : 'sub',
        });
        i -= 1;
        j -= 1;
        continue;
      }
    }
    if (i > 0 && dp[i][j] === dp[i - 1][j] + GAP_SCORE) {
      marksReversed.push({ word: scriptWords[i - 1].word, si: scriptWords[i - 1].si, status: 'missed' });
      i -= 1;
      continue;
    }
    // 残りは認識語側の挿入
    insertionsReversed.push(recognizedWords[j - 1]);
    j -= 1;
  }

  const wordMarks = marksReversed.reverse();
  const insertions = insertionsReversed.reverse();
  const matchedCount = wordMarks.reduce((count, w) => (w.status === 'ok' ? count + 1 : count), 0);

  return { wordMarks, insertions, matchedCount };
}

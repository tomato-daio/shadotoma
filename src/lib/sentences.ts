/**
 * 英文の文分割ユーティリティ（略語・引用符・小数点を考慮）。
 *
 * `LocalMaterialImport.tsx` の一時実装 `naiveSplitSentences` と
 * `scripts/fetch-voa.mjs` の両方から使う正式な文分割ロジック。
 * 純関数のみを公開し、DOM/ブラウザAPIには依存しない（Node実行スクリプトからも使うため）。
 */

/**
 * ピリオドを一時的に退避させるためのプレースホルダ文字と、文の区切り位置に挿入する一時マーカー。
 * どちらも通常の英文には出現しないASCII制御文字（SOH/STX）。エディタでは見えないため
 * `String.fromCharCode` で明示的に生成する（ソース中に生の制御文字を書かない）。
 */
const PERIOD_PLACEHOLDER = String.fromCharCode(1);
const SPLIT_MARKER = String.fromCharCode(2);

/**
 * 文末と誤認識されやすい省略語（末尾ピリオド込み）。
 * 大文字小文字を区別してマッチさせる（英文の慣例に従う）。
 */
const ABBREVIATIONS = [
  // 敬称・肩書き
  'Mr.', 'Mrs.', 'Ms.', 'Dr.', 'Prof.', 'Rev.', 'Fr.', 'Sr.', 'Jr.',
  'Gen.', 'Col.', 'Lt.', 'Sgt.', 'Capt.', 'Adm.', 'Gov.', 'Sen.', 'Rep.', 'Pres.',
  // 一般的な省略語
  'vs.', 'etc.', 'e.g.', 'i.e.', 'approx.', 'no.', 'No.',
  // 企業・組織
  'Inc.', 'Ltd.', 'Co.', 'Corp.', 'Dept.',
  // 住所
  'St.', 'Ave.', 'Blvd.',
  // 時刻
  'a.m.', 'p.m.', 'A.M.', 'P.M.',
  // 月名
  'Jan.', 'Feb.', 'Mar.', 'Apr.', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Sept.', 'Oct.', 'Nov.', 'Dec.',
] as const;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 文分割を誤らせるピリオドを一時的にプレースホルダへ退避する。
 * - 数字の小数点（例: "3.5 percent"）
 * - 連続する大文字1文字+ピリオドの頭字語（例: "U.S.", "U.K.", "N.A.S.A."）
 * - 既知の省略語（例: "Mr.", "Dr.", "a.m."）
 */
function protectPeriods(text: string): string {
  let protectedText = text;

  // 数字の小数点: "3.5" の "." を退避
  protectedText = protectedText.replace(/(\d)\.(\d)/g, `$1${PERIOD_PLACEHOLDER}$2`);

  // 頭字語: 大文字1文字+ピリオドが2回以上連続 ("U.S." "U.K." "N.A.S.A." 等)
  protectedText = protectedText.replace(/\b(?:[A-Z]\.){2,}/g, (m) =>
    m.replace(/\./g, PERIOD_PLACEHOLDER),
  );

  // 既知の省略語
  for (const abbr of ABBREVIATIONS) {
    const re = new RegExp(`\\b${escapeRegExp(abbr)}`, 'g');
    protectedText = protectedText.replace(re, (m) => m.replace(/\./g, PERIOD_PLACEHOLDER));
  }

  return protectedText;
}

/**
 * 英文を文単位に分割する（純関数・副作用なし）。
 *
 * 分割規則:
 * - `.` `!` `?`（連続可、末尾に引用符・閉じ括弧が続いてもよい）の直後に空白があり、
 *   その次が大文字・数字・引用符・開き括弧で始まる場合に文区切りとみなす。
 * - 既知の省略語（Mr. / U.S. / a.m. 等）と数字の小数点は文区切りとして扱わない。
 * - 改行・連続空白は単一の半角スペースに正規化してから分割する。
 */
export function splitSentences(text: string): string[] {
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (!normalized) return [];

  const protectedText = protectPeriods(normalized);

  // 文末記号(+閉じ引用符/括弧) の直後の空白を SPLIT_MARKER に置き換える。
  // 空白の次が「大文字・数字・引用符・開き括弧」の場合のみ文区切りとみなす。
  const marked = protectedText.replace(
    /([.!?]+["'”’)\]]*)\s+(?=[A-Z0-9"'“‘(])/g,
    `$1${SPLIT_MARKER}`,
  );

  return marked
    .split(SPLIT_MARKER)
    .map((s) => s.replaceAll(PERIOD_PLACEHOLDER, '.').trim())
    .filter(Boolean);
}

/** 文分割結果をMaterial.sentences互換の {en} オブジェクト配列に変換する。 */
export function sentencesFromText(text: string): { en: string }[] {
  return splitSentences(text).map((en) => ({ en }));
}

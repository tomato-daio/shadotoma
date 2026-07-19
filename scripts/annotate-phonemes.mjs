#!/usr/bin/env node
/**
 * 教材メタへの音素情報付与（DESIGN.md §8d 弱点分析とパーソナライズ推薦）。
 *
 * public/materials/index.json の全セクション（Material[]）について、sentences内の語を
 * CMUdict（パブリックドメインの英語発音辞書。https://github.com/cmusphinx/cmudict）で
 * 音素列化し、「日本人が苦手な音素」（DESIGN.md §8c Azureコメント機能の音素アドバイス辞書と
 * 同一キー体系）の出現数を各セクションへ `phonemeCounts` として追記する。
 * `recommendMaterials`（M13）が教材ごとの苦手音密度を計算する際の元データになる。
 *
 * 実行:
 *   node scripts/annotate-phonemes.mjs
 *     -> public/materials/index.json の全セクションへ phonemeCounts を付与して上書き保存する。
 *        音声・文（sentences）・ID・その他フィールドは一切変更しない（検証つき。下記参照）。
 *   fetch-voa.mjs の各実行末尾からも annotatePhonemes() を自動呼び出しする
 *   （index.jsonを書き換えるたびに phonemeCounts を再計算し、常に最新のsentencesと
 *   同期させるため）。
 *
 * CMUdict取得・キャッシュ:
 *   初回実行時のみ公式ミラー（下記 CMUDICT_URL）からダウンロードし、
 *   scripts/.cache/cmudict.dict にキャッシュする（.gitignoreでコミット対象外。
 *   辞書ファイル自体はパブリックドメインだがリポジトリには含めない — DESIGN.md §8d指示）。
 *   2回目以降はキャッシュを使うため再ダウンロードしない。キャッシュを更新したい場合は
 *   scripts/.cache/cmudict.dict を手動で削除してから再実行する。
 *
 * ---------------------------------------------------------------------------
 * 対象音素キーの対応表（ARPAbet大文字 <-> IPA）— README代わりのコメント
 * ---------------------------------------------------------------------------
 * このアプリでは「音素」を常に CMUdict/ARPAbet の表記（大文字のアルファベット文字列。
 * 例: R, TH, AE）をキーとして扱う。DESIGN.md §8c「Azureコメント（M12）」で担当Bが
 * src/features/judge 配下に定義する予定の「日本人の苦手音アドバイス辞書」も
 * **同じキー体系（ARPAbet大文字）を使うこと**（このファイルの指示どおり）。
 * CMUdictの音素記号には強勢(0=無強勢/1=第一強勢/2=第二強勢)を示す末尾の数字が
 * 母音に付くが、比較キーとしては数字を落として統一する（例: "AH0" "AH1" "AH2" は
 * すべてキー "AH"）。
 *
 *   ARPAbetキー | IPA目安  | 備考（日本人が混同しやすい点）
 *   ------------|----------|----------------------------------------------------
 *   R           | r        | 「らりるれろ」に寄りやすく、Lとの弁別が課題
 *   L           | l        | 同上（Rとの弁別が課題）
 *   TH          | θ        | 無声th（think, three）。s/fで代用しがち
 *   DH          | ð        | 有声th（this, that）。zで代用しがち
 *   V           | v        | bと混同しやすい
 *   F           | f        | hと混同しやすい（特に語頭）
 *   W           | w        | 「う」に寄りやすい
 *   AE          | æ        | 「ア」と「エ」の中間母音（cat, bad）。エで代用しがち
 *   AH          | ʌ / ə    | ストレス母音ʌ（cup）とあいまい母音ə（schwa）。CMUdictでは
 *               |          | 強勢の有無(0/1/2)でのみ区別され記号自体は共通のためAHに統一する
 *   ER          | ɜː / ɚ   | 巻き舌気味の母音（bird, teacherの語尾-er）
 *   IH          | ɪ        | 短い「イ」（sit）。IYとの弁別が課題
 *   IY          | iː       | 長い「イー」（seat）。IHとの弁別が課題
 *   S           | s        | 無声のS。SHとの弁別が課題
 *   SH          | ʃ        | 「シュ」（ship）。Sとの弁別が課題
 *
 * DESIGN.md §8c本文の列挙（r, l, θ, ð, v, f, w, æ, ʌ, ə, ɜː, ɪ, iː, s, ʃ の15音素）のうち
 * ʌ と ə はARPAbet上どちらも AH であるため、本表はARPAbetキーとしては14種になる。
 * 担当BのphonemeAdviceがこれと異なるキーを追加・変更する場合は、必ずARPAbet大文字を
 * そのまま使い、このファイルの TARGET_PHONEMES も合わせて更新すること。
 * ---------------------------------------------------------------------------
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const INDEX_PATH = path.join(ROOT, 'public', 'materials', 'index.json');
const CACHE_DIR = path.join(__dirname, '.cache');
const CMUDICT_CACHE_PATH = path.join(CACHE_DIR, 'cmudict.dict');
const CMUDICT_URL = 'https://raw.githubusercontent.com/cmusphinx/cmudict/master/cmudict.dict';

/** 対象音素（ARPAbet大文字キー）。上の対応表を参照。 */
const TARGET_PHONEMES = ['R', 'L', 'TH', 'DH', 'V', 'F', 'W', 'AE', 'AH', 'ER', 'IH', 'IY', 'S', 'SH'];
const TARGET_PHONEME_SET = new Set(TARGET_PHONEMES);

/** ログ表示（音素別トップ・辞書に無かった語トップ）の件数。 */
const TOP_N = 10;

// ---------------------------------------------------------------------------
// CMUdict取得・キャッシュ
// ---------------------------------------------------------------------------

async function ensureCmudictText() {
  if (existsSync(CMUDICT_CACHE_PATH)) {
    return readFile(CMUDICT_CACHE_PATH, 'utf-8');
  }
  console.log(`CMUdictをダウンロードします（初回のみ・キャッシュされます）: ${CMUDICT_URL}`);
  const res = await fetch(CMUDICT_URL);
  if (!res.ok) {
    throw new Error(`CMUdictの取得に失敗しました: HTTP ${res.status} ${CMUDICT_URL}`);
  }
  const text = await res.text();
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(CMUDICT_CACHE_PATH, text, 'utf-8');
  console.log(
    `  -> ${path.relative(ROOT, CMUDICT_CACHE_PATH)} へキャッシュしました（${(text.length / 1024).toFixed(0)} KB）`,
  );
  return text;
}

/**
 * CMUdict本文をパースし、語(小文字・variant番号除去) -> 音素配列(ARPAbet、強勢数字除去)の
 * Mapを作る。1語に複数の発音がある場合（"read(2)"のようなvariant表記）は、番号なしの
 * 主発音を優先する（主発音がどちらの順で出現しても最終的に主発音が残るようにする）。
 */
export function parseCmudict(text) {
  const map = new Map();
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';;;')) continue;

    const spaceIdx = trimmed.indexOf(' ');
    if (spaceIdx === -1) continue;

    const rawWord = trimmed.slice(0, spaceIdx);
    const phonesStr = trimmed.slice(spaceIdx + 1).trim();
    if (!phonesStr) continue;

    const variantMatch = rawWord.match(/^(.*)\((\d+)\)$/);
    const baseWord = (variantMatch ? variantMatch[1] : rawWord).toLowerCase();
    const isPrimary = !variantMatch;

    if (!isPrimary && map.has(baseWord)) continue; // 既に主発音(または先着のvariant)があれば維持

    const phones = phonesStr.split(/\s+/).map((p) => p.replace(/[0-2]$/, ''));
    map.set(baseWord, phones);
  }
  return map;
}

// ---------------------------------------------------------------------------
// 語の正規化（CMUdict検索キー用）
//
// src/lib/align.ts の normalizeWord は「数字語をアラインメント用に'3'等へ変換する」等
// 添削アラインメント専用の目的を持つため、ここでは流用しない（"three"を辞書で引く際に
// '3'へ変換されると辞書に無いキーになってしまう）。ここでは実際のつづりのままCMUdictを
// 引く必要があるため、大文字小文字と前後の約物のみを正規化する独自の軽量実装を使う。
// ---------------------------------------------------------------------------

export function normalizeForDict(rawToken) {
  let w = rawToken
    .replace(/[‘’ʼʹ]/g, "'") // カーリークォート等 -> 直立アポストロフィ
    .toLowerCase();
  w = w.replace(/^[^a-z']+/, '').replace(/[^a-z']+$/, '');
  return w;
}

// ---------------------------------------------------------------------------
// セクションごとの音素カウント
// ---------------------------------------------------------------------------

/**
 * 1セクション分のsentencesから対象音素の出現数を数える。CMUdictに無い語（実際に
 * アルファベットを含むのに辞書に見つからない語のみ）は skipCounter
 * （Map<正規化語, 出現数>）に記録してスキップする（DESIGN.md §8d手順3）。
 * 数字・記号だけのトークン（正規化後に空文字になるもの）はそもそも語ではないため
 * カウントもスキップログも行わない。
 */
export function countPhonemesForSentences(sentences, dictMap, skipCounter) {
  const counts = {};
  for (const sentence of sentences) {
    const tokens = sentence.en.split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      const norm = normalizeForDict(token);
      if (!norm) continue;

      const phones = dictMap.get(norm);
      if (!phones) {
        skipCounter.set(norm, (skipCounter.get(norm) ?? 0) + 1);
        continue;
      }

      for (const phone of phones) {
        if (TARGET_PHONEME_SET.has(phone)) {
          counts[phone] = (counts[phone] ?? 0) + 1;
        }
      }
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// 検証（DESIGN.md §8d手順5: スクリプト内蔵の検証）
// ---------------------------------------------------------------------------

/**
 * 付与前後のindex.jsonを比較し、
 *   (a) 全セクションに phonemeCounts が付与されたこと
 *   (b) phonemeCounts以外の全フィールド（sentences/wordCount含む）がバイト単位で
 *       不変であること（JSON文字列化して完全一致するかで判定）
 * を検証する。問題があればissuesへ文言を積んで返す。
 */
export function verifyAnnotation(before, after) {
  const issues = [];

  if (before.length !== after.length) {
    issues.push(`セクション数が変化: ${before.length} -> ${after.length}`);
  }

  for (let i = 0; i < after.length; i++) {
    const a = after[i];
    const b = before[i];
    if (!b || b.id !== a.id) {
      issues.push(`[index ${i}] idが不一致、または対応する元セクションが無い`);
      continue;
    }
    if (typeof a.phonemeCounts !== 'object' || a.phonemeCounts === null || Array.isArray(a.phonemeCounts)) {
      issues.push(`[${a.id}] phonemeCountsが付与されていない`);
    }

    const { phonemeCounts: _omitA, ...aRest } = a;
    const { phonemeCounts: _omitB, ...bRest } = b;
    if (JSON.stringify(aRest) !== JSON.stringify(bRest)) {
      issues.push(`[${a.id}] phonemeCounts以外のフィールドが変化している`);
    }
  }

  return { ok: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// メイン処理
// ---------------------------------------------------------------------------

export async function annotatePhonemes() {
  if (!existsSync(INDEX_PATH)) {
    throw new Error(`index.jsonが見つかりません: ${INDEX_PATH}`);
  }

  const originalText = await readFile(INDEX_PATH, 'utf-8');
  const before = JSON.parse(originalText);
  const after = JSON.parse(originalText); // beforeとは独立したコピー（検証を意味あるものにする）

  const cmudictText = await ensureCmudictText();
  const dictMap = parseCmudict(cmudictText);
  console.log(`CMUdict読み込み: ${dictMap.size}語`);

  const skipCounter = new Map();
  /** @type {Record<string, number>} */
  const totalPhonemeCounts = {};
  for (const p of TARGET_PHONEMES) totalPhonemeCounts[p] = 0;

  for (const material of after) {
    const counts = countPhonemesForSentences(material.sentences, dictMap, skipCounter);
    material.phonemeCounts = counts;
    for (const [phone, n] of Object.entries(counts)) {
      totalPhonemeCounts[phone] = (totalPhonemeCounts[phone] ?? 0) + n;
    }
  }

  const verification = verifyAnnotation(before, after);
  if (!verification.ok) {
    console.error('検証NG（index.jsonは書き換えていません）:');
    for (const issue of verification.issues) console.error(`  - ${issue}`);
    throw new Error('annotate-phonemes: 検証に失敗しました');
  }

  await writeFile(INDEX_PATH, `${JSON.stringify(after, null, 2)}\n`, 'utf-8');

  // ---- 統計ログ ----
  console.log('');
  console.log(
    `検証OK: 全${after.length}セクションに phonemeCounts を付与し、他フィールド（sentences/wordCount含む）は不変。`,
  );

  const topPhonemes = Object.entries(totalPhonemeCounts).sort((a, b) => b[1] - a[1]);
  console.log('音素別 総出現数（トップ順）:');
  for (const [phone, n] of topPhonemes.slice(0, TOP_N)) {
    console.log(`  ${phone.padEnd(3)}: ${n}`);
  }

  const skipEntries = [...skipCounter.entries()].sort((a, b) => b[1] - a[1]);
  const skipTotalOccurrences = skipEntries.reduce((sum, [, n]) => sum + n, 0);
  console.log(
    `CMUdictに無かった語: 種類数=${skipEntries.length} / 延べ出現数=${skipTotalOccurrences}`,
  );
  if (skipEntries.length > 0) {
    console.log(`  (上位${Math.min(TOP_N, skipEntries.length)}件)`);
    for (const [word, n] of skipEntries.slice(0, TOP_N)) {
      console.log(`    "${word}": ${n}回`);
    }
  }

  return {
    sectionCount: after.length,
    totalPhonemeCounts,
    skipEntries,
    skipTotalOccurrences,
  };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  annotatePhonemes().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

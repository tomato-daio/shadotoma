#!/usr/bin/env node
/**
 * VOA Learning English（learningenglish.voanews.com）から記事の音声(mp3)とトランスクリプトを
 * 取得し、public/materials/index.json（Material[]）と public/materials/audio/*.mp3 を生成する。
 *
 * VOA Learning Englishは米国政府制作のためパブリックドメイン（DESIGN.md §0）。
 *
 * 使い方:
 *   npm run fetch-voa -- --level 1 --count 5
 *   node scripts/fetch-voa.mjs --level 2 --count 3
 *
 * 依存: Node標準機能のみ（fetch, fs/promises）。HTMLパースは正規表現/文字列処理で行う。
 *
 * 実装メモ（HTML構造への依存・脆弱性）:
 * - 記事一覧: セクションページ（例: /z/3521 = As It Is）内の `href="/a/....html"` リンクを
 *   出現順（新着順）に拾う。VOAサイトの一覧レイアウトが変わると抽出漏れが起きうる。
 * - 記事本文: `id="article-content"` の位置から、最初の `<h2` タグが現れる直前までを
 *   トランスクリプト領域とみなし、その範囲内の `<p>...</p>` を本文として抽出する。
 *   "Words in This Story"（語注）や埋め込みクイズは最初の`<h2`より後ろにあるため自然に除外される。
 * - 音声URL: `<audio src="....mp3" ...>` の最初の一致（64kbps版）を採用する。
 * - 署名・定型文（"I'm John Russell." 等）は文分割後にパターンマッチで除去する（本文中に
 *   `<br/>`区切りで埋め込まれているケースがあるため、段落単位ではなく文単位でフィルタする）。
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sentencesFromText } from '../src/lib/sentences.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MATERIALS_DIR = path.join(ROOT, 'public', 'materials');
const AUDIO_DIR = path.join(MATERIALS_DIR, 'audio');
const INDEX_PATH = path.join(MATERIALS_DIR, 'index.json');

const BASE_URL = 'https://learningenglish.voanews.com';
const USER_AGENT = 'shadotoma-fetch-voa/1.0 (personal shadowing-practice PWA; non-commercial)';
/** 記事取得間の待機時間(ms)。サイトへの配慮のため連続アクセスを避ける。 */
const REQUEST_INTERVAL_MS = 400;
/** 音声ファイルがこれ未満なら取得失敗（エラーページ等）とみなす。 */
const MIN_AUDIO_BYTES = 50 * 1024;
/** index.jsonのaudioUrlに使う想定ビットレート(bps)。VOAの既定<audio src>は64kbpsのCBR。 */
const ASSUMED_BITRATE_BPS = 64000;

/**
 * VOAレベル(1〜3)とセクション(カテゴリ)の対応。
 * VOAサイト自体は記事ごとに数値レベルを付与していないため、難易度の異なる3つの
 * 定番セクションを本アプリのlevel 1/2/3に割り当てる（設計上の判断。DESIGN.md §3の
 * category例「As It Is」はlevel 1に対応する）。
 */
const LEVEL_SECTIONS = {
  1: { sectionPath: '/z/3521', category: 'As It Is' },
  2: { sectionPath: '/z/1579', category: 'Science & Technology' },
  3: { sectionPath: '/z/1581', category: 'American Stories' },
};

function parseArgs(argv) {
  const args = { level: 1, count: 5 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--level') {
      args.level = Number(argv[++i]);
    } else if (argv[i] === '--count') {
      args.count = Number(argv[++i]);
    }
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${url}`);
  }
  return res.text();
}

async function fetchBuffer(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${url}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** HTML実体参照（数値参照・主要な名前付き参照）をデコードする。 */
function decodeEntities(str) {
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * ゼロ幅スペース等、見た目に現れないUnicode制御文字。
 * VOAの記事本文に稀に混入しており、放置すると句読点の直後に来た際に
 * sentences.ts の文分割（半角スペース判定）を妨げる（例: "water.​ Please..." が分割されない）。
 * エディタ上で見えない文字のため `\u{...}` エスケープで明示する。
 */
const INVISIBLE_CHARS_RE = new RegExp(
  '[​-‍﻿­]',
  'g',
);

/** HTML断片からタグを取り除きプレーンテキスト化する（<br>は空白に変換）。 */
function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(INVISIBLE_CHARS_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTitle(html) {
  const m = html.match(/<title>([^<]*)<\/title>/i);
  return m ? htmlToText(m[1]) : null;
}

function extractAudioUrl(html) {
  const m = html.match(/<audio\s+src="([^"]+\.mp3)"/i);
  return m ? m[1] : null;
}

/**
 * 記事本文の段落テキスト配列を返す。
 * `id="article-content"` から最初の `<h2` 直前までを対象に、属性なしの `<p>` のみを本文として
 * 抽出する。VOAのテンプレートでは音声プレイヤーの状態表示（`<p class="ta-c">No media source
 * currently available</p>` 等）やUIボタンは必ずclass属性付きの`<p>`で、地の文の段落は常に
 * 属性なしの`<p>`であるため、`<p>`（属性なし）に限定することでプレイヤーUI文言の混入を防ぐ。
 * 区切り線のみの段落（"____...") は除外する。
 */
function extractArticleParagraphs(html) {
  const startIdx = html.indexOf('id="article-content"');
  if (startIdx === -1) return null;
  const rest = html.slice(startIdx);
  const h2Idx = rest.search(/<h2[\s>]/i);
  const transcriptHtml = h2Idx === -1 ? rest : rest.slice(0, h2Idx);

  const paragraphs = [...transcriptHtml.matchAll(/<p>([\s\S]*?)<\/p>/gi)]
    .map((m) => htmlToText(m[1]))
    .filter((p) => p.length > 0 && !/^_+$/.test(p));

  return paragraphs;
}

/**
 * 文単位の署名・定型文フィルタ。
 * DESIGN.md §7: 「署名、Words in This Story等は除外してよいが、除外しすぎに注意」。
 * 記事本文中のどこに出てもまず安全なものだけSAFE、誤検知の余地があるものは
 * 記事末尾3文以内にのみ適用するEND_ONLYに分ける（署名は必ず記事の一番最後に来るため）。
 */
const SAFE_BOILERPLATE_PATTERNS = [/^_+$/];
const END_ONLY_BOILERPLATE_PATTERNS = [
  // "I'm John Russell." のような署名の名乗り
  /^I['’]m\s+[A-Z][\w.’'-]*(\s+[A-Z][\w.’'-]*){0,2}\.$/,
  // "NAME wrote/reported (on) this/the story (for ORG)." 形式の記者クレジット
  // （VOA自社記者は"wrote this story for VOA Learning English"、AP/AFP配信記事は
  // "reported this story for the Associated Press"のように動詞が異なるため両方を許容する）
  /\b(wrote|reported( on)?)\b[^.!?]*\b(this|the) story\b/i,
  // "NAME adapted it (for VOA Learning English)." 形式（↑の記事を書いた記者に続けて
  // 別の記者が"adapted it"とだけ書くケースがあり、"story"という単語を含まない）
  /\badapted (it|this story|the story)\b/i,
  /you (have )?just heard the story/i,
  /your storyteller was/i,
  /^this is [A-Z][\w.’' -]{2,40}\.$/,
];

function stripBoilerplateSentences(sentences) {
  return sentences.filter((s, idx) => {
    const trimmed = s.trim();
    if (SAFE_BOILERPLATE_PATTERNS.some((re) => re.test(trimmed))) return false;
    const isNearEnd = idx >= sentences.length - 3;
    if (isNearEnd && END_ONLY_BOILERPLATE_PATTERNS.some((re) => re.test(trimmed))) return false;
    return true;
  });
}

/** セクション一覧ページから記事リンク(/a/....html)を出現順・重複なしで抽出する。 */
function extractArticleLinks(sectionHtml) {
  const links = [...sectionHtml.matchAll(/href="(\/a\/[^"]+\.html)"/g)].map((m) => m[1]);
  return [...new Set(links)];
}

/** 記事URL末尾の数値IDから教材idを組み立てる（既存index.jsonとの重複判定キーにもなる）。 */
function articleIdFromLink(link) {
  const m = link.match(/(\d+)\.html$/);
  return m ? `voa-${m[1]}` : null;
}

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

async function main() {
  const { level, count } = parseArgs(process.argv.slice(2));
  const section = LEVEL_SECTIONS[level];
  if (!section || !Number.isFinite(count) || count <= 0) {
    console.error('使い方: node scripts/fetch-voa.mjs --level <1|2|3> --count <件数>');
    process.exit(1);
  }

  await mkdir(AUDIO_DIR, { recursive: true });

  /** @type {any[]} */
  let index = [];
  if (existsSync(INDEX_PATH)) {
    index = JSON.parse(await readFile(INDEX_PATH, 'utf-8'));
  }
  const existingIds = new Set(index.map((m) => m.id));

  console.log(`VOA level ${level}（${section.category}）から最大${count}件取得します...`);
  const sectionHtml = await fetchText(`${BASE_URL}${section.sectionPath}`);
  const links = extractArticleLinks(sectionHtml);
  console.log(`  一覧から${links.length}件のリンクを検出`);

  let added = 0;
  for (const link of links) {
    if (added >= count) break;

    const id = articleIdFromLink(link);
    if (!id) {
      console.log(`  skip (idを抽出できない): ${link}`);
      continue;
    }
    if (existingIds.has(id)) {
      console.log(`  skip (既存): ${id}`);
      continue;
    }

    const articleUrl = link.startsWith('http') ? link : `${BASE_URL}${link}`;
    try {
      await sleep(REQUEST_INTERVAL_MS);
      const articleHtml = await fetchText(articleUrl);

      const title = extractTitle(articleHtml);
      const audioPath = extractAudioUrl(articleHtml);
      const paragraphs = extractArticleParagraphs(articleHtml);

      if (!title || !audioPath || !paragraphs || paragraphs.length === 0) {
        console.log(`  skip (本文/音声を抽出できない): ${articleUrl}`);
        continue;
      }

      const bodyText = paragraphs.join(' ');
      const rawSentences = sentencesFromText(bodyText).map((s) => s.en);
      const sentences = stripBoilerplateSentences(rawSentences).map((en) => ({ en }));

      if (sentences.length === 0) {
        console.log(`  skip (本文抽出0文): ${articleUrl}`);
        continue;
      }

      await sleep(REQUEST_INTERVAL_MS);
      const audioBuffer = await fetchBuffer(audioPath);
      if (audioBuffer.length < MIN_AUDIO_BYTES) {
        console.log(`  skip (音声が小さすぎる: ${audioBuffer.length} bytes): ${articleUrl}`);
        continue;
      }

      const audioFileName = `${id}.mp3`;
      await writeFile(path.join(AUDIO_DIR, audioFileName), audioBuffer);

      const wordCount = sentences.reduce((sum, s) => sum + countWords(s.en), 0);
      // CBR 64kbpsを仮定した簡易時間推定（依存追加なしで概算するため）。
      // 実際の再生時間はアプリ側でHTMLAudioElementのloadedmetadataから取得し直す。
      const estimatedDurationSec = Math.round((audioBuffer.length * 8) / ASSUMED_BITRATE_BPS);

      const material = {
        id,
        source: 'voa',
        title,
        level,
        category: section.category,
        audioUrl: `materials/audio/${audioFileName}`,
        sentences,
        durationSec: estimatedDurationSec,
        wordCount,
        addedAt: Date.now(),
      };

      index.push(material);
      existingIds.add(id);
      added++;
      console.log(
        `  追加: [${id}] ${title} (${sentences.length}文 / ${wordCount}語 / 約${estimatedDurationSec}秒 / ${(audioBuffer.length / 1024).toFixed(0)}KB)`,
      );
    } catch (err) {
      console.warn(`  エラー(スキップ): ${articleUrl} — ${err instanceof Error ? err.message : err}`);
    }
  }

  await writeFile(INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`, 'utf-8');
  console.log(`完了: ${added}件追加。index.json 合計 ${index.length}件。`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

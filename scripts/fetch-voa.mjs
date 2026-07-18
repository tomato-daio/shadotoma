#!/usr/bin/env node
/**
 * VOA Learning English（learningenglish.voanews.com）から記事の音声(mp3)とトランスクリプトを
 * 取得し、public/materials/index.json（Material[]）と public/materials/audio/*.mp3 を生成する。
 *
 * VOA Learning Englishは米国政府制作のためパブリックドメイン（DESIGN.md §0）。
 *
 * シャドテンと同じく1練習単位=30〜60秒にするため、記事は無音区間で「セクション」に分割して
 * 保存する（DESIGN.md §7b）。分割にはffmpeg/ffprobe（PATHにインストール済み前提）を使う。
 *
 * 使い方:
 *   npm run fetch-voa -- --level 1 --count 5
 *   node scripts/fetch-voa.mjs --level 2 --count 3
 *     → 新規記事を取得し、音声をffmpegでセクション分割してからindex.jsonへ追記する
 *       （既存記事と同じarticleIdの記事はスキップ）。
 *   node scripts/fetch-voa.mjs --refresh
 *     → 既存教材の本文だけ再取得して再生成する。音声・セクション境界（何秒目で区切るか）は
 *       変更せず、各セクションの実測長(durationSec)から境界を復元して文だけ再配分する。
 *   node scripts/fetch-voa.mjs --resegment
 *     → 分割前（part未設定）の長尺voa教材が public/materials/audio/<id>.mp3 として残っている場合、
 *       それをffmpegでセクション分割し、index.jsonをセクション版だけの状態へ作り直す。
 *       ネットワークは使わない（既存の本文・音声だけを使う一括変換用）。分割済みの教材は素通りする。
 *
 * 依存: Node標準機能のみ（fetch, fs/promises, child_process）+ PATH上のffmpeg/ffprobe。
 *       HTMLパースは正規表現/文字列処理で行う。
 *
 * 実装メモ（HTML構造への依存・脆弱性）:
 * - 記事一覧: セクションページ（例: /z/3521 = As It Is）内の `href="/a/....html"` リンクを
 *   出現順（新着順）に拾う。VOAサイトの一覧レイアウトが変わると抽出漏れが起きうる。
 * - 記事本文: `id="article-content"` の位置から、最初の `<h2` タグが現れる直前までを
 *   トランスクリプト領域とみなし、その範囲内の `<p>...</p>` を本文として抽出する。
 *   "Words in This Story"（語注）や埋め込みクイズは最初の`<h2`より後ろにあるため自然に除外される。
 * - 記事中の小見出し（例: `<p><strong>Adventurer stranded for 3 days by storm</strong></p>`）は
 *   独立した短い`<p>`として本文中に挿入されており、文末句読点を持たない。これを段落として
 *   そのまま本文に混ぜると、文分割時に隣の文へ吸着してしまう（句読点がないため文区切りと
 *   認識されない）ため、`looksLikeHeading()` で段落抽出の時点（文分割・結合の前）に除外する。
 * - 音声URL: `<audio src="....mp3" ...>` の最初の一致（64kbps版）を採用する。
 * - 署名・定型文（"I'm John Russell." 等）は文分割後にパターンマッチで除去する（本文中に
 *   `<br/>`区切りで埋め込まれているケースがあるため、段落単位ではなく文単位でフィルタする）。
 *
 * 実装メモ（セクション分割・DESIGN.md §7b）:
 * - ffmpeg `silencedetect` で無音区間を検出し、その中点だけを分割候補点にする（無音の途中で
 *   切れば発話を欠かない）。noise=-35dB/d=0.3sを起点に、候補点が足りず75秒以内に収まらない
 *   区間があれば閾値を緩めて（音量しきい値を上げる・最短無音長を短くする）再検出する。
 * - 45秒を目標に、30〜60秒の範囲内で目標に最も近い候補点を選ぶ。範囲内に候補がなければ
 *   75秒（絶対上限）まで許容する。末尾の端切れが15秒未満なら直前のセクションへマージする
 *   （ただしマージ後が75秒を超えるならマージせず短いまま残す＝上限超過より許容できるため）。
 * - 文の割り当ては語数比による推定時刻方式（無音＝文境界に近いVOAの読み上げ特性を利用した近似）。
 *   `--refresh` では音声・境界を変えないため、既存セクションの実測長(durationSec)の累積から
 *   境界(秒)を復元し、その境界に対して新しい文を同じ方式で再配分する。
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
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

/** セクション分割の目標秒数（DESIGN.md §7b）。 */
const SECTION_TARGET_SEC = 45;
/** 通常範囲の下限。この値を超えた候補点でなければ区切らない（＝各セクションは基本30秒以上）。 */
const SECTION_MIN_SEC = 30;
/** 通常範囲の上限。この範囲内に候補点があれば優先してここから選ぶ。 */
const SECTION_MAX_SEC = 60;
/** どうしても通常範囲に候補がない場合に許容する絶対上限。 */
const SECTION_HARD_MAX_SEC = 75;
/** この秒数未満の末尾セクションは直前のセクションへマージする。 */
const SECTION_MERGE_UNDER_SEC = 15;
/** WPM一貫性チェックの許容乖離率（記事平均WPMからの相対誤差）。 */
const WPM_DEVIATION_TOLERANCE = 0.3;

/**
 * silencedetectの検出条件。先頭から順に試し、75秒以内に収まる分割点が見つからない区間が
 * 一つでもあれば次の（より緩い）条件で全体を検出し直す。
 */
const SILENCE_DETECT_ATTEMPTS = [
  { noiseDb: -35, minDur: 0.3 },
  { noiseDb: -30, minDur: 0.25 },
  { noiseDb: -26, minDur: 0.2 },
  { noiseDb: -22, minDur: 0.15 },
];

/** stream copyでの切り出し結果が要求秒数からこれ以上ずれたら再エンコードにフォールバックする。 */
const COPY_DURATION_TOLERANCE_SEC = 0.5;

function parseArgs(argv) {
  const args = { level: 1, count: 5, refresh: false, resegment: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--level') {
      args.level = Number(argv[++i]);
    } else if (argv[i] === '--count') {
      args.count = Number(argv[++i]);
    } else if (argv[i] === '--refresh') {
      args.refresh = true;
    } else if (argv[i] === '--resegment') {
      args.resegment = true;
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
 * 段落が記事中の小見出し（例: "Adventurer stranded for 3 days by storm"）かどうかを判定する。
 *
 * VOAの記事本文には、通常の地の文の段落に混じって`<p><strong>見出し</strong></p>`という
 * 形の短い小見出しが独立した段落として挿入されている。これは音声では読まれないため、
 * そのままスクリプトに含めると添削精度を落とす（申し送り事項の修正対象）。
 *
 * ヒューリスティック: 60文字未満 かつ 文末句読点(`.` `!` `?`。閉じ引用符が続く場合は許容)を
 * 持たない段落を小見出しとみなす。地の文の段落はほぼ必ず文の区切りである句読点で終わるため、
 * この2条件を両方満たすケースは実質的に小見出しか区切り線のような非本文段落のみになる。
 */
const HEADING_MAX_LENGTH = 60;

function looksLikeHeading(paragraph) {
  const trimmed = paragraph.trim();
  if (trimmed.length === 0 || trimmed.length >= HEADING_MAX_LENGTH) return false;
  // 文末の閉じ引用符（ストレート/カーリー）を取り除いてから終端句読点の有無を見る。
  const withoutTrailingQuotes = trimmed.replace(/["'”’]+$/, '');
  return !/[.!?]$/.test(withoutTrailingQuotes);
}

/**
 * 記事本文の段落テキスト配列を返す。
 * `id="article-content"` から最初の `<h2` 直前までを対象に、属性なしの `<p>` のみを本文として
 * 抽出する。VOAのテンプレートでは音声プレイヤーの状態表示（`<p class="ta-c">No media source
 * currently available</p>` 等）やUIボタンは必ずclass属性付きの`<p>`で、地の文の段落は常に
 * 属性なしの`<p>`であるため、`<p>`（属性なし）に限定することでプレイヤーUI文言の混入を防ぐ。
 * 区切り線のみの段落（"____...") と、小見出しとみなせる段落（`looksLikeHeading`）は除外する。
 */
function extractArticleParagraphs(html) {
  const startIdx = html.indexOf('id="article-content"');
  if (startIdx === -1) return null;
  const rest = html.slice(startIdx);
  const h2Idx = rest.search(/<h2[\s>]/i);
  const transcriptHtml = h2Idx === -1 ? rest : rest.slice(0, h2Idx);

  const paragraphs = [...transcriptHtml.matchAll(/<p>([\s\S]*?)<\/p>/gi)]
    .map((m) => htmlToText(m[1]))
    .filter((p) => p.length > 0 && !/^_+$/.test(p))
    .filter((p) => !looksLikeHeading(p));

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

// ---------------------------------------------------------------------------
// セクション分割（DESIGN.md §7b）: ffmpeg/ffprobeラッパーと分割ロジック
// ---------------------------------------------------------------------------

/** ffmpegを実行し、stdout/stderrを回収する（`-f null -` での解析用途にも使う）。 */
function runFfmpegCapture(args) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`ffmpeg failed (${args.join(' ')}):\n${stderr || err.message}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function runFfmpeg(args) {
  await runFfmpegCapture(args);
}

function ffprobeDuration(filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath],
      { maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          reject(new Error(`ffprobe failed (${filePath}): ${err.message}`));
          return;
        }
        resolve(parseFloat(stdout.trim()));
      },
    );
  });
}

/** ffmpeg/ffprobeがPATH上にあるか確認し、無ければ案内付きでエラーにする。 */
async function ensureFfmpegAvailable() {
  for (const bin of ['ffmpeg', 'ffprobe']) {
    try {
      await new Promise((resolve, reject) => {
        execFile(bin, ['-version'], (err) => (err ? reject(err) : resolve()));
      });
    } catch {
      throw new Error(
        `${bin} が見つかりません。ffmpeg/ffprobeをインストールし、PATHへ追加してから再実行してください` +
          `（DESIGN.md §7b の教材セクション分割に必須です）。`,
      );
    }
  }
}

/** `silencedetect` を実行し、[silence_start, silence_end] の区間配列を返す。 */
async function detectSilenceIntervals(mp3Path, noiseDb, minDur) {
  const { stderr } = await runFfmpegCapture([
    '-i',
    mp3Path,
    '-af',
    `silencedetect=noise=${noiseDb}dB:d=${minDur}`,
    '-f',
    'null',
    '-',
  ]);
  const starts = [...stderr.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map((m) => parseFloat(m[1]));
  const ends = [...stderr.matchAll(/silence_end:\s*([\d.]+)/g)].map((m) => parseFloat(m[1]));
  // 音声末尾が無音のまま終わるとsilence_endが出力されないことがあるため、揃った分だけ使う。
  const n = Math.min(starts.length, ends.length);
  const intervals = [];
  for (let i = 0; i < n; i++) intervals.push([starts[i], ends[i]]);
  return intervals;
}

/**
 * 無音区間の中点候補から、45秒目標・30〜60秒範囲（上限75秒）・末尾15秒未満マージのルールで
 * セクション境界（0始まり、totalDurationを含む秒数の配列）を選ぶ。
 * 範囲内に候補がなく分割を続けられない場合は null を返す（呼び出し側で閾値を緩めて再試行する）。
 */
function chooseSectionBoundaries(candidates, totalDuration) {
  const boundaries = [0];
  let current = 0;

  while (true) {
    const remaining = totalDuration - current;
    if (remaining <= SECTION_HARD_MAX_SEC) {
      boundaries.push(totalDuration);
      break;
    }

    const windowCandidates = candidates.filter(
      (c) => c > current + SECTION_MIN_SEC && c <= current + SECTION_HARD_MAX_SEC,
    );
    if (windowCandidates.length === 0) return null;

    const preferred = windowCandidates.filter((c) => c <= current + SECTION_MAX_SEC);
    const pool = preferred.length > 0 ? preferred : windowCandidates;
    const target = current + SECTION_TARGET_SEC;
    const best = pool.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));

    boundaries.push(best);
    current = best;
  }

  // 末尾セクションが15秒未満なら直前のセクションへマージする。
  // ただしマージ後が75秒（絶対上限）を超えるなら、上限超過より短いセクションの方が
  // まだ許容できるためマージしない。
  if (boundaries.length >= 3) {
    const lastLen = boundaries[boundaries.length - 1] - boundaries[boundaries.length - 2];
    if (lastLen < SECTION_MERGE_UNDER_SEC) {
      const mergedLen = boundaries[boundaries.length - 1] - boundaries[boundaries.length - 3];
      if (mergedLen <= SECTION_HARD_MAX_SEC) {
        boundaries.splice(boundaries.length - 2, 1);
      }
    }
  }

  return boundaries;
}

/**
 * 音声ファイルからセクション境界（秒の配列）を決定する。silencedetectの条件を段階的に緩めながら
 * 試し、75秒以内に収まる分割点がどうしても見つからない場合はエラーにする。
 */
async function detectSectionBoundaries(mp3Path, totalDuration) {
  if (totalDuration <= SECTION_HARD_MAX_SEC) {
    return { boundaries: [0, totalDuration], noiseDb: null, minDur: null };
  }

  for (const { noiseDb, minDur } of SILENCE_DETECT_ATTEMPTS) {
    const intervals = await detectSilenceIntervals(mp3Path, noiseDb, minDur);
    const candidates = intervals
      .map(([s, e]) => (s + e) / 2)
      .filter((c) => c > 0 && c < totalDuration)
      .sort((a, b) => a - b);

    const boundaries = chooseSectionBoundaries(candidates, totalDuration);
    if (boundaries) {
      return { boundaries, noiseDb, minDur };
    }
  }

  throw new Error(
    `${path.basename(mp3Path)}: 無音検出を緩めても${SECTION_HARD_MAX_SEC}秒以内に収まる分割点が見つかりません`,
  );
}

/**
 * 文の配列を、語数比による推定時刻方式でセクション境界に割り当てる。
 * 各文の中点（開始からの累積語数 + 自身の語数/2）の推定時刻が属する区間へ入れる。
 * 全文を漏れなく1回ずつ・元の順序を保ったまま割り当てる（DESIGN.md §7b）。
 */
function assignSentencesToSections(sentences, boundaries, totalWordCount, totalDuration) {
  const partCount = boundaries.length - 1;
  const buckets = Array.from({ length: partCount }, () => []);

  let wordsBefore = 0;
  for (const sentence of sentences) {
    const words = countWords(sentence.en);
    const midWords = wordsBefore + words / 2;
    wordsBefore += words;
    const estTime = totalWordCount > 0 ? (midWords / totalWordCount) * totalDuration : 0;

    let idx = boundaries.findIndex((b, i) => i < partCount && estTime >= b && estTime < boundaries[i + 1]);
    if (idx === -1) idx = estTime <= 0 ? 0 : partCount - 1;

    buckets[idx].push(sentence);
  }

  return buckets;
}

/**
 * 音声を [startSec, endSec) で切り出す。まずstream copy（無劣化・高速）を試し、
 * 実測長が要求からずれていた場合のみ再エンコードにフォールバックする。
 */
async function cutSection(inputPath, outputPath, startSec, endSec) {
  await runFfmpeg([
    '-y',
    '-i',
    inputPath,
    '-ss',
    startSec.toFixed(3),
    '-to',
    endSec.toFixed(3),
    '-c',
    'copy',
    outputPath,
  ]);

  const expected = endSec - startSec;
  const actual = await ffprobeDuration(outputPath);
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > COPY_DURATION_TOLERANCE_SEC) {
    await runFfmpeg([
      '-y',
      '-i',
      inputPath,
      '-ss',
      startSec.toFixed(3),
      '-to',
      endSec.toFixed(3),
      '-c:a',
      'libmp3lame',
      '-b:a',
      '64k',
      outputPath,
    ]);
  }
}

/**
 * セクション群を検証する（DESIGN.md §7b実施タスクの検証項目）:
 * - 全セクションの実測長(durationSec)が15〜75秒に収まる
 * - セクションのWPM(語数/実測長×60)が記事平均から±30%以内
 * - 文の合計数が分割前と一致する
 */
function verifySections(materials, originalSentenceCount, articleId) {
  const issues = [];

  for (const m of materials) {
    if (m.durationSec < 15 || m.durationSec > 75) {
      issues.push(`[${m.id}] 長さ${m.durationSec}秒が15〜75秒の範囲外`);
    }
  }

  const totalWords = materials.reduce((sum, m) => sum + m.wordCount, 0);
  const totalDuration = materials.reduce((sum, m) => sum + m.durationSec, 0);
  const avgWpm = totalDuration > 0 ? (totalWords / totalDuration) * 60 : 0;

  for (const m of materials) {
    const wpm = m.durationSec > 0 ? (m.wordCount / m.durationSec) * 60 : 0;
    const deviation = avgWpm > 0 ? Math.abs(wpm - avgWpm) / avgWpm : 0;
    if (deviation > WPM_DEVIATION_TOLERANCE) {
      issues.push(
        `[${m.id}] WPM ${wpm.toFixed(0)} が記事平均 ${avgWpm.toFixed(0)} から ${(deviation * 100).toFixed(0)}%乖離（許容±${WPM_DEVIATION_TOLERANCE * 100}%）`,
      );
    }
  }

  const totalSentences = materials.reduce((sum, m) => sum + m.sentences.length, 0);
  if (totalSentences !== originalSentenceCount) {
    issues.push(`[${articleId}] 文の合計数が不一致: 分割前${originalSentenceCount}文 -> 分割後${totalSentences}文`);
  }

  return { ok: issues.length === 0, issues, avgWpm, totalSentences };
}

function printVerificationSummary(reports) {
  if (reports.length === 0) return;
  const failed = reports.filter(({ report }) => !report.ok);
  console.log('');
  console.log(`検証結果: ${reports.length}記事中 ${reports.length - failed.length}記事が問題なし。`);
  if (failed.length > 0) {
    console.log('要確認:');
    for (const { articleId, report } of failed) {
      console.log(`  [${articleId}]`);
      for (const issue of report.issues) console.log(`    - ${issue}`);
    }
  }
}

/**
 * 1記事分の音声(sourceAudioPath)を無音区間でセクションに分割し、各セクションのmp3書き出しと
 * 文の再配分、Material[]の組み立て、検証までを行う。
 */
async function splitArticleIntoSections({ articleId, sourceAudioPath, sentences, title, level, category, addedAt }) {
  const totalDuration = await ffprobeDuration(sourceAudioPath);
  if (!Number.isFinite(totalDuration) || totalDuration <= 0) {
    throw new Error(`音声の長さを取得できません: ${sourceAudioPath}`);
  }

  const { boundaries, noiseDb, minDur } = await detectSectionBoundaries(sourceAudioPath, totalDuration);
  const partCount = boundaries.length - 1;

  const totalWordCount = sentences.reduce((sum, s) => sum + countWords(s.en), 0);
  const buckets = assignSentencesToSections(sentences, boundaries, totalWordCount, totalDuration);

  const materials = [];
  for (let i = 0; i < partCount; i++) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    const audioFileName = `${articleId}-p${i + 1}.mp3`;
    const outPath = path.join(AUDIO_DIR, audioFileName);

    await cutSection(sourceAudioPath, outPath, start, end);
    const durationSec = Math.round(await ffprobeDuration(outPath));

    const sectionSentences = buckets[i];
    const wordCount = sectionSentences.reduce((sum, s) => sum + countWords(s.en), 0);

    materials.push({
      id: `${articleId}-p${i + 1}`,
      source: 'voa',
      title: `${title} (${i + 1}/${partCount})`,
      level,
      category,
      audioUrl: `materials/audio/${audioFileName}`,
      sentences: sectionSentences,
      durationSec,
      wordCount,
      addedAt,
      articleId,
      part: i + 1,
      partCount,
    });
  }

  const report = verifySections(materials, sentences.length, articleId);

  return { materials, noiseDb, minDur, totalDuration, report };
}

/**
 * 既存教材（source: 'voa'）の本文（sentences/wordCount）だけを再取得・再生成する。
 * 音声mp3・セクション境界は変更しない（教材idも変えない）。articleId（分割済みの場合）または
 * id（未分割の場合）でグルーピングし、各記事につき1回だけ本文を取得し直す。
 *
 * 各レベルのセクション一覧ページを1回ずつクロールしてid→記事リンクの対応表を作り、
 * 既存教材のarticleIdがその中に見つかった場合のみ本文を再取得して差し替える。セクション一覧に
 * もう載っていない古い記事は再取得できないため、その教材はスキップして警告を出す
 * （既存のsentencesはそのまま維持される）。
 */
async function refreshExisting(index) {
  console.log('既存教材の本文を再取得し、最新ロジックで再生成します（音声・分割位置は変更しません）...');

  const linkById = new Map();
  for (const section of Object.values(LEVEL_SECTIONS)) {
    const sectionHtml = await fetchText(`${BASE_URL}${section.sectionPath}`);
    for (const link of extractArticleLinks(sectionHtml)) {
      const id = articleIdFromLink(link);
      if (id && !linkById.has(id)) {
        linkById.set(id, link);
      }
    }
    await sleep(REQUEST_INTERVAL_MS);
  }

  // articleId（分割済みならarticleId、未分割ならid自身）でグルーピングし、part順に並べる。
  const groups = new Map();
  for (const material of index) {
    if (material.source !== 'voa') continue;
    const key = material.articleId ?? material.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(material);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => (a.part ?? 1) - (b.part ?? 1));
  }

  let updatedArticles = 0;
  let updatedSections = 0;
  const reports = [];

  for (const [articleId, group] of groups) {
    const link = linkById.get(articleId);
    if (!link) {
      console.warn(`  skip (一覧ページに見つからず再取得不可): ${articleId}`);
      continue;
    }

    const articleUrl = link.startsWith('http') ? link : `${BASE_URL}${link}`;
    try {
      await sleep(REQUEST_INTERVAL_MS);
      const articleHtml = await fetchText(articleUrl);
      const paragraphs = extractArticleParagraphs(articleHtml);
      if (!paragraphs || paragraphs.length === 0) {
        console.warn(`  skip (本文を抽出できない): ${articleId}`);
        continue;
      }

      const bodyText = paragraphs.join(' ');
      const rawSentences = sentencesFromText(bodyText).map((s) => s.en);
      const sentences = stripBoilerplateSentences(rawSentences).map((en) => ({ en }));
      if (sentences.length === 0) {
        console.warn(`  skip (本文抽出0文): ${articleId}`);
        continue;
      }

      // 既存セクションの実測長(durationSec)の累積からセクション境界(秒)を復元する。
      // 音声は変えず、文だけを同じ方式（語数比による推定時刻）で境界に再配分する。
      const boundaries = [0];
      for (const material of group) {
        boundaries.push(boundaries[boundaries.length - 1] + (material.durationSec ?? 0));
      }
      const totalDuration = boundaries[boundaries.length - 1];
      const totalWordCount = sentences.reduce((sum, s) => sum + countWords(s.en), 0);
      const buckets = assignSentencesToSections(sentences, boundaries, totalWordCount, totalDuration);

      group.forEach((material, i) => {
        const bucketSentences = buckets[i] ?? [];
        material.sentences = bucketSentences;
        material.wordCount = bucketSentences.reduce((sum, s) => sum + countWords(s.en), 0);
      });

      const report = verifySections(group, sentences.length, articleId);
      reports.push({ articleId, report });

      updatedArticles++;
      updatedSections += group.length;
      console.log(`  更新: [${articleId}] ${group.length}セクション / 合計${sentences.length}文`);
    } catch (err) {
      console.warn(`  エラー(スキップ): ${articleId} — ${err instanceof Error ? err.message : err}`);
    }
  }

  printVerificationSummary(reports);
  console.log(`再取得完了: ${updatedArticles}記事(${updatedSections}セクション)を更新。`);
}

/**
 * 分割前（part未設定）の長尺voa教材を、既存のaudio/<id>.mp3を分割元にしてセクション化する。
 * ネットワークは使わない一括変換用モード。分割済みの教材・source:'local'教材はそのまま通す。
 */
async function resegmentExisting(index) {
  console.log('既存の長尺教材をセクション単位（30〜60秒目安）へ分割し直します...');

  const result = [];
  const reports = [];
  let convertedArticles = 0;
  let producedSections = 0;

  for (const material of index) {
    if (material.source !== 'voa' || material.part) {
      result.push(material);
      continue;
    }

    const articleId = material.id;
    const fullAudioPath = path.join(AUDIO_DIR, `${articleId}.mp3`);
    if (!existsSync(fullAudioPath)) {
      console.warn(`  skip (元mp3が見つからずセクション化不可): ${articleId}`);
      result.push(material);
      continue;
    }

    console.log(`  分割中: [${articleId}] ${material.title}`);
    const { materials, noiseDb, minDur, totalDuration, report } = await splitArticleIntoSections({
      articleId,
      sourceAudioPath: fullAudioPath,
      sentences: material.sentences,
      title: material.title,
      level: material.level,
      category: material.category,
      addedAt: material.addedAt,
    });

    result.push(...materials);
    reports.push({ articleId, report });
    convertedArticles++;
    producedSections += materials.length;
    console.log(
      `    -> ${materials.length}セクション（元の長さ${totalDuration.toFixed(1)}秒, noise=${noiseDb}dB/d=${minDur}s）`,
    );

    await unlink(fullAudioPath);
  }

  console.log(`分割完了: ${convertedArticles}記事 -> ${producedSections}セクション。`);
  return { newIndex: result, reports };
}

async function main() {
  const { level, count, refresh, resegment } = parseArgs(process.argv.slice(2));

  await mkdir(AUDIO_DIR, { recursive: true });

  /** @type {any[]} */
  let index = [];
  if (existsSync(INDEX_PATH)) {
    index = JSON.parse(await readFile(INDEX_PATH, 'utf-8'));
  }

  if (refresh) {
    await refreshExisting(index);
    await writeFile(INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`, 'utf-8');
    console.log('index.json を再生成しました。');
    return;
  }

  if (resegment) {
    await ensureFfmpegAvailable();
    const { newIndex, reports } = await resegmentExisting(index);
    await writeFile(INDEX_PATH, `${JSON.stringify(newIndex, null, 2)}\n`, 'utf-8');
    printVerificationSummary(reports);
    console.log('index.json を再生成しました。');
    return;
  }

  await ensureFfmpegAvailable();

  const section = LEVEL_SECTIONS[level];
  if (!section || !Number.isFinite(count) || count <= 0) {
    console.error(
      '使い方: node scripts/fetch-voa.mjs --level <1|2|3> --count <件数> | --refresh | --resegment',
    );
    process.exit(1);
  }

  // 記事単位の重複判定は articleId（分割済みなら articleId、未分割なら id 自身）で行う。
  const existingArticleIds = new Set(index.map((m) => m.articleId ?? m.id));

  console.log(`VOA level ${level}（${section.category}）から最大${count}件取得します...`);
  const sectionHtml = await fetchText(`${BASE_URL}${section.sectionPath}`);
  const links = extractArticleLinks(sectionHtml);
  console.log(`  一覧から${links.length}件のリンクを検出`);

  let added = 0;
  const reports = [];

  for (const link of links) {
    if (added >= count) break;

    const id = articleIdFromLink(link);
    if (!id) {
      console.log(`  skip (idを抽出できない): ${link}`);
      continue;
    }
    if (existingArticleIds.has(id)) {
      console.log(`  skip (既存): ${id}`);
      continue;
    }

    const articleUrl = link.startsWith('http') ? link : `${BASE_URL}${link}`;
    let tempAudioPath = null;
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

      // セクション分割にはffmpegでファイルを読ませる必要があるため、いったん一時ファイルへ書き出す。
      tempAudioPath = path.join(AUDIO_DIR, `.tmp-${id}.mp3`);
      await writeFile(tempAudioPath, audioBuffer);

      const { materials, noiseDb, minDur, report } = await splitArticleIntoSections({
        articleId: id,
        sourceAudioPath: tempAudioPath,
        sentences,
        title,
        level,
        category: section.category,
        addedAt: Date.now(),
      });

      index.push(...materials);
      existingArticleIds.add(id);
      reports.push({ articleId: id, report });
      added++;

      const totalWordCount = sentences.reduce((sum, s) => sum + countWords(s.en), 0);
      console.log(
        `  追加: [${id}] ${title} (${materials.length}セクション / 合計${totalWordCount}語 / noise=${noiseDb}dB,d=${minDur}s)`,
      );
    } catch (err) {
      console.warn(`  エラー(スキップ): ${articleUrl} — ${err instanceof Error ? err.message : err}`);
    } finally {
      if (tempAudioPath) await unlink(tempAudioPath).catch(() => {});
    }
  }

  await writeFile(INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`, 'utf-8');
  printVerificationSummary(reports);
  console.log(`完了: ${added}件追加。index.json 合計 ${index.length}件。`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * 文割り当ての実測補正（DESIGN.md §7b「文割り当ての実測補正（M11）」）。
 *
 * fetch-voa.mjs のセクション分割（M4）は、各文の推定発話時刻を「記事全体の語数比」から
 * 見積もり、その中点が属するセクションへ機械的に割り当てる近似方式のため、末尾文が
 * 実際の音声とずれることがある（実機報告: 音声に読まれていない文がスクリプト末尾に載る）。
 *
 * このスクリプトは、各セクション音声の**末尾約12秒**を実際にWhisper（transformers.js・
 * Node実行・onnx-community/whisper-tiny.en・dtype:'q4'）で文字起こしし、認識された最後の
 * 語群と「現行割り当ての推定境界±3文」の候補文の文末語群を照合することで、
 * 「実際にそのセクションの音声で読まれている最後の文」を特定する。
 *
 * 記事ごとに文ポインタを先頭から進めながら、各セクションへ「ポインタ位置〜特定した境界」の
 * 文を割り当てていく（文ポインタ方式）。この方式により以下が構造的に保証される:
 *   - 全文を漏れなく1回ずつ割り当てる（欠落・重複ゼロ）
 *   - 元の文順序を維持する
 *   - 各セクションは最低1文を持つ（境界候補の探索範囲をポインタ〜残りセクション数で必ずクランプする）
 *
 * 音声現物（mp3）・セクション境界（何秒目で切るか）・教材id/articleId/part/partCountは
 * 一切変更しない。変更するのは各Materialの sentences と wordCount のみ。
 *
 * 照合スコアが低く確信が持てない境界（デフォルトの信頼度しきい値・僅差ケース）は、
 * 誤った自信で壊すより現状維持を優先し、その旨をログに出す（現行のM4割り当てのまま）。
 *
 * 使い方:
 *   node scripts/fix-sentence-alignment.mjs
 *     → 全記事・全セクションを補正し index.json を再生成する。
 *   node scripts/fix-sentence-alignment.mjs --only voa-2572601,voa-7504521
 *     → 指定した articleId のみ処理する（動作確認用。他記事のエントリはそのまま書き戻す）。
 *   node scripts/fix-sentence-alignment.mjs --dry-run
 *     → index.json への書き込みをせず、判定結果のログのみ出す（検証用）。
 *
 * 依存: @huggingface/transformers（既存devDependencies）をNode実行で利用。追加パッケージなし。
 *       PATH上のffmpeg/ffprobe（fetch-voa.mjsと同じ前提）。
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from '@huggingface/transformers';
import { alignWords, normalizeWord } from '../src/lib/align.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const MATERIALS_DIR = path.join(PUBLIC_DIR, 'materials');
const INDEX_PATH = path.join(MATERIALS_DIR, 'index.json');

/** モデル（DESIGN.md指定: Node実行・tiny.en・q4）。 */
const MODEL_ID = 'onnx-community/whisper-tiny.en';
/** 各セクション音声の末尾何秒を文字起こし対象にするか。 */
const TAIL_SEC = 12;
/** 現行割り当ての推定境界からの探索窓（±何文）。 */
const BOUNDARY_WINDOW = 3;
/** 候補の期待語群を作るときの最低語数（短い文が続く場合は前の文まで遡って語数を確保する）。 */
const MIN_EXPECTED_WORDS = 6;
/** 採用に必要な最低スコア（0-1。alignWordsの一致数/期待語数）。 */
const CONFIDENCE_THRESHOLD = 0.6;
/** 最有力候補と次点候補のスコア差がこれ未満なら僅差＝確信が持てないとみなす。 */
const CONFIDENCE_MARGIN = 0.15;

function parseArgs(argv) {
  const args = { only: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only') {
      args.only = new Set(
        (argv[++i] ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
    } else if (argv[i] === '--dry-run') {
      args.dryRun = true;
    }
  }
  return args;
}

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// ffmpeg/ffprobe ラッパー（fetch-voa.mjsと同じ最小実装）
// ---------------------------------------------------------------------------

function runFfmpeg(args) {
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

async function ensureFfmpegAvailable() {
  for (const bin of ['ffmpeg', 'ffprobe']) {
    try {
      await new Promise((resolve, reject) => {
        execFile(bin, ['-version'], (err) => (err ? reject(err) : resolve()));
      });
    } catch {
      throw new Error(
        `${bin} が見つかりません。ffmpeg/ffprobeをインストールし、PATHへ追加してから再実行してください。`,
      );
    }
  }
}

/**
 * 16kHzモノラルPCM16 WAV（RIFF/WAVE, 'fmt '/'data'チャンク）をFloat32Array（-1〜1）へ変換する。
 * ffmpegへ明示的に -ar 16000 -ac 1 -c:a pcm_s16le を指定して書き出すため、フォーマットは
 * 常にこの想定どおりになるはずだが、想定外だった場合はエラーにする（サイレントな誤動作を避ける）。
 */
function readWavFloat32(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('WAVファイルとして認識できません（RIFF/WAVEヘッダ不一致）');
  }
  let offset = 12;
  let fmt = null;
  let dataStart = -1;
  let dataLen = 0;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    if (chunkId === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(bodyStart),
        numChannels: buf.readUInt16LE(bodyStart + 2),
        sampleRate: buf.readUInt32LE(bodyStart + 4),
        bitsPerSample: buf.readUInt16LE(bodyStart + 14),
      };
    } else if (chunkId === 'data') {
      dataStart = bodyStart;
      dataLen = chunkSize;
    }
    // チャンクは偶数バイト境界にパディングされる
    offset = bodyStart + chunkSize + (chunkSize % 2);
  }
  if (!fmt || dataStart === -1) {
    throw new Error('WAVのfmt/dataチャンクが見つかりません');
  }
  if (fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16 || fmt.numChannels !== 1) {
    throw new Error(`想定外のWAVフォーマット: ${JSON.stringify(fmt)}`);
  }
  const n = Math.floor(dataLen / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = buf.readInt16LE(dataStart + i * 2) / 32768;
  }
  return { samples: out, sampleRate: fmt.sampleRate };
}

/** セクション音声の末尾TAIL_SEC秒を16kHzモノラルへ変換し、Whisperで文字起こしする。 */
async function transcribeTail(transcriber, mp3Path, tmpWavPath) {
  await runFfmpeg(['-y', '-i', mp3Path, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav', tmpWavPath]);
  const buf = await readFile(tmpWavPath);
  const { samples, sampleRate } = readWavFloat32(buf);
  const tail = samples.slice(Math.max(0, samples.length - TAIL_SEC * sampleRate));

  const output = await transcriber(tail, { chunk_length_s: 30, stride_length_s: 5 });
  const result = Array.isArray(output) ? output[0] : output;
  return (result?.text ?? '').trim();
}

// ---------------------------------------------------------------------------
// 文割り当ての境界推定
// ---------------------------------------------------------------------------

/**
 * 候補境界 b（0始まり、flatSentences中のインデックス、その文を含む末尾側）に対する
 * 「期待される文末語群」を組み立てる。文 b から遡り、MIN_EXPECTED_WORDS語に達するまで
 * （ただしpointerより前には遡らない）前の文をつなげる。alignWordsへ渡すため
 * {word, si} 形式（siはここでは使わないがalignWordsのインターフェース上必要）で返す。
 */
function buildExpectedWords(flatSentences, pointer, boundaryIdx) {
  let words = [];
  let idx = boundaryIdx;
  while (idx >= pointer) {
    const sentWords = flatSentences[idx].en
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => ({ word, si: idx }));
    words = sentWords.concat(words);
    if (words.length >= MIN_EXPECTED_WORDS) break;
    idx -= 1;
  }
  return words;
}

/**
 * 候補文末語群 と 認識語群 の「末尾どうし」が実際に一致しているかを見る。
 *
 * alignWords（Needleman-Wunsch）だけで採点すると、候補が実際より短い場合でも
 * 「候補の語は認識結果のどこかに全部見つかる」ため一致率(recall)が1.0になってしまい、
 * 認識結果の末尾に残る語（＝実際にはまだ続きが読まれている証拠）を無視してしまう
 * （例: 候補文が"...Florida."で終わるのに、認識結果はその後に"Most of the people
 * ...lifeboats."と続く場合、候補の語は全部見つかるのでrecall=1.0になるが、
 * 実際の区切りはもっと後ろにある）。
 *
 * これを避けるため、両者を**末尾から**位置合わせして直接比較する（末尾アンカー）。
 * 正しい境界であれば両者の最後の数語は（Whisperの軽微な誤認識を除き）一致するはずで、
 * 境界が早すぎる/遅すぎる候補は不一致になりやすい。
 */
function endAnchorScore(expectedWordsRaw, recognizedTokens) {
  const k = Math.min(4, expectedWordsRaw.length, recognizedTokens.length);
  if (k === 0) return 0;
  let matches = 0;
  for (let i = 1; i <= k; i++) {
    const a = normalizeWord(expectedWordsRaw[expectedWordsRaw.length - i]);
    const b = normalizeWord(recognizedTokens[recognizedTokens.length - i]);
    if (a !== '' && a === b) matches++;
  }
  return matches / k;
}

/**
 * 1セクション分の境界を決定する。
 * 探索窓は [pointer, T-N+i] にクランプした [estimatedEnd-3, estimatedEnd+3]。
 * スコアは「末尾アンカー一致度」を主、「全体一致率(recall)」を従とした加重合成。
 * 一致度が最も高い候補が閾値以上・かつ次点との差が僅差でなければ採用、そうでなければ
 * null を返す（＝現行割り当てを維持すべき、呼び出し側でestimatedEndをそのまま使う）。
 */
function decideBoundary(flatSentences, pointer, estimatedEnd, upperLimit, recognizedText) {
  const lower = Math.max(pointer, estimatedEnd - BOUNDARY_WINDOW);
  const upper = Math.min(estimatedEnd + BOUNDARY_WINDOW, upperLimit);
  if (lower > upper) return { boundary: null, best: null, second: null };

  const recognizedTokens = recognizedText.split(/\s+/).filter(Boolean);
  if (recognizedTokens.length === 0) return { boundary: null, best: null, second: null };

  const scored = [];
  for (let b = lower; b <= upper; b++) {
    const expected = buildExpectedWords(flatSentences, pointer, b);
    if (expected.length === 0) continue;
    const expectedRaw = expected.map((w) => w.word);
    const { matchedCount } = alignWords(expected, recognizedTokens);
    const recall = matchedCount / expected.length;
    const endAnchor = endAnchorScore(expectedRaw, recognizedTokens);
    const score = endAnchor * 0.8 + recall * 0.2;
    scored.push({ b, score, endAnchor, recall, expectedLen: expected.length });
  }
  if (scored.length === 0) return { boundary: null, best: null, second: null };
  scored.sort((a, c) => c.score - a.score);
  const best = scored[0];
  const second = scored[1] ?? null;

  const confident =
    best.score >= CONFIDENCE_THRESHOLD && (!second || best.score - second.score >= CONFIDENCE_MARGIN);

  return { boundary: confident ? best.b : null, best, second };
}

// ---------------------------------------------------------------------------
// メイン処理
// ---------------------------------------------------------------------------

function groupByArticle(index) {
  const groups = new Map();
  for (const material of index) {
    const key = material.articleId ?? material.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(material);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => (a.part ?? 1) - (b.part ?? 1));
  }
  return groups;
}

async function main() {
  const { only, dryRun } = parseArgs(process.argv.slice(2));

  if (!existsSync(INDEX_PATH)) {
    throw new Error(`index.jsonが見つかりません: ${INDEX_PATH}`);
  }
  await ensureFfmpegAvailable();

  const index = JSON.parse(await readFile(INDEX_PATH, 'utf-8'));
  const groups = groupByArticle(index);
  const targetArticleIds = only ? [...groups.keys()].filter((id) => only.has(id)) : [...groups.keys()];

  const totalSections = targetArticleIds.reduce((sum, id) => sum + groups.get(id).length, 0);
  console.log(`対象: ${targetArticleIds.length}記事 / ${totalSections}セクション`);
  console.log(`モデル ${MODEL_ID}（dtype: q4）を読み込み中...`);

  const transcriber = await pipeline('automatic-speech-recognition', MODEL_ID, { dtype: 'q4' });
  console.log('モデル読み込み完了。補正処理を開始します。');

  const tmpDir = await mkdtemp(path.join(tmpdir(), 'shadotoma-align-'));
  const tmpWavPath = path.join(tmpDir, 'tail.wav');

  let sectionsDone = 0;
  let boundariesChanged = 0;
  let boundariesKeptLowConfidence = 0;
  const changedExamples = [];
  const lowConfidenceExamples = [];

  try {
    for (const articleId of targetArticleIds) {
      const group = groups.get(articleId);
      const N = group.length;
      const flatSentences = group.flatMap((m) => m.sentences);
      const T = flatSentences.length;

      // 現行（M4）割り当てでの各セクション末尾インデックス（0始まり、flatSentences中）
      const currentEndIdx = [];
      {
        let acc = -1;
        for (const m of group) {
          acc += m.sentences.length;
          currentEndIdx.push(acc);
        }
      }

      const newBuckets = Array.from({ length: N }, () => []);
      let pointer = 0;
      const articleTitle = (group[0].title ?? '').replace(/\s*\(\d+\/\d+\)$/, '');

      for (let i = 0; i < N; i++) {
        sectionsDone++;
        const audioPath = path.join(PUBLIC_DIR, group[i].audioUrl);
        const recognizedText = await transcribeTail(transcriber, audioPath, tmpWavPath);
        const preview = recognizedText.length > 60 ? `${recognizedText.slice(0, 60)}…` : recognizedText;
        console.log(`  [${sectionsDone}/${totalSections}] ${group[i].id} 末尾${TAIL_SEC}秒: "${preview}"`);

        if (i === N - 1) {
          // 記事内最後のセクション: 残り全文を割り当てる（移動先が無いため境界判定は不要）。
          newBuckets[i] = flatSentences.slice(pointer, T);
          pointer = T;
          continue;
        }

        const upperLimit = T - N + i; // 残りセクション(N-1-i個)が最低1文ずつ持てる上限
        const { boundary, best, second } = decideBoundary(
          flatSentences,
          pointer,
          currentEndIdx[i],
          upperLimit,
          recognizedText,
        );

        const finalBoundary = boundary ?? currentEndIdx[i];
        if (boundary !== null && boundary !== currentEndIdx[i]) {
          boundariesChanged++;
          const movedCount = boundary - currentEndIdx[i];
          const example = {
            articleId,
            articleTitle,
            sectionId: group[i].id,
            fromEndIdx: currentEndIdx[i],
            toEndIdx: boundary,
            movedSentences:
              movedCount > 0
                ? flatSentences.slice(currentEndIdx[i] + 1, boundary + 1).map((s) => s.en)
                : flatSentences.slice(boundary + 1, currentEndIdx[i] + 1).map((s) => s.en),
            direction: movedCount > 0 ? 'to-next' : 'from-next',
            score: best.score,
          };
          changedExamples.push(example);
          console.log(
            `    -> 境界修正: 文index ${currentEndIdx[i]} -> ${boundary}` +
              `（score=${best.score.toFixed(2)}, 次点=${second ? second.score.toFixed(2) : '-'}）` +
              ` 移動: ${JSON.stringify(example.movedSentences.map((s) => s.slice(0, 30)))}`,
          );
        } else if (boundary === null) {
          boundariesKeptLowConfidence++;
          lowConfidenceExamples.push({
            articleId,
            articleTitle,
            sectionId: group[i].id,
            estimatedEnd: currentEndIdx[i],
            best: best ? { b: best.b, score: best.score } : null,
            second: second ? { b: second.b, score: second.score } : null,
          });
          console.log(
            `    -> 低確信度のため現行割り当てを維持（文index ${currentEndIdx[i]}）` +
              (best
                ? `（最有力候補 index=${best.b} score=${best.score.toFixed(2)} / 次点 index=${second ? second.b : '-'} score=${second ? second.score.toFixed(2) : '-'}）`
                : '（候補なし）'),
          );
        } else {
          console.log(`    -> 確認済み・変更なし（文index ${currentEndIdx[i]}, score=${best.score.toFixed(2)}）`);
        }

        newBuckets[i] = flatSentences.slice(pointer, finalBoundary + 1);
        pointer = finalBoundary + 1;
      }

      // ---- 検証（記事単位）----
      const flattenedBack = newBuckets.flat();
      if (flattenedBack.length !== T) {
        throw new Error(`[${articleId}] 文の総数が不一致: 分割前${T} -> 分割後${flattenedBack.length}`);
      }
      for (let k = 0; k < T; k++) {
        if (flattenedBack[k].en !== flatSentences[k].en) {
          throw new Error(`[${articleId}] 文の順序またはテキストが変化しています（index ${k}）`);
        }
      }
      for (let i = 0; i < N; i++) {
        if (newBuckets[i].length === 0) {
          throw new Error(`[${articleId}] セクション ${group[i].id} が0文になりました`);
        }
      }

      // ---- 反映（sentences/wordCountのみ更新。audioUrl等の他フィールドは不変）----
      group.forEach((m, i) => {
        m.sentences = newBuckets[i];
        m.wordCount = newBuckets[i].reduce((sum, s) => sum + countWords(s.en), 0);
      });
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  // ---- グローバル検証: 全記事合算の文数が処理前後で一致 ----
  const totalSentencesAfter = index.reduce((sum, m) => sum + m.sentences.length, 0);
  console.log('');
  console.log('=== 検証結果 ===');
  console.log(`処理セクション数: ${sectionsDone}`);
  console.log(`境界修正: ${boundariesChanged}件`);
  console.log(`低確信度のため現状維持: ${boundariesKeptLowConfidence}件`);
  console.log(`index.json 全体の文の合計数（更新後）: ${totalSentencesAfter}`);

  if (changedExamples.length > 0) {
    console.log('');
    console.log('--- 修正された境界（例） ---');
    for (const ex of changedExamples) {
      console.log(
        `[${ex.articleId}] ${ex.sectionId}: index ${ex.fromEndIdx} -> ${ex.toEndIdx} ` +
          `(score=${ex.score.toFixed(2)}) 移動文(${ex.direction}): ${JSON.stringify(ex.movedSentences)}`,
      );
    }
  }

  if (lowConfidenceExamples.length > 0) {
    console.log('');
    console.log('--- 低確信度のため現状維持にした境界 ---');
    for (const ex of lowConfidenceExamples) {
      console.log(
        `[${ex.articleId}] ${ex.sectionId}: 推定境界 index ${ex.estimatedEnd} を維持` +
          (ex.best ? ` (最有力候補 index=${ex.best.b} score=${ex.best.score.toFixed(2)})` : ''),
      );
    }
  }

  // 実機報告で言及された2記事の"Crane was among the last to leave."系の文が、
  // 修正後に正しいセクションへ移っているかを明示確認する。
  console.log('');
  console.log('--- 実機報告ケースの確認 ---');
  for (const aid of ['voa-2572601', 'voa-7504521']) {
    const group = groups.get(aid);
    if (!group) continue;
    for (const m of group) {
      const hit = m.sentences.find((s) => /Crane (was among the last to leave|climbed into the last remaining lifeboat)/.test(s.en));
      if (hit) {
        console.log(`[${aid}] "${hit.en}" は現在 ${m.id}（part ${m.part}）に割り当てられています。`);
      }
    }
  }

  if (dryRun) {
    console.log('');
    console.log('--dry-run のため index.json への書き込みは行いませんでした。');
    return;
  }

  await writeFile(INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`, 'utf-8');
  console.log('');
  console.log('index.json を更新しました。');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

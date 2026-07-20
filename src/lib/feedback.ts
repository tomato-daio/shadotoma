/**
 * 添削スコア(matchRate/WPM)の算出と、Good Point / Development Pointのルールベース生成
 * （DESIGN.md §8手順4・5）。
 *
 * 生成する文言は、可能な限り「どの文の話か」を明記し、文単位の根拠を持たせる
 * （M2申し送り事項: fetch-voaの小見出し混入バグにより文脈のない誤指摘が起きた反省を踏まえ、
 * 集計だけでなく具体的な文を引用する）。
 *
 * 純関数のみを公開し、DOM/ブラウザAPIには依存しない。
 */

import type { WordMark } from './align';
import {
  prioritizeIssues,
  stripPunct,
  type PhenomenonIssue,
  type PhenomenonType,
  type PreviousIssueOutcome,
} from './phenomena';
import {
  EXTRA_PAUSE_COUNT_DIFF,
  PITCH_FLAT_RATIO,
  PITCH_GOOD_RATIO,
  PITCH_MIN_MEANINGFUL_SD,
  type ReferenceComparison,
} from './referenceComparison';

export interface SentenceLike {
  en: string;
}

export interface FeedbackInput {
  wordMarks: WordMark[];
  sentences: SentenceLike[];
  /** このスクリプトに対応しない、認識された余分な語（align.tsのinsertions）。 */
  insertions?: string[];
  /**
   * 提出音声から算出したWPM（認識語数/秒数×60）。DESIGN.md §8手順4・M10により、分母は
   * 録音全体ではなく発話区間（speechBounds）の長さ。runJudge.tsで一度だけ計算した値を
   * ここへそのまま渡す（judge.wpmと速度系Good/Dev Point判定の計算元を一箇所にするため）。
   */
  wpm: number;
  /** お手本音声のWPM（スクリプト総語数/お手本再生時間×60）。無ければ速度比較は行わない。 */
  referenceWpm?: number;
  /** 前回提出のmatchRate。無ければ前回比の言及は行わない。 */
  previousMatchRate?: number;
  /** phenomena.detectPhenomenaの検出結果（生データ・未ソート可。DESIGN.md §8 5b）。 */
  issues?: PhenomenonIssue[];
  /** 前回提出issuesの改善判定（phenomena.comparePreviousIssues）。Good Pointの「前回指摘が改善」に使う。 */
  previousIssueOutcomes?: PreviousIssueOutcome[];
  /**
   * お手本音声との比較（M15・DESIGN.md §8f）。間(ポーズ)・抑揚のGood/Dev Pointに使う。
   * お手本解析が未実行・失敗のときはundefined（比較コメントを出さない）。
   */
  referenceComparison?: ReferenceComparison;
}

export interface FeedbackResult {
  goodPoints: string[];
  devPoints: string[];
  /** 今回のDevelopment Pointの根拠にした音声現象（優先度順・最大3件。JudgeResult.issuesにそのまま保存する）。 */
  issues: PhenomenonIssue[];
}

const GOOD_POINTS_COUNT = 3;
const DEV_POINTS_COUNT = 3;
/** 速度がお手本比でこの割合を超えて外れていたら指摘する（DESIGN.md §8: ±15%以内か）。 */
const WPM_TOLERANCE_RATIO = 0.15;
/** 最長連続一致区間として言及に値する最小語数。 */
const NOTABLE_STREAK_MIN_LENGTH = 4;
/** 「挿入語ゼロ」を褒める条件として要求する最低一致率（全語missedのような空認識で誤って褒めないため）。 */
const NO_INSERTION_PRAISE_MIN_MATCH_RATE = 0.3;
/**
 * 認識語数（ok+sub+insertions）がスクリプト語数に対してこの割合を下回ったら「ほぼ認識できていない」
 * とみなす（マイク不調等）。runJudge.tsもお手本比較の抑止判定に同じ基準を使う（M15）。
 */
export const LOW_RECOGNITION_RATIO = 0.15;

/** wordMarksからmatchRate（0-1、スクリプト語のうち言えた割合）を計算する。 */
export function computeMatchRate(wordMarks: WordMark[]): number {
  if (wordMarks.length === 0) return 0;
  const ok = wordMarks.filter((w) => w.status === 'ok').length;
  return ok / wordMarks.length;
}

/** 認識語数と録音秒数からWPM（words per minute）を計算する。 */
export function computeWpm(recognizedWordCount: number, durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  return (recognizedWordCount / durationSec) * 60;
}

export interface OkStreak {
  /** 連続区間の長さ（語数）。 */
  length: number;
  /** wordMarks配列上の開始index。 */
  startIndex: number;
  /** 開始語の文index。 */
  si: number;
  /** 区間内の単語をスペースで結合したテキスト（表示用）。 */
  text: string;
}

/**
 * wordMarks中でstatus==='ok'が連続する最長区間を求める（DESIGN.md §8: 最長連続一致区間）。
 * 同じ長さの区間が複数あれば最初に見つかったものを返す。1件もokが無ければnull。
 */
export function longestOkStreak(wordMarks: WordMark[]): OkStreak | null {
  let best: OkStreak | null = null;
  let runStart = -1;
  let runLength = 0;

  const flush = (endIndexExclusive: number) => {
    if (runLength > 0 && (best === null || runLength > best.length)) {
      const words = wordMarks.slice(runStart, endIndexExclusive).map((w) => w.word);
      best = {
        length: runLength,
        startIndex: runStart,
        si: wordMarks[runStart].si,
        text: words.join(' '),
      };
    }
  };

  for (let i = 0; i < wordMarks.length; i++) {
    if (wordMarks[i].status === 'ok') {
      if (runLength === 0) runStart = i;
      runLength += 1;
    } else {
      flush(i);
      runLength = 0;
    }
  }
  flush(wordMarks.length);

  return best;
}

interface SentenceMissedStat {
  si: number;
  missedCount: number;
  totalCount: number;
  text: string;
}

/** missed/sub（=言えなかった語）が最も集中している文を求める（DESIGN.md §8）。 */
function findWorstSentence(wordMarks: WordMark[], sentences: SentenceLike[]): SentenceMissedStat | null {
  const bySentence = new Map<number, { missed: number; total: number }>();
  for (const mark of wordMarks) {
    const stat = bySentence.get(mark.si) ?? { missed: 0, total: 0 };
    stat.total += 1;
    if (mark.status !== 'ok') stat.missed += 1;
    bySentence.set(mark.si, stat);
  }

  let worst: SentenceMissedStat | null = null;
  for (const [si, stat] of bySentence) {
    if (stat.missed === 0) continue;
    if (
      worst === null ||
      stat.missed > worst.missedCount ||
      (stat.missed === worst.missedCount && stat.missed / stat.total > worst.missedCount / worst.totalCount)
    ) {
      worst = { si, missedCount: stat.missed, totalCount: stat.total, text: sentences[si]?.en ?? '' };
    }
  }
  return worst;
}

function truncateForDisplay(text: string, maxLength = 60): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
}

/** 音声現象タイプの日本語ラベル（Development Pointの現象名と、Good Point「前回指摘の◯◯が改善」の表示に使う）。 */
const PHENOMENON_LABEL: Record<PhenomenonType, string> = {
  linking: '連結',
  flap: 'フラップ（tの軽い音）',
  elision: '脱落',
  weak: '弱形',
  ending: '語尾(-s/-ed)',
};

// ---- 実語ベースのDevelopment Point文言（DESIGN.md §8 5b・M8）----
//
// 固定の例文（turned on→ターンドン等）を教材と無関係に使い回すことは禁止。
// 文言は必ず検出された実際の語（PhenomenonIssue.words）から組み立てる:
// (1) 検出された実語ペアを主役に（同typeが複数あれば最大2ペア列挙）
// (2) 現象の説明は実際の語の綴りから取り出した文字で示す（例: picked it は d と i がつながる）
// (3) カタカナヒントは下記の手書き小辞書に載っている語（ペアは両方）のみ、読みを合成して付ける。
//     機械的な英語→カタカナ自動変換器は作らない（誤ったカタカナを出すくらいなら文字説明のみ）。

/**
 * 頻出語・機能語のカタカナ読み小辞書（約60語・人手で記載）。
 * キーはstripPunct後の形（小文字・前後約物なし・内部アポストロフィ保持）。
 * ここに無い語にはカタカナヒントを付けない（自動変換はしない）。
 */
const KATAKANA_DICT: Record<string, string> = {
  // 機能語（phenomena.tsのWEAK_FORM_WORDSと同じ語彙）
  a: 'ア', an: 'アン', and: 'アンド', as: 'アズ', at: 'アット', but: 'バット',
  can: 'キャン', could: 'クッド', do: 'ドゥ', does: 'ダズ', for: 'フォー', from: 'フロム',
  had: 'ハッド', has: 'ハズ', have: 'ハヴ', he: 'ヒー', her: 'ハー', him: 'ヒム',
  his: 'ヒズ', is: 'イズ', must: 'マスト', of: 'オヴ', shall: 'シャル', she: 'シー',
  should: 'シュッド', some: 'サム', than: 'ザン', that: 'ザット', the: 'ザ', them: 'ゼム',
  to: 'トゥ', us: 'アス', was: 'ワズ', we: 'ウィー', were: 'ワー', who: 'フー',
  would: 'ウッド', you: 'ユー', your: 'ユア', are: 'アー', am: 'アム', been: 'ビーン',
  or: 'オア', not: 'ノット', there: 'ゼア',
  // 頻出の内容語（リンキング・フラップ・脱落の例に出やすい語）
  water: 'ウォーター', better: 'ベター', little: 'リトル', city: 'シティ',
  got: 'ガット', get: 'ゲット', it: 'イット', on: 'オン', in: 'イン',
  want: 'ウォント', went: 'ウェント', turned: 'ターンド', next: 'ネクスト', day: 'デイ',
  just: 'ジャスト', now: 'ナウ', out: 'アウト', up: 'アップ', about: 'アバウト',
  all: 'オール', one: 'ワン', good: 'グッド', put: 'プット', off: 'オフ',
};

/**
 * フラップ（母音に挟まれたt）を含む語の、フラップ発音の読み（人手で記載）。
 * 「tがラ行化した読み」は機械合成すると誤りやすいため、代表語のみ直接持つ。
 */
const FLAP_READINGS: Record<string, string> = {
  water: 'ワラ',
  better: 'ベラ',
  little: 'リロ',
  city: 'スィリ',
};

/**
 * カタカナ読み合成用: 子音ごとの「子音+ア/イ/ウ/エ/オ」のカタカナ。
 * ティ/トゥ/ディ/ドゥ等の不規則形を正しく出すため配列で持つ。
 */
const MERGE_ROWS: Record<string, [string, string, string, string, string]> = {
  k: ['カ', 'キ', 'ク', 'ケ', 'コ'],
  g: ['ガ', 'ギ', 'グ', 'ゲ', 'ゴ'],
  s: ['サ', 'スィ', 'ス', 'セ', 'ソ'],
  z: ['ザ', 'ズィ', 'ズ', 'ゼ', 'ゾ'],
  t: ['タ', 'ティ', 'トゥ', 'テ', 'ト'],
  d: ['ダ', 'ディ', 'ドゥ', 'デ', 'ド'],
  n: ['ナ', 'ニ', 'ヌ', 'ネ', 'ノ'],
  b: ['バ', 'ビ', 'ブ', 'ベ', 'ボ'],
  p: ['パ', 'ピ', 'プ', 'ペ', 'ポ'],
  m: ['マ', 'ミ', 'ム', 'メ', 'モ'],
  r: ['ラ', 'リ', 'ル', 'レ', 'ロ'],
  f: ['ファ', 'フィ', 'フ', 'フェ', 'フォ'],
  v: ['ヴァ', 'ヴィ', 'ヴ', 'ヴェ', 'ヴォ'],
};

/** 読みの末尾カタカナ → その子音（合成可能なもののみ。ー/ン以外の母音終わり等は合成しない）。 */
const FINAL_KANA_CONSONANT: Record<string, string> = {
  ク: 'k', グ: 'g', ス: 's', ズ: 'z', ト: 't', ド: 'd', ン: 'n',
  ブ: 'b', プ: 'p', ム: 'm', ル: 'r', フ: 'f', ヴ: 'v',
};

const VOWEL_KANA = 'アイウエオ';
const SMALL_KANA = 'ァィゥェォャュョ';

/**
 * ペアの読みを連結発音として合成する（例: ターンド + オン → ターンドン）。
 * 合成できる確信が持てない組み合わせ（後続がウォ等のw音、前語が母音終わり等）はnullを返し、
 * 呼び出し側はカタカナヒント自体を付けない（誤ったカタカナを出さない方針）。
 *
 * @param flap trueならt脱落ではなくフラップとして、結合音をラ行にする（例: ガット + ア → ガラ）。
 */
function mergePairReading(reading1: string, reading2: string, flap: boolean): string | null {
  const vowelIdx = VOWEL_KANA.indexOf(reading2[0]);
  if (vowelIdx < 0) return null;
  // 「ウォ」「ウィ」等は母音ではなくw音なので合成対象外
  if (reading2.length > 1 && SMALL_KANA.includes(reading2[1])) return null;

  const lastKana = reading1[reading1.length - 1];
  const consonant = FINAL_KANA_CONSONANT[lastKana];
  if (!consonant) return null;

  const row = MERGE_ROWS[flap ? 'r' : consonant];
  let stem = reading1.slice(0, -1);
  // フラップ合成では促音を落とす（ガッ+ラ→ガラ。「ガッラ」は不自然なため）
  if (flap && stem.endsWith('ッ')) stem = stem.slice(0, -1);
  return stem + row[vowelIdx] + reading2.slice(1);
}

/** 語末破裂音の読み（ト/ド/ク/グ/プ/ブ）を落として後続語と連結する（例: ネクスト + デイ → ネクスデイ）。 */
function elisionReading(reading1: string, reading2: string): string | null {
  const lastKana = reading1[reading1.length - 1];
  if (!'トドクグプブ'.includes(lastKana)) return null;
  return reading1.slice(0, -1) + reading2;
}

/** 表示用: 前後の約物だけ除去し、大文字小文字は原文のまま残す。 */
function displayWord(word: string): string {
  const cleaned = word.replace(/^[^A-Za-z']+/, '').replace(/[^A-Za-z']+$/, '');
  return cleaned.length > 0 ? cleaned : word;
}

function displayWords(issue: PhenomenonIssue): string {
  return issue.words.map(displayWord).join(' ');
}

/**
 * カタカナヒント（DESIGN.md §8 5b M8: 辞書に検出語（ペアは両方）が載っている場合のみ合成して付ける）。
 * 辞書に無い語・合成の確信が持てない組み合わせは空文字列（=文字ベース説明のみ）。
 */
function phenomenonKatakanaSuffix(issue: PhenomenonIssue): string {
  const words = issue.words.map(stripPunct);
  switch (issue.type) {
    case 'linking': {
      if (words.length < 2) return '';
      const r1 = KATAKANA_DICT[words[0]];
      const r2 = KATAKANA_DICT[words[1]];
      if (!r1 || !r2) return '';
      const merged = mergePairReading(r1, r2, false);
      return merged ? `（「${merged}」のような音です）` : '';
    }
    case 'flap': {
      if (words.length === 1) {
        const flapReading = FLAP_READINGS[words[0]];
        return flapReading ? `（「${flapReading}」のような音です）` : '';
      }
      const r1 = KATAKANA_DICT[words[0]];
      const r2 = KATAKANA_DICT[words[1]];
      if (!r1 || !r2) return '';
      const merged = mergePairReading(r1, r2, true);
      return merged ? `（「${merged}」のような音です）` : '';
    }
    case 'elision': {
      if (words.length < 2) return '';
      const r1 = KATAKANA_DICT[words[0]];
      const r2 = KATAKANA_DICT[words[1]];
      if (!r1 || !r2) return '';
      const merged = elisionReading(r1, r2);
      return merged ? `（「${merged}」のような音です）` : '';
    }
    case 'weak': {
      const reading = KATAKANA_DICT[words[0]];
      return reading ? `（弱く短い「${reading}」のような音です）` : '';
    }
    case 'ending':
      // 語尾指摘の対象は活用形（wanted等）で辞書に無く、弱化した語尾の読み合成は誤りやすいため付けない
      return '';
  }
}

/** 現象の説明を、検出された実際の語の綴りから取り出した文字で組み立てる（DESIGN.md §8 5b M8）。 */
function phenomenonCoreClause(issue: PhenomenonIssue): string {
  const disp = displayWords(issue);
  const words = issue.words.map(stripPunct);
  switch (issue.type) {
    case 'linking': {
      const c1 = words[0].slice(-1);
      const c2 = words[1]?.slice(0, 1) ?? '';
      return `${disp} は ${c1} と ${c2} がつながって1語のように聞こえます`;
    }
    case 'flap':
      return words.length === 1
        ? `${disp} の t が弱いラ行のような音になります`
        : `${disp} は t が弱いラ行のような音になってつながります`;
    case 'elision': {
      const c1 = words[0].slice(-1);
      return `${disp} は ${c1} の音がほとんど落ちます`;
    }
    case 'weak':
      return `${disp} は弱く速く発音されます`;
    case 'ending': {
      const suffix = words[0].endsWith('d') ? '-ed' : '-s';
      return `${disp} の語尾 ${suffix} が弱くなります`;
    }
  }
}

/** 同typeにまとめた指摘グループを1つのDevelopment Point文言にする（最大2ペアまで列挙）。 */
function buildPhenomenonDevPoint(type: PhenomenonType, group: PhenomenonIssue[]): string {
  const first = group[0];
  // M15: お手本音声で連結が実際に確認できたペアは、「お手本ではこう発音している」根拠つきの文言にする
  // （prioritizeIssuesがreferenceLinkedを優先するため、該当があればgroup先頭に来る）。
  if (first.referenceLinked) {
    const lead = `お手本では「${displayWords(first)}」を繋げて発音していますが、言えていませんでした。`;
    return `${lead}${phenomenonCoreClause(first)}${phenomenonKatakanaSuffix(first)}。`;
  }
  const names = group
    .slice(0, 2)
    .map((issue) => `「${displayWords(issue)}」`)
    .join('');
  const lead =
    group.length >= 2
      ? `${names}のような${PHENOMENON_LABEL[type]}が言えていませんでした。`
      : `${names}の${PHENOMENON_LABEL[type]}が言えていませんでした。`;
  return `${lead}${phenomenonCoreClause(first)}${phenomenonKatakanaSuffix(first)}。`;
}

/** 同一文言の重複を除去する（DESIGN.md §8 5b M8: 同じ提出内で同一文言を繰り返さない）。 */
function dedupe(candidates: string[]): string[] {
  return [...new Set(candidates)];
}

/**
 * Good Point / Development Pointをルールベースで各3件生成する（DESIGN.md §8手順5）。
 * 条件に当てはまるルールを優先度順に評価し、上位3件を採用する。3件に満たない場合は
 * 汎用的な励まし文言で補う（発生頻度は低いが、matchRate=1.0でmissed/subが無い場合などに起こる）。
 */
export function generateFeedback(input: FeedbackInput): FeedbackResult {
  const { wordMarks, sentences, wpm, referenceWpm, previousMatchRate } = input;
  const matchRate = computeMatchRate(wordMarks);
  const matchRatePercent = Math.round(matchRate * 100);
  const matchedCount = wordMarks.filter((w) => w.status === 'ok').length;
  const subCount = wordMarks.filter((w) => w.status === 'sub').length;
  const insertionsCount = input.insertions?.length ?? 0;
  // Whisperが実際に認識した語数の目安（スクリプトに対応した語 + 対応しない挿入語）。
  const recognizedWordCount = matchedCount + subCount + insertionsCount;
  // DESIGN.md §8 5b: 音声現象の検出結果を優先度順（同一typeの多発>単発）に3件へ絞る。
  const topIssues = prioritizeIssues(input.issues ?? [], DEV_POINTS_COUNT);
  const improvedPreviousIssues = (input.previousIssueOutcomes ?? []).filter((o) => o.improved);

  const goodCandidates: string[] = [];
  const devCandidates: string[] = [];

  // 認識語がほぼ無い（空認識・雑音のみ等）場合は、他の指摘より優先して原因の心当たりを案内する。
  // このとき速度系のコメントはwpm≈0による無意味な倍率（「約150倍ゆっくり」等）になるため抑止する。
  const lowRecognition = wordMarks.length > 0 && recognizedWordCount / wordMarks.length < LOW_RECOGNITION_RATIO;
  if (lowRecognition) {
    devCandidates.push('音声がほとんど認識できませんでした。マイク位置とイヤホン使用を確認してください。');
  }

  // --- Good Points ---

  // 前回指摘の音声現象が改善していれば、他のGood Pointより最優先で採用する（DESIGN.md §8 5b）。
  for (const outcome of improvedPreviousIssues) {
    goodCandidates.push(
      `前回指摘した「${outcome.words.join(' ')}」の${PHENOMENON_LABEL[outcome.type]}が改善していました。`,
    );
  }

  const streak = longestOkStreak(wordMarks);
  if (streak && streak.length >= NOTABLE_STREAK_MIN_LENGTH) {
    goodCandidates.push(
      `「${truncateForDisplay(streak.text)}」の${streak.length}語を、つっかえずに言えていました。`,
    );
  }

  if (previousMatchRate !== undefined) {
    const deltaPercent = Math.round((matchRate - previousMatchRate) * 100);
    if (deltaPercent > 0) {
      goodCandidates.push(`前回の一致率${Math.round(previousMatchRate * 100)}%から${deltaPercent}pt改善しました。`);
    }
  }

  if (!lowRecognition && referenceWpm !== undefined && referenceWpm > 0) {
    const ratio = wpm / referenceWpm;
    if (Math.abs(ratio - 1) <= WPM_TOLERANCE_RATIO) {
      goodCandidates.push(
        `話す速さがお手本（${Math.round(referenceWpm)} WPM）に近く、${Math.round(wpm)} WPMで発話できていました。`,
      );
    }
  }

  // M15: お手本音声との比較（間・抑揚）。referenceComparisonが無ければ何も出さない。
  const rc = input.referenceComparison;
  if (rc) {
    // 上限だけでなく下限も見る: 間が大幅に少ない（間を飛ばした早口読み）を「お手本並みのリズム」と
    // 褒めない。文言は+1箇所の許容と矛盾しないよう「ほとんど無く」に留める（比較カードの表示と整合）。
    if (
      rc.userPauseCount >= rc.referencePauseCount - 1 &&
      rc.userPauseCount <= rc.referencePauseCount + 1 &&
      matchRate >= 0.6
    ) {
      goodCandidates.push('お手本と同じようなリズムで、余分な間（ポーズ）がほとんど無く読み進められていました。');
    }
    if (
      rc.userPitchSd !== undefined &&
      rc.referencePitchSd !== undefined &&
      rc.referencePitchSd >= PITCH_MIN_MEANINGFUL_SD &&
      rc.userPitchSd >= rc.referencePitchSd * PITCH_GOOD_RATIO
    ) {
      goodCandidates.push('お手本と同じくらい抑揚のある話し方ができていました。');
    }
  }

  if (matchRate >= 0.85) {
    goodCandidates.push(`スクリプト全体の一致率が${matchRatePercent}%と高く、全体的によく聞き取れる発話でした。`);
  } else if (matchRate >= 0.6) {
    goodCandidates.push(`一致率${matchRatePercent}%で、スクリプトの半分以上をしっかり発話できていました。`);
  }

  if (matchedCount > 0 && matchRate >= NO_INSERTION_PRAISE_MIN_MATCH_RATE && insertionsCount === 0) {
    goodCandidates.push('スクリプトに無い言葉を付け足すことなく、原文に忠実に発話できていました。');
  }

  // --- Development Points ---

  // 音声現象ベースの指摘（DESIGN.md §8 5b）を一般指摘より優先する。3件に満たない場合のみ
  // 以降の一般指摘（missed集中文など）で補う。
  // M8: 同typeの指摘は1つの文言にまとめ、実語ペアを最大2つ列挙する（固定例文は使わない）。
  const issuesByType = new Map<PhenomenonType, PhenomenonIssue[]>();
  for (const issue of topIssues) {
    const group = issuesByType.get(issue.type) ?? [];
    group.push(issue);
    issuesByType.set(issue.type, group);
  }
  for (const [type, group] of issuesByType) {
    devCandidates.push(buildPhenomenonDevPoint(type, group));
  }

  const worstSentence = findWorstSentence(wordMarks, sentences);
  if (worstSentence && worstSentence.text) {
    devCandidates.push(
      `「${truncateForDisplay(worstSentence.text)}」の文で${worstSentence.missedCount}語ほど聞き取れていません。この文を重点的に練習しましょう。`,
    );
  }

  if (!lowRecognition && referenceWpm !== undefined && referenceWpm > 0) {
    const ratio = wpm / referenceWpm;
    if (ratio < 1 - WPM_TOLERANCE_RATIO) {
      // M15: 「1.2倍ゆっくり」のような倍率表現にする（WPMだけより差が直感的に伝わるため）。
      const factor = (referenceWpm / Math.max(wpm, 1)).toFixed(1);
      devCandidates.push(
        `お手本の約${factor}倍ゆっくり（あなた${Math.round(wpm)} WPM / お手本${Math.round(referenceWpm)} WPM）でした。まずは正確さ優先でOKですが、次はお手本のリズムに乗ってみましょう。`,
      );
    } else if (ratio > 1 + WPM_TOLERANCE_RATIO) {
      const factor = (wpm / referenceWpm).toFixed(1);
      devCandidates.push(
        `お手本の約${factor}倍速い${Math.round(wpm)} WPM（お手本${Math.round(referenceWpm)} WPM）でした。焦らず、お手本の間の取り方まで真似てみましょう。`,
      );
    }
  }

  // M15: お手本に無い余分な間（ポーズ）と、抑揚の平坦さの指摘。
  if (rc) {
    if (rc.userPauseCount >= rc.referencePauseCount + EXTRA_PAUSE_COUNT_DIFF) {
      const extra = rc.userPauseCount - rc.referencePauseCount;
      devCandidates.push(
        `お手本に無い間（ポーズ）が${extra}箇所ほどありました。つっかえた箇所を確認して、文の切れ目以外では止まらずに言える練習をしてみましょう。`,
      );
    }
    if (
      rc.userPitchSd !== undefined &&
      rc.referencePitchSd !== undefined &&
      rc.referencePitchSd >= PITCH_MIN_MEANINGFUL_SD &&
      rc.userPitchSd < rc.referencePitchSd * PITCH_FLAT_RATIO
    ) {
      devCandidates.push(
        'お手本より平坦な話し方になっています。強調される語で声の高さが動く箇所を、お手本を真似して大きめに付けてみましょう。',
      );
    }
  }

  if (subCount > 0) {
    devCandidates.push(
      `${subCount}箇所で、スクリプトと異なる語として認識されました。発音や語順を意識して聴き直してみましょう。`,
    );
  }

  if (previousMatchRate !== undefined) {
    const deltaPercent = Math.round((matchRate - previousMatchRate) * 100);
    if (deltaPercent < 0) {
      devCandidates.push(
        `前回の一致率${Math.round(previousMatchRate * 100)}%より${Math.abs(deltaPercent)}pt下がっています。もう一度スクリプトを確認してから挑戦してみましょう。`,
      );
    }
  }

  if (matchRate < 0.85) {
    devCandidates.push(
      `一致率は${matchRatePercent}%でした。0.85（85%）を超えると次の教材への切り替えを提案します。`,
    );
  }

  // M8: 同じ提出内で同一文言が重複しないよう、候補段階で完全一致の重複を除去する。
  const goodPoints = fillToCount(dedupe(goodCandidates), GOOD_POINTS_COUNT, GENERIC_GOOD_FALLBACKS, matchRatePercent);
  const devPoints = fillToCount(dedupe(devCandidates), DEV_POINTS_COUNT, GENERIC_DEV_FALLBACKS, matchRatePercent);

  return { goodPoints, devPoints, issues: topIssues };
}

const GENERIC_GOOD_FALLBACKS = [
  'お手本を意識して最後まで発話をやり切りました。継続できていること自体が素晴らしいです。',
  '録音・提出という一連の練習フローにしっかり取り組めています。',
  'この調子で他の文でも同じ精度を目指してみましょう。',
];

const GENERIC_DEV_FALLBACKS = [
  '次はスピードの変化にも挑戦してみましょう。',
  'スクリプトを見ながらもう一度お手本と聴き比べてみましょう。',
  '同じ教材を数日続けて、耳と口を慣らしていきましょう。',
];

function fillToCount(candidates: string[], count: number, fallbacks: string[], matchRatePercent: number): string[] {
  const result = [...candidates];
  let fallbackIndex = 0;
  while (result.length < count && fallbackIndex < fallbacks.length) {
    const fallback = fallbacks[fallbackIndex];
    if (!result.includes(fallback)) result.push(fallback);
    fallbackIndex += 1;
  }
  // フォールバックを使い切ってもまだ足りない場合の最終手段（理論上ほぼ発生しない）。
  while (result.length < count) {
    result.push(`一致率${matchRatePercent}%でした。引き続き練習を続けましょう。`);
  }
  return result.slice(0, count);
}

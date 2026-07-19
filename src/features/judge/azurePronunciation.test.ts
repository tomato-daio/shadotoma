import { describe, expect, it, vi } from 'vitest';
import {
  AzurePronunciationAuthError,
  AzurePronunciationNetworkError,
  AzurePronunciationNoResultError,
  AzurePronunciationTimeoutError,
  aggregatePhraseAssessments,
  describeAzureError,
  resolveRecognitionOutcome,
  toPhraseAssessment,
  truncateDetail,
  worstWords,
  type AzureDetailResultLike,
  type PhraseAssessment,
} from './azurePronunciation';

function makeDetail(overrides: Partial<AzureDetailResultLike> = {}): AzureDetailResultLike {
  return {
    Words: [
      { Word: 'hello', PronunciationAssessment: { AccuracyScore: 90, ErrorType: 'None' } },
      { Word: 'world', PronunciationAssessment: { AccuracyScore: 70, ErrorType: 'Mispronunciation' } },
    ],
    PronunciationAssessment: {
      AccuracyScore: 80,
      FluencyScore: 85,
      CompletenessScore: 100,
      PronScore: 82,
      ProsodyScore: 75,
    },
    ...overrides,
  };
}

function makePhrase(overrides: Partial<PhraseAssessment> = {}): PhraseAssessment {
  return {
    durationTicks: 10_000_000, // 1秒相当(100ns単位)
    pronScore: 80,
    accuracyScore: 80,
    fluencyScore: 80,
    completenessScore: 80,
    prosodyScore: 80,
    words: [],
    ...overrides,
  };
}

describe('toPhraseAssessment', () => {
  it('detailResultをPhraseAssessmentへ変換する', () => {
    const result = toPhraseAssessment(makeDetail(), 20_000_000);
    expect(result).toEqual({
      durationTicks: 20_000_000,
      pronScore: 82,
      accuracyScore: 80,
      fluencyScore: 85,
      completenessScore: 100,
      prosodyScore: 75,
      words: [
        { word: 'hello', accuracyScore: 90, errorType: 'None' },
        { word: 'world', accuracyScore: 70, errorType: 'Mispronunciation' },
      ],
    });
  });

  it('PronunciationAssessmentが欠けている場合は0を既定値にする', () => {
    const result = toPhraseAssessment({}, 1000);
    expect(result.pronScore).toBe(0);
    expect(result.accuracyScore).toBe(0);
    expect(result.fluencyScore).toBe(0);
    expect(result.completenessScore).toBe(0);
    expect(result.prosodyScore).toBe(0);
    expect(result.words).toEqual([]);
  });

  it('負のdurationは0にクリップする', () => {
    const result = toPhraseAssessment(makeDetail(), -5);
    expect(result.durationTicks).toBe(0);
  });

  it('単語ごとのPronunciationAssessmentが無い場合はaccuracyScore 0・errorType未設定にする', () => {
    const result = toPhraseAssessment({ Words: [{ Word: 'foo' }] }, 100);
    expect(result.words).toEqual([{ word: 'foo', accuracyScore: 0, errorType: undefined }]);
  });
});

describe('aggregatePhraseAssessments', () => {
  it('フレーズが0件ならnullを返す', () => {
    expect(aggregatePhraseAssessments([])).toBeNull();
  });

  it('1件だけならそのままの値になる', () => {
    const result = aggregatePhraseAssessments([makePhrase({ pronScore: 77 })]);
    expect(result?.pronScore).toBe(77);
  });

  it('音声長で加重平均する（長い方の影響が大きい）', () => {
    const short = makePhrase({ durationTicks: 1000, pronScore: 100, words: [{ word: 'a', accuracyScore: 100 }] });
    const long = makePhrase({ durationTicks: 9000, pronScore: 0, words: [{ word: 'b', accuracyScore: 0 }] });
    const result = aggregatePhraseAssessments([short, long]);
    // (100*1000 + 0*9000) / 10000 = 10
    expect(result?.pronScore).toBe(10);
  });

  it('durationが全て0のときは等重み（単純平均）にフォールバックする', () => {
    const a = makePhrase({ durationTicks: 0, pronScore: 60 });
    const b = makePhrase({ durationTicks: 0, pronScore: 80 });
    const result = aggregatePhraseAssessments([a, b]);
    expect(result?.pronScore).toBe(70);
  });

  it('全フレーズのwordsを結合する', () => {
    const a = makePhrase({ words: [{ word: 'a', accuracyScore: 90 }] });
    const b = makePhrase({ words: [{ word: 'b', accuracyScore: 50 }] });
    const result = aggregatePhraseAssessments([a, b]);
    expect(result?.words).toEqual([
      { word: 'a', accuracyScore: 90 },
      { word: 'b', accuracyScore: 50 },
    ]);
  });

  it('5項目それぞれ独立して加重平均する', () => {
    const a = makePhrase({
      durationTicks: 1,
      pronScore: 10,
      accuracyScore: 20,
      fluencyScore: 30,
      completenessScore: 40,
      prosodyScore: 50,
    });
    const result = aggregatePhraseAssessments([a]);
    expect(result).toMatchObject({
      pronScore: 10,
      accuracyScore: 20,
      fluencyScore: 30,
      completenessScore: 40,
      prosodyScore: 50,
    });
  });
});

describe('worstWords', () => {
  it('accuracyScoreの低い順に並べる', () => {
    const words = [
      { word: 'a', accuracyScore: 90 },
      { word: 'b', accuracyScore: 30 },
      { word: 'c', accuracyScore: 60 },
    ];
    expect(worstWords(words).map((w) => w.word)).toEqual(['b', 'c', 'a']);
  });

  it('既定で最大5件までに絞る', () => {
    const words = Array.from({ length: 10 }, (_, i) => ({ word: `w${i}`, accuracyScore: i }));
    expect(worstWords(words)).toHaveLength(5);
    expect(worstWords(words).map((w) => w.word)).toEqual(['w0', 'w1', 'w2', 'w3', 'w4']);
  });

  it('limit引数で件数を変えられる', () => {
    const words = [
      { word: 'a', accuracyScore: 90 },
      { word: 'b', accuracyScore: 30 },
      { word: 'c', accuracyScore: 60 },
    ];
    expect(worstWords(words, 2).map((w) => w.word)).toEqual(['b', 'c']);
  });

  it('元の配列を破壊しない', () => {
    const words = [
      { word: 'a', accuracyScore: 90 },
      { word: 'b', accuracyScore: 30 },
    ];
    const copy = [...words];
    worstWords(words);
    expect(words).toEqual(copy);
  });

  it('空配列を渡すと空配列を返す', () => {
    expect(worstWords([])).toEqual([]);
  });
});

describe('describeAzureError', () => {
  it('AzurePronunciationTimeoutErrorのメッセージをそのまま返す', () => {
    expect(describeAzureError(new AzurePronunciationTimeoutError())).toBe('発音スコアの取得がタイムアウトしました。');
  });

  it('AzurePronunciationNoResultErrorのメッセージをそのまま返す', () => {
    expect(describeAzureError(new AzurePronunciationNoResultError())).toContain('認識結果が得られませんでした');
  });

  it('AzurePronunciationAuthErrorのメッセージをそのまま返す(キー無効/401系)', () => {
    expect(describeAzureError(new AzurePronunciationAuthError())).toContain('APIキーが無効です');
  });

  it('AzurePronunciationNetworkErrorのメッセージをそのまま返す', () => {
    expect(describeAzureError(new AzurePronunciationNetworkError('offline'))).toContain('接続に失敗しました');
  });

  it('未知のErrorは一行の日本語メッセージに包む（DESIGN.md §8c M10の例の書式）', () => {
    const message = describeAzureError(new Error('boom'));
    expect(message).toBe('発音スコアの取得に失敗しました: boom');
  });

  it('Error以外（文字列等）が投げられても壊れない', () => {
    const message = describeAzureError('plain string error');
    expect(message).toBe('発音スコアの取得に失敗しました: plain string error');
  });

  it('長いエラー詳細は120字程度に切り詰めて含める（DESIGN.md §8c M10）', () => {
    const longDetail = 'x'.repeat(200);
    const message = describeAzureError(new Error(longDetail));
    // 「発音スコアの取得に失敗しました: 」+ 120字 + '…'
    expect(message.startsWith('発音スコアの取得に失敗しました: ')).toBe(true);
    expect(message).toContain('…');
    expect(message.length).toBeLessThan(150);
  });

  it('AzurePronunciationNetworkErrorの詳細も切り詰められる（メッセージが長すぎて1行表示を壊さないように）', () => {
    const longDetail = 'y'.repeat(300);
    const err = new AzurePronunciationNetworkError(longDetail);
    expect(err.message).toContain('…');
    expect(err.message.length).toBeLessThan(200);
  });
});

describe('resolveRecognitionOutcome', () => {
  // iOS Safari(WebKit)のSDK後片付けバグで実際に観測されたエラー文言。
  const teardownError = new Error(
    "undefined is not an object (evaluating 'this.privSource.turnOff().then')",
  );

  it('フレーズ1件以上・エラーなしなら、そのままフレーズを返す', () => {
    const phrases = [makePhrase()];
    expect(resolveRecognitionOutcome(phrases, null)).toBe(phrases);
  });

  it('フレーズ1件以上なら、後片付け例外が記録されていても成功として返す（M10追補: iOS Safari対策）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const phrases = [makePhrase({ pronScore: 88 })];
      const result = resolveRecognitionOutcome(phrases, teardownError);
      expect(result).toBe(phrases);
      // 無視したエラーはconsole.warnに残す
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0][1]).toBe(teardownError);
    } finally {
      warn.mockRestore();
    }
  });

  it('フレーズ0件・エラーありなら、そのエラーを投げる（別原因の切り分け用）', () => {
    expect(() => resolveRecognitionOutcome([], teardownError)).toThrow(teardownError);
  });

  it('フレーズ0件・エラーありのとき、Azure固有エラー型もそのまま投げる', () => {
    const authError = new AzurePronunciationAuthError();
    expect(() => resolveRecognitionOutcome([], authError)).toThrow(authError);
  });

  it('フレーズ0件・エラーなしなら空配列を返す（呼び出し側が結果ゼロとして扱う）', () => {
    expect(resolveRecognitionOutcome([], null)).toEqual([]);
  });
});

describe('truncateDetail', () => {
  it('maxLength以下ならそのまま返す', () => {
    expect(truncateDetail('short text')).toBe('short text');
  });

  it('前後の空白を取り除く', () => {
    expect(truncateDetail('  short text  ')).toBe('short text');
  });

  it('既定(120字)を超える場合は120字+…に切り詰める', () => {
    const detail = 'a'.repeat(150);
    const result = truncateDetail(detail);
    expect(result).toBe(`${'a'.repeat(120)}…`);
  });

  it('maxLength引数で切り詰め長を指定できる', () => {
    expect(truncateDetail('abcdefghij', 5)).toBe('abcde…');
  });

  it('ちょうどmaxLengthの長さなら…を付けない', () => {
    const detail = 'a'.repeat(120);
    expect(truncateDetail(detail)).toBe(detail);
  });
});

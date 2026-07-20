/**
 * お手本音声の解析（M15・DESIGN.md §8f）。
 *
 * お手本mp3をデコードし、(1)DSPプロファイル（速度・間・抑揚。referenceComparison.ts）と
 * (2)単語タイムスタンプ付きWhisper文字起こし（_timestampedモデル）を取り、
 * referenceAnalysisストアへ教材単位でキャッシュする。2回目以降の提出ではキャッシュを返すだけ。
 *
 * Azure採点と同じ「完全に付加的」な思想で、ここでの失敗は例外を外へ出さずnullで返す
 * （呼び出し側=runJudgeはお手本比較なしの従来動作へ縮退する）。
 */

import { countWords, decodeToMono16k, WHISPER_SAMPLE_RATE } from '../../lib/audio';
import {
  getReferenceAnalysis,
  putReferenceAnalysis,
  type Material,
  type ReferenceAnalysisRecord,
} from '../../lib/db';
import { validateTimedWords } from '../../lib/linkingRealization';
import { buildSpeechProfile } from '../../lib/referenceComparison';
import { transcribeAudio } from './whisper';
import { whisperTimestampedModelIdFor, type WhisperModelKey } from './whisperModels';

/** 進捗通知（runJudgeのJudgeProgressCallbackと構造互換。循環importを避けるためここで定義）。 */
export type ReferenceAnalysisProgressCallback = (event: {
  phase: 'reference-analysis' | 'model-download';
  progress?: number;
}) => void;

/** お手本音声のBlobを取得する（local=保存済みBlob / bundled=配信URLからfetch）。 */
async function fetchReferenceBlob(material: Material): Promise<Blob | null> {
  if (material.source === 'local') {
    return material.audioBlob ?? null;
  }
  if (!material.audioUrl) return null;
  const res = await fetch(`${import.meta.env.BASE_URL}${material.audioUrl}`);
  if (!res.ok) return null;
  return res.blob();
}

/**
 * 教材のお手本解析結果を返す（キャッシュがあれば即返し、無ければ解析して保存する）。
 * 失敗時はnull（お手本比較なしへの縮退。判定本体には影響させない）。
 */
export async function ensureReferenceAnalysis(args: {
  material: Material;
  modelKey: WhisperModelKey;
  onProgress?: ReferenceAnalysisProgressCallback;
}): Promise<ReferenceAnalysisRecord | null> {
  const { material, modelKey, onProgress } = args;
  try {
    const cached = await getReferenceAnalysis(material.id);
    if (cached && cached.modelKey === modelKey) return cached;

    const blob = await fetchReferenceBlob(material);
    if (!blob) return null;

    const pcm = await decodeToMono16k(blob);
    // transcribeAudioはpcmをtransferableで手放すため、DSPプロファイルと長さは転送前に計算する。
    const profile = buildSpeechProfile(pcm, WHISPER_SAMPLE_RATE);
    const pcmDurationSec = pcm.length / WHISPER_SAMPLE_RATE;

    onProgress?.({ phase: 'reference-analysis' });
    const { text, words } = await transcribeAudio(
      pcm,
      whisperTimestampedModelIdFor(modelKey),
      { wordTimestamps: true },
      (event) => {
        // timestampedモデルの初回DL進捗だけは転送する。transcribing通知は握りつぶし、
        // 外側の「お手本音声を解析中…」フェーズ表示を維持する。
        if (event.phase === 'model-download') {
          onProgress?.({ phase: 'model-download', progress: event.progress });
        }
      },
    );

    const validatedWords = validateTimedWords(words ?? undefined, countWords(text), pcmDurationSec);

    const record: ReferenceAnalysisRecord = {
      materialId: material.id,
      modelKey,
      analyzedAt: Date.now(),
      pcmDurationSec,
      profile,
      transcript: text,
      words: validatedWords ?? undefined,
    };
    await putReferenceAnalysis(record);
    return record;
  } catch {
    // お手本解析は付加機能。失敗しても判定本体を壊さない（次回提出時に再試行される）。
    return null;
  }
}

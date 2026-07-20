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
  // 低速回線でのストールが判定結果の表示を長時間ブロックしないよう、fetchには上限を設ける
  // （タイムアウト例外は呼び出し側のcatchがnull縮退として処理する）。
  const res = await fetch(`${import.meta.env.BASE_URL}${material.audioUrl}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  return res.blob();
}

/**
 * このセッション中に解析へ失敗した教材×モデル（負のキャッシュ）。
 * 失敗のたびにワーカー破棄→通常モデルの再構築コストを全提出で繰り返さないよう、
 * 同一セッション内の再試行を抑止する（ページ再読込で自然に再試行される）。
 */
const failedAnalyses = new Set<string>();

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
  const failKey = `${material.id}:${modelKey}`;
  if (failedAnalyses.has(failKey)) return null;
  try {
    const cached = await getReferenceAnalysis(material.id);
    // modelKey一致に加え、同一IDのまま音声が差し替わったケース（記事の再分割等）を
    // durationSecの乖離で検知して再解析する（±1.5秒はmp3デコードのパディング吸収用）。
    if (
      cached &&
      cached.modelKey === modelKey &&
      (material.durationSec === undefined || Math.abs(cached.pcmDurationSec - material.durationSec) <= 1.5)
    ) {
      return cached;
    }

    // フェーズ通知はfetchの前に出す（低速回線でのfetch/decode中に前フェーズの
    // 「文字起こし中…」表示が残り続けるのを防ぐ）。
    onProgress?.({ phase: 'reference-analysis' });

    const blob = await fetchReferenceBlob(material);
    if (!blob) return null;

    const pcm = await decodeToMono16k(blob);
    // transcribeAudioはpcmをtransferableで手放すため、DSPプロファイルと長さは転送前に計算する。
    const profile = buildSpeechProfile(pcm, WHISPER_SAMPLE_RATE);
    const pcmDurationSec = pcm.length / WHISPER_SAMPLE_RATE;

    const { text, words } = await transcribeAudio(
      pcm,
      whisperTimestampedModelIdFor(modelKey),
      { wordTimestamps: true },
      (event) => {
        if (event.phase === 'model-download') {
          // timestampedモデルのDL/読込進捗は転送する（transformers.jsはCache API読込でも発火する）。
          onProgress?.({ phase: 'model-download', progress: event.progress });
        } else {
          // transcribing = モデル読込完了・お手本推論の開始。表示を「お手本音声を解析中…」へ
          // 戻す（戻さないと推論中ずっと「ダウンロード中…100%」表示に張り付く）。
          onProgress?.({ phase: 'reference-analysis' });
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
    // お手本解析は付加機能。失敗しても判定本体を壊さない。同一セッション内の再試行は
    // 負のキャッシュで抑止し（毎提出のワーカー破棄・再構築の連鎖を防ぐ）、
    // ページ再読込（オンライン復帰後など）で自然に再試行される。
    failedAnalyses.add(failKey);
    return null;
  }
}

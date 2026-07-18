import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { buildFallbackPrompt, copyTextToClipboard } from '../features/judge/clipboardFallback';
import { runJudge } from '../features/judge/runJudge';
import { SubmissionResultPanel, type JudgeRunStatus } from '../features/judge/SubmissionResultPanel';
import { PracticeWizard, type SubmitOutcome } from '../features/practice/PracticeWizard';
import { SubmissionHistory } from '../features/recorder/SubmissionHistory';
import { loadAudioDuration } from '../lib/audio';
import { addSubmission, getMaterial, getSubmissionsByMaterial, newId, type JudgeResult, type Material } from '../lib/db';
import { learningDate } from '../lib/dates';

export function PracticePage() {
  const { materialId } = useParams<{ materialId: string }>();
  const navigate = useNavigate();
  // undefined = 読み込み中, null = 見つからない
  const [material, setMaterial] = useState<Material | null | undefined>(undefined);
  const [refreshKey, setRefreshKey] = useState(0);

  const [judgeStatus, setJudgeStatus] = useState<JudgeRunStatus>('idle');
  const [judgeProgress, setJudgeProgress] = useState<number | null>(null);
  const [judgeError, setJudgeError] = useState<string | null>(null);
  const [lastJudge, setLastJudge] = useState<JudgeResult | null>(null);
  const [previousMatchRate, setPreviousMatchRate] = useState<number | undefined>(undefined);
  const [fallbackCopied, setFallbackCopied] = useState(false);
  const [fallbackSituation, setFallbackSituation] = useState('');

  useEffect(() => {
    if (!materialId) return;
    let cancelled = false;
    setMaterial(undefined);
    setJudgeStatus('idle');
    setJudgeProgress(null);
    setJudgeError(null);
    setLastJudge(null);
    setFallbackCopied(false);
    void getMaterial(materialId).then((m) => {
      if (!cancelled) setMaterial(m ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [materialId]);

  const audioSrc = useMemo(() => {
    if (!material) return undefined;
    if (material.source === 'local' && material.audioBlob) {
      return URL.createObjectURL(material.audioBlob);
    }
    if (material.audioUrl) {
      return `${import.meta.env.BASE_URL}${material.audioUrl}`;
    }
    return undefined;
  }, [material]);

  useEffect(() => {
    return () => {
      if (audioSrc?.startsWith('blob:')) {
        URL.revokeObjectURL(audioSrc);
      }
    };
  }, [audioSrc]);

  if (material === undefined) {
    return <div className="p-6 text-center text-sm text-neutral-400">読み込み中…</div>;
  }

  if (material === null || !materialId) {
    return (
      <div className="flex flex-col items-center gap-4 p-6 text-center">
        <p className="text-sm text-neutral-500">教材が見つかりませんでした</p>
        <button
          type="button"
          onClick={() => navigate('/')}
          className="rounded-full bg-tomato-500 px-4 py-2 text-sm font-semibold text-white"
        >
          今日の画面に戻る
        </button>
      </div>
    );
  }

  /**
   * 提出フロー（DESIGN.md §8手順4・M3申し送り事項）:
   * RecorderUIの「提出」→ 添削実行(runJudge) → Submissionにtranscript/judgeを保存 → 結果画面表示。
   * モデルDL/実行に失敗した場合は添削なしでSubmissionだけ保存し、フォールバックUIへ切り替える。
   */
  const handleSubmit = async (blob: Blob, mimeType: string): Promise<SubmitOutcome | void> => {
    const id = newId('sub');
    const date = learningDate(new Date());
    setJudgeStatus('model-download');
    setJudgeProgress(null);
    setJudgeError(null);
    setLastJudge(null);
    setFallbackCopied(false);

    try {
      const [previousSubs, recordingDurationSec] = await Promise.all([
        getSubmissionsByMaterial(materialId),
        loadAudioDuration(blob),
      ]);
      const prevMatchRate = previousSubs.find((s) => s.judge)?.judge?.matchRate;
      setPreviousMatchRate(prevMatchRate);

      const { transcript, judge } = await runJudge({
        audioBlob: blob,
        sentences: material!.sentences,
        recordingDurationSec,
        referenceDurationSec: material!.durationSec,
        previousMatchRate: prevMatchRate,
        onProgress: (event) => {
          setJudgeStatus(event.phase);
          setJudgeProgress(event.progress ?? null);
        },
      });

      await addSubmission({ id, materialId, date, audioBlob: blob, mimeType, transcript, judge, createdAt: Date.now() });
      setLastJudge(judge);
      setJudgeStatus('done');
      setRefreshKey((k) => k + 1);
      return { matchRate: judge.matchRate };
    } catch (err) {
      // 失敗時フォールバック: 添削なしで録音だけは保存する（DESIGN.md §8手順6）
      const message = err instanceof Error ? err.message : String(err);
      await addSubmission({ id, materialId, date, audioBlob: blob, mimeType, createdAt: Date.now() });
      setJudgeError(message);
      setJudgeStatus('error');
      setFallbackSituation(`Whisperによる添削の自動実行に失敗しました（${message}）。録音は保存済みです。`);
      setRefreshKey((k) => k + 1);
      return undefined;
    }
  };

  const handleCopyFallback = async () => {
    if (!material) return;
    const prompt = buildFallbackPrompt({
      materialTitle: material.title,
      sentences: material.sentences,
      situation: fallbackSituation || '添削の自動実行に失敗しました。',
    });
    const ok = await copyTextToClipboard(prompt);
    setFallbackCopied(ok);
  };

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-4 pb-10">
      <header className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="rounded-full border border-neutral-300 px-3 py-1 text-sm text-neutral-600"
        >
          ← 戻る
        </button>
        <h1 className="flex-1 truncate text-base font-semibold text-neutral-800">{material.title}</h1>
      </header>

      {audioSrc ? (
        <PracticeWizard
          material={material}
          audioSrc={audioSrc}
          onSubmit={handleSubmit}
          onGoToMaterials={() => navigate('/materials')}
        />
      ) : (
        <p className="text-sm text-red-600">音声を読み込めませんでした</p>
      )}

      <SubmissionResultPanel
        status={judgeStatus}
        progress={judgeProgress}
        error={judgeError}
        judge={lastJudge}
        previousMatchRate={previousMatchRate}
        onCopyFallback={() => void handleCopyFallback()}
        fallbackCopied={fallbackCopied}
      />

      <section className="flex flex-col gap-2">
        <p className="text-sm font-medium text-neutral-700">提出履歴</p>
        <SubmissionHistory materialId={materialId} refreshKey={refreshKey} />
      </section>
    </div>
  );
}

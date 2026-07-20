import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { buildFallbackPrompt, copyTextToClipboard } from '../features/judge/clipboardFallback';
import { TranslationImportPanel } from '../features/materials/TranslationImportPanel';
import { runJudge } from '../features/judge/runJudge';
import { SubmissionResultPanel, type JudgeRunStatus } from '../features/judge/SubmissionResultPanel';
import { PracticeWizard, type SubmitOutcome } from '../features/practice/PracticeWizard';
import { SubmissionHistory } from '../features/recorder/SubmissionHistory';
import { loadAudioDuration } from '../lib/audio';
import {
  addSubmission,
  getMaterial,
  getSubmissionsByMaterial,
  markMaterialProgressDone,
  newId,
  type JudgeResult,
  type Material,
} from '../lib/db';
import { learningDate } from '../lib/dates';
import { NEXT_MATERIAL_SUGGEST_MATCH_RATE } from '../lib/practiceFlow';
import { createWakeLockController, type WakeLockController } from '../lib/wakeLock';

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
  // M8: 提出直後の結果画面に「あなたの発話（書き起こし）」を表示するために保持する
  const [lastTranscript, setLastTranscript] = useState<string | undefined>(undefined);
  const [previousMatchRate, setPreviousMatchRate] = useState<number | undefined>(undefined);
  const [fallbackCopied, setFallbackCopied] = useState(false);
  const [fallbackSituation, setFallbackSituation] = useState('');

  // 画面スリープ防止（DESIGN.md §6 M11）: 添削処理中（handleSubmit開始〜judge完了/失敗）に保持する。
  const wakeLockRef = useRef<WakeLockController | null>(null);
  useEffect(() => {
    wakeLockRef.current = createWakeLockController();
    return () => {
      wakeLockRef.current?.dispose();
      wakeLockRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!materialId) return;
    let cancelled = false;
    setMaterial(undefined);
    setJudgeStatus('idle');
    setJudgeProgress(null);
    setJudgeError(null);
    setLastJudge(null);
    setLastTranscript(undefined);
    setFallbackCopied(false);
    void getMaterial(materialId).then((m) => {
      if (!cancelled) setMaterial(m ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [materialId]);

  // 依存は音声の実体（audioBlob/audioUrl）だけにする。訳・語彙の取り込みでsentencesだけが
  // 変わったときにblob URLを作り直すと、練習中のプレーヤーが再マウントされてしまうため。
  const audioBlob = material?.source === 'local' ? material.audioBlob : undefined;
  const audioUrl = material?.audioUrl;
  const audioSrc = useMemo(() => {
    if (audioBlob) {
      return URL.createObjectURL(audioBlob);
    }
    if (audioUrl) {
      return `${import.meta.env.BASE_URL}${audioUrl}`;
    }
    return undefined;
  }, [audioBlob, audioUrl]);

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
    setLastTranscript(undefined);
    setFallbackCopied(false);
    // 画面スリープ防止（DESIGN.md §6 M11）: 添削処理中は画面ロックで処理が中断されないよう保持する。
    void wakeLockRef.current?.acquire();

    try {
      const [previousSubs, recordingDurationSec] = await Promise.all([
        getSubmissionsByMaterial(materialId),
        loadAudioDuration(blob),
      ]);
      const previousJudge = previousSubs.find((s) => s.judge)?.judge;
      const prevMatchRate = previousJudge?.matchRate;
      setPreviousMatchRate(prevMatchRate);

      const { transcript, judge } = await runJudge({
        audioBlob: blob,
        material: material!,
        recordingDurationSec,
        previousMatchRate: prevMatchRate,
        previousIssues: previousJudge?.issues,
        onProgress: (event) => {
          setJudgeStatus(event.phase);
          setJudgeProgress(event.progress ?? null);
        },
      });

      await addSubmission({ id, materialId, date, audioBlob: blob, mimeType, transcript, judge, createdAt: Date.now() });
      // DESIGN.md §8b前提: 提出のjudge.matchRate>=0.85でMaterialProgress.statusをdone確定する。
      if (judge.matchRate >= NEXT_MATERIAL_SUGGEST_MATCH_RATE) {
        await markMaterialProgressDone(materialId, date);
      }
      setLastJudge(judge);
      setLastTranscript(transcript);
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
    } finally {
      // 画面スリープ防止（DESIGN.md §6 M11）: judge完了・失敗のどちらでも解放する。
      wakeLockRef.current?.release();
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
        transcript={lastTranscript}
        onCopyFallback={() => void handleCopyFallback()}
        fallbackCopied={fallbackCopied}
      />

      <TranslationImportPanel material={material} onUpdated={setMaterial} />

      <section className="flex flex-col gap-2">
        <p className="text-sm font-medium text-neutral-700">提出履歴</p>
        <SubmissionHistory materialId={materialId} refreshKey={refreshKey} />
      </section>
    </div>
  );
}

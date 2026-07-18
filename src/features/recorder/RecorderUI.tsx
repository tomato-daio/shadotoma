import { useEffect, useMemo, useRef, useState } from 'react';
import { formatTime } from '../../lib/audio';
import { RATE_PRESETS } from '../player/AudioPlayer';
import { useRecorder } from './useRecorder';

export interface RecorderUIProps {
  /** お手本音声URL。録音開始と同時に自動再生し、録音後の聴き比べにも使う。 */
  referenceSrc: string;
  onSubmit: (blob: Blob, mimeType: string) => Promise<void> | void;
  className?: string;
}

type CompareTarget = 'own' | 'reference';

export function RecorderUI({ referenceSrc, onSubmit, className = '' }: RecorderUIProps) {
  const recorder = useRecorder(referenceSrc);
  const [compareTarget, setCompareTarget] = useState<CompareTarget>('own');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // recordedBlobが変わったときだけ生成する（毎レンダーで生成するとrevokeされずリークする）。
  const ownUrl = useMemo(
    () => (recorder.recordedBlob ? URL.createObjectURL(recorder.recordedBlob) : null),
    [recorder.recordedBlob],
  );

  useEffect(() => {
    return () => {
      if (ownUrl) URL.revokeObjectURL(ownUrl);
    };
  }, [ownUrl]);

  const playCompare = (target: CompareTarget) => {
    setCompareTarget(target);
    const audio = audioRef.current;
    if (!audio) return;
    audio.src = target === 'own' ? (ownUrl ?? '') : referenceSrc;
    audio.currentTime = 0;
    void audio.play();
  };

  const handleRedo = () => {
    audioRef.current?.pause();
    recorder.reset();
    setSubmitted(false);
  };

  const handleSubmit = async () => {
    if (!recorder.recordedBlob || !recorder.mimeType) return;
    setSubmitting(true);
    try {
      await onSubmit(recorder.recordedBlob, recorder.mimeType);
      setSubmitted(true);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={`flex flex-col gap-4 ${className}`}>
      <div className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
        イヤホンをつけて、お手本を流しながら録音しましょう（イヤホン無しだとお手本の音声が録音に混入します）。
      </div>

      {recorder.error ? (
        <div className="rounded-lg bg-red-50 p-3 text-xs text-red-700">{recorder.error}</div>
      ) : null}

      {!recorder.recordedBlob ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-neutral-200 p-4">
          {/* お手本の速度プリセット（録音開始前・録音中どちらでも変更可） */}
          <div className="flex w-full flex-col gap-1">
            <span className="text-xs text-neutral-500">お手本の速度</span>
            <div className="flex gap-2">
              {RATE_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => recorder.setRate(preset)}
                  className={`flex-1 rounded-md border px-2 py-1 text-xs ${
                    Math.abs(recorder.rate - preset) < 0.001
                      ? 'border-tomato-500 bg-tomato-500 text-white'
                      : 'border-neutral-300 text-neutral-600'
                  }`}
                >
                  {preset}x
                </button>
              ))}
            </div>
          </div>

          <div className="text-2xl font-mono text-neutral-700">{formatTime(recorder.elapsedSec)}</div>
          {/* レベルメーター */}
          <div className="h-3 w-full overflow-hidden rounded-full bg-neutral-100">
            <div
              className="h-full bg-tomato-500 transition-[width] duration-75"
              style={{ width: `${Math.round(recorder.level * 100)}%` }}
            />
          </div>

          {recorder.isRecording ? (
            <div className="flex w-full flex-col gap-1">
              <div className="flex justify-between text-xs text-neutral-500">
                <span>お手本の進行</span>
                <span>
                  {formatTime(recorder.referenceCurrentTime)} / {formatTime(recorder.referenceDuration)}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-100">
                <div
                  className="h-full bg-neutral-400 transition-[width] duration-75"
                  style={{
                    width: `${
                      recorder.referenceDuration > 0
                        ? Math.min(100, Math.round((recorder.referenceCurrentTime / recorder.referenceDuration) * 100))
                        : 0
                    }%`,
                  }}
                />
              </div>
              {recorder.referenceFinished ? (
                <p className="mt-1 text-xs font-semibold text-tomato-600">
                  お手本が終わりました。話し終えたら停止を押してください。
                </p>
              ) : null}
            </div>
          ) : null}

          <button
            type="button"
            onClick={recorder.isRecording ? recorder.stop : () => void recorder.start()}
            className={`rounded-full px-6 py-3 text-base font-semibold text-white active:opacity-90 ${
              recorder.isRecording ? 'bg-neutral-700' : 'bg-tomato-500'
            }`}
          >
            {recorder.isRecording ? '■ 停止' : '● 録音開始'}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-4">
          <p className="text-sm text-neutral-600">録音完了（{formatTime(recorder.elapsedSec)}）。聴き比べてみましょう。</p>
          <audio ref={audioRef} className="hidden" />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => playCompare('own')}
              className={`flex-1 rounded-md border px-3 py-2 text-sm ${
                compareTarget === 'own' ? 'border-tomato-500 bg-tomato-50 text-tomato-700' : 'border-neutral-300'
              }`}
            >
              自分の録音を再生
            </button>
            <button
              type="button"
              onClick={() => playCompare('reference')}
              className={`flex-1 rounded-md border px-3 py-2 text-sm ${
                compareTarget === 'reference' ? 'border-tomato-500 bg-tomato-50 text-tomato-700' : 'border-neutral-300'
              }`}
            >
              お手本を再生
            </button>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleRedo}
              className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-600 active:bg-neutral-100"
            >
              録り直す
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting || submitted}
              className="flex-1 rounded-md bg-tomato-500 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {submitted ? '提出済み' : submitting ? '提出中…' : '提出する'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

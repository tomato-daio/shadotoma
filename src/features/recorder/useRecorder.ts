import { useCallback, useEffect, useRef, useState } from 'react';
import { pickRecorderMimeType } from '../../lib/audio';

export interface UseRecorderResult {
  isRecording: boolean;
  elapsedSec: number;
  /** 0〜1のレベルメーター値（簡易RMS）。 */
  level: number;
  mimeType: string | undefined;
  recordedBlob: Blob | null;
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
  reset: () => void;
}

interface WindowWithWebkitAudioContext extends Window {
  webkitAudioContext?: typeof AudioContext;
}

/**
 * マイク録音・レベルメーターを扱うフック。
 * DESIGN.md §6: MediaRecorderのmimeTypeは環境ごとに自動選択し、変換せずそのまま保存する。
 */
export function useRecorder(): UseRecorderResult {
  const [isRecording, setIsRecording] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [level, setLevel] = useState(0);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mimeType, setMimeType] = useState<string | undefined>(undefined);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);

  const cleanupStream = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (audioCtxRef.current) {
      void audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
  }, []);

  useEffect(() => cleanupStream, [cleanupStream]);

  const monitorLevel = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const data = new Uint8Array(analyser.fftSize);
    const tick = () => {
      if (!analyserRef.current) return;
      analyserRef.current.getByteTimeDomainData(data);
      let sumSquares = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sumSquares += v * v;
      }
      const rms = Math.sqrt(sumSquares / data.length);
      setLevel(Math.min(1, rms * 4));
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setRecordedBlob(null);
    chunksRef.current = [];
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const selectedMimeType = pickRecorderMimeType();
      setMimeType(selectedMimeType);
      const recorder = selectedMimeType
        ? new MediaRecorder(stream, { mimeType: selectedMimeType })
        : new MediaRecorder(stream);
      recorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const finalType = selectedMimeType ?? recorder.mimeType ?? 'audio/webm';
        setRecordedBlob(new Blob(chunksRef.current, { type: finalType }));
      };

      const w = window as WindowWithWebkitAudioContext;
      const AudioContextCtor = window.AudioContext ?? w.webkitAudioContext;
      if (AudioContextCtor) {
        const audioCtx = new AudioContextCtor();
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        audioCtxRef.current = audioCtx;
        analyserRef.current = analyser;
        monitorLevel();
      }

      startTimeRef.current = Date.now();
      setElapsedSec(0);
      timerRef.current = window.setInterval(() => {
        setElapsedSec(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 200);

      recorder.start();
      setIsRecording(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'マイクの使用許可が必要です');
      cleanupStream();
      setIsRecording(false);
    }
  }, [cleanupStream, monitorLevel]);

  const stop = useCallback(() => {
    recorderRef.current?.stop();
    setIsRecording(false);
    cleanupStream();
  }, [cleanupStream]);

  const reset = useCallback(() => {
    setRecordedBlob(null);
    setElapsedSec(0);
    setLevel(0);
    setError(null);
  }, []);

  return { isRecording, elapsedSec, level, mimeType, recordedBlob, error, start, stop, reset };
}

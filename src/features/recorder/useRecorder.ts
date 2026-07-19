import { useCallback, useEffect, useRef, useState } from 'react';
import { pickRecorderMimeType } from '../../lib/audio';
import { AudioPlayer, DEFAULT_RATE } from '../player/AudioPlayer';

export interface UseRecorderResult {
  isRecording: boolean;
  elapsedSec: number;
  /** 0〜1のレベルメーター値（簡易RMS）。 */
  level: number;
  mimeType: string | undefined;
  recordedBlob: Blob | null;
  error: string | null;
  /** お手本の再生速度（プリセット）。録音開始前・録音中どちらでも変更可能。 */
  rate: number;
  /** お手本の現在の再生位置(秒)。録音していないときは0。 */
  referenceCurrentTime: number;
  /** お手本の総時間(秒)。 */
  referenceDuration: number;
  /** お手本が最後まで再生し終わったか（録音開始のたびにリセットされる）。 */
  referenceFinished: boolean;
  start: () => Promise<void>;
  stop: () => void;
  reset: () => void;
  setRate: (rate: number) => void;
  /** お手本を先頭へ巻き戻して再度再生する（iOS対策の手動ボタン・流し直し兼用）。 */
  replayReference: () => void;
}

interface WindowWithWebkitAudioContext extends Window {
  webkitAudioContext?: typeof AudioContext;
}

/**
 * マイク録音・レベルメーター・お手本音声の同時自動再生を扱うフック。
 * DESIGN.md §6: MediaRecorderのmimeTypeは環境ごとに自動選択し、変換せずそのまま保存する。
 * シャドーイング提出（M5）: 「録音開始」と同時にお手本音声(referenceSrc)を先頭から自動再生し、
 * 録音の停止は必ずユーザーの停止ボタン操作で行う（お手本終了で自動停止しない）。
 */
export function useRecorder(referenceSrc: string): UseRecorderResult {
  const [isRecording, setIsRecording] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [level, setLevel] = useState(0);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mimeType, setMimeType] = useState<string | undefined>(undefined);
  const [rate, setRateState] = useState<number>(DEFAULT_RATE);
  const [referenceCurrentTime, setReferenceCurrentTime] = useState(0);
  const [referenceDuration, setReferenceDuration] = useState(0);
  const [referenceFinished, setReferenceFinished] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);
  const rateRef = useRef<number>(DEFAULT_RATE);
  const referencePlayerRef = useRef<AudioPlayer | null>(null);
  /** start()の多重起動防止（getUserMedia待ち中の連打対策）。 */
  const busyRef = useRef(false);
  /** trueの間はアンマウント済み。await後の副作用開始をここで打ち切る。 */
  const disposedRef = useRef(false);

  /** お手本の自動再生を停止し、リソースを解放する（音が残るリークを防ぐ）。 */
  const destroyReference = useCallback(() => {
    referencePlayerRef.current?.destroy();
    referencePlayerRef.current = null;
  }, []);

  /**
   * お手本を先頭(0秒)へ巻き戻して再度play()する。
   * iOS対策（DESIGN.md §6 M6）: ジェスチャ文脈内の初回play()でアンロック済みの要素は、
   * ジェスチャ外からの再play()もiOS Safariで許可される。getUserMedia解決直後の自動呼び出しと、
   * 「▶ お手本を最初から流す」ボタンからの手動呼び出しの両方で使う。再生失敗はエラーにしない。
   */
  const playReferenceFromStart = useCallback(() => {
    const player = referencePlayerRef.current;
    if (!player) return;
    player.seek(0);
    setReferenceFinished(false);
    player.play().catch(() => {
      // 再playに失敗しても録音は継続する（手動の「最初から流す」ボタンで再試行できる）
    });
  }, []);

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

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      cleanupStream();
      destroyReference();
    };
  }, [cleanupStream, destroyReference]);

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
    if (busyRef.current || isRecording) return;
    busyRef.current = true;
    setError(null);
    setRecordedBlob(null);
    chunksRef.current = [];
    setReferenceFinished(false);
    setReferenceCurrentTime(0);
    setReferenceDuration(0);

    // 「録音開始」と同時にお手本を先頭から自動再生する。ユーザー操作の文脈を保つため
    // マイク許可の await より前（クリックハンドラに近い位置）で再生を開始する。
    if (referenceSrc) {
      const referencePlayer = new AudioPlayer({
        src: referenceSrc,
        onTimeUpdate: (t, d) => {
          setReferenceCurrentTime(t);
          setReferenceDuration(d);
        },
        onEnded: () => setReferenceFinished(true),
      });
      referencePlayer.setLoopEnabled(false);
      referencePlayer.setPlaybackRate(rateRef.current);
      referencePlayerRef.current = referencePlayer;
      referencePlayer.play().catch(() => {
        // 自動再生がブロックされても録音自体は継続する
      });
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // エコーキャンセル等を明示指定し、イヤホン無しでもスピーカー→マイクの回り込み（お手本の声）を
        // OS側で除去する（DESIGN.md §6）。録音されるのをユーザーの声だけに近づけ、添削の誤判定を防ぐ。
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (disposedRef.current) {
        // getUserMedia待ち中にアンマウントされた。取得済みストリームとお手本を即座に解放して中断する。
        stream.getTracks().forEach((track) => track.stop());
        destroyReference();
        return;
      }
      streamRef.current = stream;

      // iOS対策（DESIGN.md §6 M6）: マイク許可ダイアログでiOSが一時停止した再生は自動で戻らないため、
      // getUserMedia解決後・disposedチェック通過後に必ず先頭へ巻き戻して再度play()する。
      // クリックハンドラ内（ジェスチャ文脈）の初回play()でアンロック済みなので、この再playも許可される。
      playReferenceFromStart();

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
      // マイク許可が下りなかった場合など、start失敗時はお手本だけ流れ続けないよう同時に停止する
      destroyReference();
      setIsRecording(false);
    } finally {
      busyRef.current = false;
    }
  }, [cleanupStream, monitorLevel, referenceSrc, isRecording, destroyReference, playReferenceFromStart]);

  const stop = useCallback(() => {
    recorderRef.current?.stop();
    setIsRecording(false);
    cleanupStream();
    destroyReference();
  }, [cleanupStream, destroyReference]);

  const reset = useCallback(() => {
    setRecordedBlob(null);
    setElapsedSec(0);
    setLevel(0);
    setError(null);
    setReferenceFinished(false);
    setReferenceCurrentTime(0);
    setReferenceDuration(0);
    destroyReference();
  }, [destroyReference]);

  const setRate = useCallback((next: number) => {
    rateRef.current = next;
    setRateState(next);
    referencePlayerRef.current?.setPlaybackRate(next);
  }, []);

  return {
    isRecording,
    elapsedSec,
    level,
    mimeType,
    recordedBlob,
    error,
    rate,
    referenceCurrentTime,
    referenceDuration,
    referenceFinished,
    start,
    stop,
    reset,
    setRate,
    replayReference: playReferenceFromStart,
  };
}

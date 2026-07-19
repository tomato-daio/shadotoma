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
  /** レベルメーターとお手本再生を一本化する共有AudioContext（DESIGN.md §6 M7）。 */
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  /** お手本<audio>要素をaudioCtxへ接続するノード。destroy時に必ずdisconnectする。 */
  const referenceSourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);
  const rateRef = useRef<number>(DEFAULT_RATE);
  const referencePlayerRef = useRef<AudioPlayer | null>(null);
  /** start()の多重起動防止（getUserMedia待ち中の連打対策）。 */
  const busyRef = useRef(false);
  /** trueの間はアンマウント済み。await後の副作用開始をここで打ち切る。 */
  const disposedRef = useRef(false);
  /** trueの間はマイクがOSに停止/ミュートされた後始末中。MediaRecorderのonstopが自動発火しても録音結果を確定させない。 */
  const abortedRef = useRef(false);

  /** お手本の自動再生を停止し、リソースを解放する（音が残るリークを防ぐ）。 */
  const destroyReference = useCallback(() => {
    // MediaElementSourceに接続した要素の音はcontext.destination経由でのみ出るため、
    // 破棄時は必ずソースノードもdisconnectする（DESIGN.md §6 M7 注意点）。
    referenceSourceNodeRef.current?.disconnect();
    referenceSourceNodeRef.current = null;
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
    // track.stop()はendedイベントを発火させない仕様なので、ここでの正常停止が
    // handleTrackAbort（OSによる強制終了検知）を誤って再発火させることはない。
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    // ノードは閉じる前にdisconnectしておく（クローズ後でも害はないが後始末を明示する）。
    micSourceRef.current?.disconnect();
    micSourceRef.current = null;
    analyserRef.current?.disconnect();
    analyserRef.current = null;
    if (audioCtxRef.current) {
      void audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
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

  /**
   * iOSオーディオセッション対策（DESIGN.md §6 M7）: マイクトラックがOSに停止/ミュートされたら、
   * UIを固まらせず録音を後始末してユーザーに再試行を促す。
   * ended/mute は同一トラックで連続発火しうるため、一度後始末したら二重実行しない。
   */
  const handleTrackAbort = useCallback(() => {
    if (abortedRef.current) return;
    abortedRef.current = true;
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      try {
        recorderRef.current.stop();
      } catch {
        // 既に停止済み等は無視する
      }
    }
    cleanupStream();
    destroyReference();
    setIsRecording(false);
    setError('マイクがOSに停止されました。もう一度録音開始を押してください');
  }, [cleanupStream, destroyReference]);

  /**
   * iOSオーディオセッション対策（DESIGN.md §6 M7）: getUserMedia解決直後にHTMLAudioElementの
   * 再生を始めるとiOSがオーディオセッションを再構成し、マイクトラックを終了させる現象があるため、
   * 処理順を「getUserMedia解決 → AudioContext生成/resume → アナライザ配線 → MediaRecorder.start()
   * → お手本をAudioContext経由で先頭から再生」に固定する。お手本の再生もレベルメーターと同じ
   * AudioContext（MediaElementAudioSourceNode→destination）に一本化し、別個のオーディオセッションを
   * 発生させないようにする。
   */
  const start = useCallback(async () => {
    if (busyRef.current || isRecording) return;
    busyRef.current = true;
    setError(null);
    setRecordedBlob(null);
    chunksRef.current = [];
    abortedRef.current = false;
    setReferenceFinished(false);
    setReferenceCurrentTime(0);
    setReferenceDuration(0);

    try {
      // 1. getUserMedia解決
      const stream = await navigator.mediaDevices.getUserMedia({
        // エコーキャンセル等を明示指定し、イヤホン無しでもスピーカー→マイクの回り込み（お手本の声）を
        // OS側で除去する（DESIGN.md §6）。録音されるのをユーザーの声だけに近づけ、添削の誤判定を防ぐ。
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (disposedRef.current) {
        // getUserMedia待ち中にアンマウントされた。取得済みストリームを即座に解放して中断する。
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      if (abortedRef.current) {
        // この時点ではtrackのended/muteリスナー未登録のため理論上到達しないが、念のため中断する。
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;

      // マイクがOSに停止/ミュートされたら後始末してユーザーに再試行を促す（DESIGN.md §6 M7）。
      stream.getAudioTracks().forEach((track) => {
        track.addEventListener('ended', handleTrackAbort, { once: true });
        track.addEventListener('mute', handleTrackAbort, { once: true });
      });

      // 2. AudioContext生成/resume（iOSはsuspendedで始まることがあるため必ずresumeする）
      const w = window as WindowWithWebkitAudioContext;
      const AudioContextCtor = window.AudioContext ?? w.webkitAudioContext;
      if (AudioContextCtor) {
        const audioCtx = new AudioContextCtor();
        audioCtxRef.current = audioCtx;
        try {
          await audioCtx.resume();
        } catch {
          // resume失敗は致命的にしない（レベルメーターが動かない程度に留める）
        }
        if (disposedRef.current) {
          // アンマウント済み。effectのクリーンアップ(cleanupStream)が既にaudioCtxRef.current
          // (=audioCtx)をclose済みの可能性が高いため、参照が一致するときだけ後始末し、
          // 万一の二重close（InvalidStateErrorの未処理rejection）はcatchで握りつぶす。
          stream.getTracks().forEach((track) => track.stop());
          if (audioCtxRef.current === audioCtx) {
            audioCtxRef.current = null;
            void audioCtx.close().catch(() => {});
          }
          return;
        }
        if (abortedRef.current) {
          // resume()待ち中にhandleTrackAbortが発火し、cleanupStream・destroyReference・
          // setError・setIsRecording(false)まで後始末済み。ここでアナライザ配線・
          // MediaRecorder構築・お手本再生・setIsRecording(true)を行うと状態が矛盾するため、
          // 何もせずreturnする（再録音はabortedRefがstart()冒頭でリセットされるため可能）。
          return;
        }

        // 3. アナライザ配線（レベルメーター）
        const micSource = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        micSource.connect(analyser);
        micSourceRef.current = micSource;
        analyserRef.current = analyser;
        monitorLevel();
      }

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
        // マイクのOS強制終了で後始末済みの場合、中途半端なBlobで結果画面へ遷移させない。
        if (abortedRef.current) return;
        const finalType = selectedMimeType ?? recorder.mimeType ?? 'audio/webm';
        setRecordedBlob(new Blob(chunksRef.current, { type: finalType }));
      };

      startTimeRef.current = Date.now();
      setElapsedSec(0);
      timerRef.current = window.setInterval(() => {
        setElapsedSec(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 200);

      // 4. MediaRecorder.start()
      recorder.start();
      setIsRecording(true);

      // 5. お手本をAudioContext経由で先頭から再生
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

        const audioCtx = audioCtxRef.current;
        if (audioCtx) {
          // createMediaElementSourceは同一<audio>要素につき1回しか呼べないが、start()のたびに
          // 新しいAudioPlayer（＝新しい<audio>要素）を生成しているため問題ない。
          const referenceSource = audioCtx.createMediaElementSource(referencePlayer.audio);
          referenceSource.connect(audioCtx.destination);
          referenceSourceNodeRef.current = referenceSource;
        }
        playReferenceFromStart();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'マイクの使用許可が必要です');
      cleanupStream();
      // マイク許可が下りなかった場合など、start失敗時はお手本だけ流れ続けないよう同時に停止する
      destroyReference();
      setIsRecording(false);
    } finally {
      busyRef.current = false;
    }
  }, [cleanupStream, monitorLevel, referenceSrc, isRecording, destroyReference, playReferenceFromStart, handleTrackAbort]);

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

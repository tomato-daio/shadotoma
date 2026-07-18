import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioPlayer, DEFAULT_RATE, REWIND_SECONDS, type ABPoints } from './AudioPlayer';

export interface UsePlayerResult {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  rate: number;
  loopCount: number;
  abPoints: ABPoints;
  loopEnabled: boolean;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (time: number) => void;
  rewind: () => void;
  setRate: (rate: number) => void;
  setPointA: () => void;
  setPointB: () => void;
  clearAB: () => void;
  resetLoopCount: () => void;
  setLoopEnabled: (enabled: boolean) => void;
}

/**
 * AudioPlayerクラスをReactの状態に橋渡しするフック。
 * `src` が変わるたびに新しいプレーヤーを構築し、直前の再生速度・ループ設定は引き継ぐ。
 */
export function usePlayer(src: string | undefined): UsePlayerResult {
  const playerRef = useRef<AudioPlayer | null>(null);
  const rateRef = useRef(DEFAULT_RATE);
  const loopEnabledRef = useRef(true);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRateState] = useState(DEFAULT_RATE);
  const [loopCount, setLoopCount] = useState(0);
  const [abPoints, setAbPoints] = useState<ABPoints>({ a: null, b: null });
  const [loopEnabled, setLoopEnabledState] = useState(true);

  useEffect(() => {
    if (!src) {
      playerRef.current = null;
      return;
    }

    const player = new AudioPlayer({
      src,
      onTimeUpdate: (t, d) => {
        setCurrentTime(t);
        setDuration(d);
      },
      onLoopComplete: (count) => setLoopCount(count),
      onPlayStateChange: (playing) => setIsPlaying(playing),
    });
    player.setPlaybackRate(rateRef.current);
    player.setLoopEnabled(loopEnabledRef.current);
    playerRef.current = player;

    setCurrentTime(0);
    setDuration(0);
    setLoopCount(0);
    setAbPoints({ a: null, b: null });
    setIsPlaying(false);

    return () => {
      player.destroy();
      if (playerRef.current === player) {
        playerRef.current = null;
      }
    };
  }, [src]);

  const play = useCallback(() => {
    void playerRef.current?.play();
  }, []);

  const pause = useCallback(() => {
    playerRef.current?.pause();
  }, []);

  const toggle = useCallback(() => {
    playerRef.current?.toggle();
  }, []);

  const seek = useCallback((time: number) => {
    playerRef.current?.seek(time);
    setCurrentTime(time);
  }, []);

  const rewind = useCallback(() => {
    playerRef.current?.rewind(REWIND_SECONDS);
  }, []);

  const setRate = useCallback((next: number) => {
    const applied = playerRef.current?.setPlaybackRate(next) ?? next;
    rateRef.current = applied;
    setRateState(applied);
  }, []);

  const setPointA = useCallback(() => {
    playerRef.current?.setPointA();
    if (playerRef.current) setAbPoints({ ...playerRef.current.abPoints });
  }, []);

  const setPointB = useCallback(() => {
    playerRef.current?.setPointB();
    if (playerRef.current) setAbPoints({ ...playerRef.current.abPoints });
  }, []);

  const clearAB = useCallback(() => {
    playerRef.current?.clearAB();
    setAbPoints({ a: null, b: null });
  }, []);

  const resetLoopCount = useCallback(() => {
    playerRef.current?.resetLoopCount();
    setLoopCount(0);
  }, []);

  const setLoopEnabled = useCallback((enabled: boolean) => {
    loopEnabledRef.current = enabled;
    playerRef.current?.setLoopEnabled(enabled);
    setLoopEnabledState(enabled);
  }, []);

  return {
    isPlaying,
    currentTime,
    duration,
    rate,
    loopCount,
    abPoints,
    loopEnabled,
    play,
    pause,
    toggle,
    seek,
    rewind,
    setRate,
    setPointA,
    setPointB,
    clearAB,
    resetLoopCount,
    setLoopEnabled,
  };
}

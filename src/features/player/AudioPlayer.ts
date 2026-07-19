/**
 * HTMLAudioElement をラップしたプレーヤー本体。
 * DESIGN.md §5 のプレーヤー仕様（速度変更・ABリピート・ループ回数カウント）を実装する。
 */

export const RATE_MIN = 0.5;
export const RATE_MAX = 2.0;
export const RATE_STEP = 0.05;
export const RATE_PRESETS = [0.7, 0.85, 1.0, 1.15] as const;
export const DEFAULT_RATE = 1.0;
export const REWIND_SECONDS = 3;
/** timeupdateの粒度が粗いため、B地点判定に許容する誤差(秒)。 */
export const AB_TOLERANCE = 0.25;
/** ループ再開位置・AB区間として意味を持つ最小の再生窓(秒)。これ未満は即endedの暴走につながる。 */
export const MIN_LOOP_WINDOW_SEC = 0.5;

export interface ABPoints {
  a: number | null;
  b: number | null;
}

export interface AudioPlayerCallbacks {
  onTimeUpdate?: (currentTime: number, duration: number) => void;
  onLoopComplete?: (loopCount: number) => void;
  onPlayStateChange?: (isPlaying: boolean) => void;
  onEnded?: () => void;
}

export interface AudioPlayerOptions extends AudioPlayerCallbacks {
  src: string;
}

export function clampRate(rate: number): number {
  const clamped = Math.min(RATE_MAX, Math.max(RATE_MIN, rate));
  // 0.05刻みに丸める（浮動小数点誤差対策）
  return Math.round(clamped / RATE_STEP) * RATE_STEP;
}

/**
 * AB区間として意味を持つか（A<Bかつ最小窓以上）。A≧Bや極小区間はリピートとして成立せず、
 * timeupdateのたびにA地点へ戻り続けて再生が進まなくなるため、無効（ABなし）として扱う。
 */
export function isValidABWindow(a: number | null, b: number | null): boolean {
  return a !== null && b !== null && b - a >= MIN_LOOP_WINDOW_SEC;
}

/**
 * ended後の自動リプレイの再開位置。A地点が末尾ぎりぎり（残り MIN_LOOP_WINDOW_SEC 未満）だと
 * 「ended→シーク→play→即ended」の暴走ループでループ回数が急増するため、0秒からの再開に
 * フォールバックする。durationが未確定(NaN/Infinity/0)の場合は判定できないのでA地点をそのまま使う。
 */
export function resolveRestartTime(a: number | null, duration: number): number {
  const start = Math.max(0, a ?? 0);
  if (Number.isFinite(duration) && duration > 0 && duration - start < MIN_LOOP_WINDOW_SEC) {
    return 0;
  }
  return start;
}

/** preservesPitchのベンダープレフィックス吸収用。 */
interface AudioElementWithVendorPitch extends HTMLAudioElement {
  mozPreservesPitch?: boolean;
  webkitPreservesPitch?: boolean;
}

export class AudioPlayer {
  readonly audio: AudioElementWithVendorPitch;
  private readonly callbacks: AudioPlayerCallbacks;
  private abPointA: number | null = null;
  private abPointB: number | null = null;
  private loopCount = 0;
  private loopEnabled = true;
  /** 直近で自動リプレイ（ended→再生再開）を行った時刻(performance.now)。暴走ループの最終防波堤に使う。 */
  private lastAutoRestartAt = 0;

  constructor(options: AudioPlayerOptions) {
    const { src, ...callbacks } = options;
    this.callbacks = callbacks;
    this.audio = new Audio(src);
    this.audio.preload = 'metadata';
    this.audio.preservesPitch = true;
    this.audio.mozPreservesPitch = true;
    this.audio.webkitPreservesPitch = true;

    this.audio.addEventListener('timeupdate', this.handleTimeUpdate);
    this.audio.addEventListener('ended', this.handleEnded);
    this.audio.addEventListener('play', this.handlePlay);
    this.audio.addEventListener('pause', this.handlePause);
    // timeupdateは再生中しか発火しないため、メタデータ読み込み時点でも総時間を通知する
    this.audio.addEventListener('loadedmetadata', this.handleTimeUpdate);
    this.audio.addEventListener('durationchange', this.handleTimeUpdate);
  }

  private handleTimeUpdate = (): void => {
    const { currentTime, duration } = this.audio;
    const a = this.abPointA;
    const b = this.abPointB;
    if (a !== null && b !== null && isValidABWindow(a, b) && currentTime > b + AB_TOLERANCE) {
      this.audio.currentTime = a;
    }
    this.callbacks.onTimeUpdate?.(currentTime, Number.isFinite(duration) ? duration : 0);
  };

  private handleEnded = (): void => {
    this.loopCount += 1;
    this.callbacks.onLoopComplete?.(this.loopCount);
    this.callbacks.onEnded?.();
    if (this.loopEnabled) {
      // 最終防波堤: 直前の自動リプレイからごく短時間で再びendedが来た場合（音源自体が極端に短い等、
      // resolveRestartTimeのガードでも1周が最小窓未満になるケース）は再生を再開せず暴走を止める。
      const now = performance.now();
      if (now - this.lastAutoRestartAt < MIN_LOOP_WINDOW_SEC * 1000) return;
      this.lastAutoRestartAt = now;
      this.audio.currentTime = resolveRestartTime(this.abPointA, this.audio.duration);
      void this.audio.play();
    }
  };

  private handlePlay = (): void => {
    this.callbacks.onPlayStateChange?.(true);
  };

  private handlePause = (): void => {
    this.callbacks.onPlayStateChange?.(false);
  };

  play(): Promise<void> {
    return this.audio.play();
  }

  pause(): void {
    this.audio.pause();
  }

  toggle(): void {
    if (this.audio.paused) {
      void this.play();
    } else {
      this.pause();
    }
  }

  seek(time: number): void {
    const duration = Number.isFinite(this.audio.duration) ? this.audio.duration : Infinity;
    this.audio.currentTime = Math.min(Math.max(0, time), duration);
  }

  rewind(seconds: number = REWIND_SECONDS): void {
    this.seek(this.audio.currentTime - seconds);
  }

  setPlaybackRate(rate: number): number {
    const clamped = clampRate(rate);
    this.audio.playbackRate = clamped;
    this.audio.preservesPitch = true;
    this.audio.mozPreservesPitch = true;
    this.audio.webkitPreservesPitch = true;
    return clamped;
  }

  setPointA(time: number = this.audio.currentTime): void {
    this.abPointA = time;
  }

  setPointB(time: number = this.audio.currentTime): void {
    this.abPointB = time;
  }

  clearAB(): void {
    this.abPointA = null;
    this.abPointB = null;
  }

  get abPoints(): ABPoints {
    return { a: this.abPointA, b: this.abPointB };
  }

  setLoopEnabled(enabled: boolean): void {
    this.loopEnabled = enabled;
  }

  resetLoopCount(): void {
    this.loopCount = 0;
  }

  get currentLoopCount(): number {
    return this.loopCount;
  }

  destroy(): void {
    this.audio.pause();
    this.audio.removeEventListener('timeupdate', this.handleTimeUpdate);
    this.audio.removeEventListener('ended', this.handleEnded);
    this.audio.removeEventListener('play', this.handlePlay);
    this.audio.removeEventListener('pause', this.handlePause);
    this.audio.removeEventListener('loadedmetadata', this.handleTimeUpdate);
    this.audio.removeEventListener('durationchange', this.handleTimeUpdate);
    this.audio.src = '';
  }
}

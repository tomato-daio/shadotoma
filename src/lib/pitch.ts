/**
 * F0(ピッチ)抽出の純関数（M15・DESIGN.md §8f）。
 *
 * 正規化自己相関によるフレームごとのF0推定と、抑揚指標（半音標準偏差）の算出のみを行う。
 * お手本と録音を同一アルゴリズムで解析して「変動幅の比」を見る用途のため、
 * 絶対精度よりも両者で同じバイアスがかかることを優先した素朴な実装にしている。
 * 外部依存なし・DOM非依存（合成波形でテスト可能）。
 */

export interface PitchStats {
  /** 有声フレームF0の中央値(Hz)。 */
  medianHz: number;
  /** 中央値基準の半音標準偏差。抑揚の大きさの指標（大きいほど声の高さが動いている）。 */
  semitoneSd: number;
  /** 全フレームのうち有声と判定された割合(0-1)。信頼度の目安。 */
  voicedRatio: number;
}

export const F0_MIN_HZ = 60;
export const F0_MAX_HZ = 400;
/** 解析フレーム長(秒)。F0_MIN_HZ=60Hzの1周期(約17ms)を2周期以上含む長さ。 */
const PITCH_FRAME_SEC = 0.04;
const PITCH_HOP_SEC = 0.02;
/** 正規化自己相関のピークがこの値未満のフレームは無声(または雑音)として捨てる。 */
const VOICED_MIN_CLARITY = 0.5;
/** 最大相関のこの割合以上に達する最小ラグを採用する（周期の整数倍を選ぶオクターブ誤りの対策）。 */
const OCTAVE_PICK_RATIO = 0.9;
/** 有声フレームがこの数未満なら統計として信頼できないためnullを返す。 */
const MIN_VOICED_FRAMES = 20;
/** フレームRMSがピークフレームRMSのこの割合未満なら無音フレームとしてスキップする。 */
const FRAME_SILENCE_RATIO = 0.05;

/**
 * PCMからF0統計を抽出する。有声フレームが十分に取れない場合（無音・雑音のみ等）はnull。
 */
export function extractPitchStats(pcm: Float32Array, sampleRate: number): PitchStats | null {
  if (pcm.length === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) return null;

  // 演算量削減: 12kHz超なら隣接2サンプル平均で1/2に間引く（F0上限400Hzには十分な帯域が残る）。
  let signal = pcm;
  let sr = sampleRate;
  if (sr > 12000) {
    const half = Math.floor(pcm.length / 2);
    const down = new Float32Array(half);
    for (let i = 0; i < half; i++) down[i] = (pcm[2 * i] + pcm[2 * i + 1]) / 2;
    signal = down;
    sr = sr / 2;
  }

  const frameSize = Math.round(sr * PITCH_FRAME_SEC);
  const hopSize = Math.max(1, Math.round(sr * PITCH_HOP_SEC));
  const minLag = Math.max(2, Math.floor(sr / F0_MAX_HZ));
  const maxLag = Math.min(frameSize - 1, Math.ceil(sr / F0_MIN_HZ));
  if (signal.length < frameSize || minLag >= maxLag) return null;

  const frameCount = Math.floor((signal.length - frameSize) / hopSize) + 1;

  // 先に全フレームのRMSを求め、無音フレームのスキップ基準（ピーク比）を決める。
  const frameRms = new Float32Array(frameCount);
  let peakRms = 0;
  for (let f = 0; f < frameCount; f++) {
    const off = f * hopSize;
    let sumSq = 0;
    for (let i = 0; i < frameSize; i++) {
      const v = signal[off + i];
      sumSq += v * v;
    }
    const value = Math.sqrt(sumSq / frameSize);
    frameRms[f] = value;
    if (value > peakRms) peakRms = value;
  }
  if (peakRms <= 0) return null;

  const f0s: number[] = [];
  const x = new Float64Array(frameSize);
  const prefixSq = new Float64Array(frameSize + 1);
  const corr = new Float64Array(maxLag + 1);

  for (let f = 0; f < frameCount; f++) {
    if (frameRms[f] < peakRms * FRAME_SILENCE_RATIO) continue;
    const off = f * hopSize;

    // DC除去と、正規化用のエネルギー累積和
    let mean = 0;
    for (let i = 0; i < frameSize; i++) mean += signal[off + i];
    mean /= frameSize;
    for (let i = 0; i < frameSize; i++) {
      x[i] = signal[off + i] - mean;
      prefixSq[i + 1] = prefixSq[i] + x[i] * x[i];
    }
    if (prefixSq[frameSize] <= 0) continue;

    // 正規化自己相関 r(τ) = Σx[i]x[i+τ] / sqrt(Σ先頭側x² · Σ後方側x²)
    let best = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      const n = frameSize - lag;
      let sum = 0;
      for (let i = 0; i < n; i++) sum += x[i] * x[i + lag];
      const headEnergy = prefixSq[n];
      const tailEnergy = prefixSq[frameSize] - prefixSq[lag];
      const denom = Math.sqrt(headEnergy * tailEnergy);
      const value = denom > 0 ? sum / denom : 0;
      corr[lag] = value;
      if (value > best) best = value;
    }
    if (best < VOICED_MIN_CLARITY) continue;

    // オクターブ誤り対策: 最大相関のOCTAVE_PICK_RATIO以上に達する最小のラグ（=最初のピーク群）を
    // 見つけ、そこから局所ピークまで登る（90%到達点はピークの少し手前になり高めに偏るため）。
    let chosenLag = -1;
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (corr[lag] >= best * OCTAVE_PICK_RATIO) {
        chosenLag = lag;
        break;
      }
    }
    if (chosenLag < 0) continue;
    while (chosenLag + 1 <= maxLag && corr[chosenLag + 1] > corr[chosenLag]) {
      chosenLag++;
    }
    // 探索下限の境界アーティファクト対策: F0_MIN未満の低周波（電源ハム・空調等）が支配的な
    // フレームではcorrがminLagから単調下降し、真の局所ピークでないminLagが選ばれて
    // F0_MAX相当のスパイクになる。minLagに張り付き、かつ隣が下り坂（=ピークでない）の
    // フレームは無声として捨てる（犠牲はちょうどF0_MAXのフレームのみ）。
    if (chosenLag === minLag && corr[minLag + 1] < corr[minLag]) continue;
    f0s.push(sr / chosenLag);
  }

  if (f0s.length < MIN_VOICED_FRAMES) return null;

  // 低域ハム等の外れ値がmedian/SDを汚染しないよう、仮の中央値から±1オクターブ超を除外して統計を取る。
  const sortedAll = [...f0s].sort((a, b) => a - b);
  const rawMedian = sortedAll[Math.floor(sortedAll.length / 2)];
  const filtered = f0s.filter((f0) => Math.abs(12 * Math.log2(f0 / rawMedian)) <= 12);
  if (filtered.length < MIN_VOICED_FRAMES) return null;

  const sorted = [...filtered].sort((a, b) => a - b);
  const medianHz = sorted[Math.floor(sorted.length / 2)];
  const semis = filtered.map((f0) => 12 * Math.log2(f0 / medianHz));
  const meanSemi = semis.reduce((sum, v) => sum + v, 0) / semis.length;
  const variance = semis.reduce((sum, v) => sum + (v - meanSemi) * (v - meanSemi), 0) / semis.length;

  return {
    medianHz,
    semitoneSd: Math.sqrt(variance),
    voicedRatio: filtered.length / frameCount,
  };
}

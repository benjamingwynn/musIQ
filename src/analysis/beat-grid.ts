import type {FeatureFrame, FeatureTimeline} from "../dsp/features.js"
export type RawBeat = {start: number; confidence: number; bpm: number}

const EPS = 1e-12

function median(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

function percentile(values: number[], q: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const p = Math.max(0, Math.min(1, q)) * (sorted.length - 1)
  const lo = Math.floor(p)
  const hi = Math.ceil(p)
  if (lo === hi) return sorted[lo] ?? 0
  const t = p - lo
  return (sorted[lo] ?? 0) * (1 - t) + (sorted[hi] ?? 0) * t
}

function normalizedEnvelope(frames: FeatureFrame[], pick: (frame: FeatureFrame) => number): Float64Array {
  const values = frames.map((frame) => Math.log1p(Math.max(0, pick(frame))))
  // Remove the steady floor before autocorrelation. Tempo lives in changes, and a
  // constant background otherwise makes every candidate lag look deceptively good.
  const floor = percentile(values, 0.5)
  const transient = values.map((value) => Math.max(0, value - floor))
  // A few huge transients should not own the estimate. Scale against p95 and clip.
  const scale = Math.max(EPS, percentile(transient, 0.99))
  return Float64Array.from(transient, (value) => Math.min(1.5, value / scale))
}

function autocorrelation(envelope: Float64Array, lag: number): number {
  if (lag < 1 || lag >= envelope.length) return 0
  let dot = 0
  let left = 0
  let right = 0
  for (let i = 0; i + lag < envelope.length; i++) {
    const a = envelope[i] ?? 0
    const b = envelope[i + lag] ?? 0
    dot += a * b
    left += a * a
    right += b * b
  }
  return dot / Math.sqrt(Math.max(EPS, left * right))
}

function tempoPrior(bpm: number): number {
  // Beat/tactus level is intrinsically octave-ambiguous. A broad preference around
  // 120 BPM nudges the resolver without overriding strong rhythmic evidence.
  const logRatio = Math.log2(Math.max(EPS, bpm) / 120)
  const sigma = 0.8
  return Math.exp(-0.5 * (logRatio / sigma) ** 2)
}

function periodScore(timeline: FeatureTimeline, bpm: number): number {
  if (!Number.isFinite(bpm) || bpm <= 0 || timeline.frames.length < 8) return 0
  const frameRate = timeline.sampleRate / timeline.hopSize
  const lag = Math.round(frameRate * 60 / bpm)
  if (lag < 1) return 0

  const full = normalizedEnvelope(timeline.frames, (frame) => frame.onsetStrength)
  const bass = normalizedEnvelope(timeline.frames, (frame) => frame.lowOnsetStrength)
  const fullScore = autocorrelation(full, lag)
  const bassScore = autocorrelation(bass, lag)
  return (fullScore * 0.72 + bassScore * 0.28) * tempoPrior(bpm)
}

function nearestFrame(timeline: FeatureTimeline, time: number): FeatureFrame | undefined {
  if (!timeline.frames.length) return undefined
  const frameRate = timeline.sampleRate / timeline.hopSize
  const approx = Math.round(time * frameRate - timeline.frameSize / (2 * timeline.hopSize))
  let best: FeatureFrame | undefined
  let bestDistance = Infinity
  for (let i = Math.max(0, approx - 2); i <= Math.min(timeline.frames.length - 1, approx + 2); i++) {
    const frame = timeline.frames[i]
    if (!frame) continue
    const distance = Math.abs(frame.center - time)
    if (distance < bestDistance) {
      bestDistance = distance
      best = frame
    }
  }
  return best
}

function phaseSalience(timeline: FeatureTimeline, beats: RawBeat[], parity: 0 | 1): number {
  const fullScale = Math.max(EPS, percentile(timeline.frames.map((f) => Math.log1p(Math.max(0, f.onsetStrength))), 0.99))
  const bassScale = Math.max(EPS, percentile(timeline.frames.map((f) => Math.log1p(Math.max(0, f.lowOnsetStrength))), 0.99))
  let sum = 0
  let count = 0
  for (let i = parity; i < beats.length; i += 2) {
    const beat = beats[i]
    if (!beat) continue
    const frame = nearestFrame(timeline, beat.start)
    if (!frame) continue
    const full = Math.min(1.5, Math.log1p(Math.max(0, frame.onsetStrength)) / fullScale)
    const bass = Math.min(1.5, Math.log1p(Math.max(0, frame.lowOnsetStrength)) / bassScale)
    // Bass is a clue, not the definition of a beat: kick-heavy music should help us
    // choose the phase, but a snare beat must still count through full-band flux.
    sum += full * 0.68 + bass * 0.32
    count++
  }
  return count ? sum / count : 0
}

function recalculateLocalBpm(beats: RawBeat[]): RawBeat[] {
  return beats.map((beat, index) => {
    const intervals: number[] = []
    const prev = beats[index - 1]
    const next = beats[index + 1]
    if (prev && beat.start > prev.start) intervals.push(beat.start - prev.start)
    if (next && next.start > beat.start) intervals.push(next.start - beat.start)
    const period = median(intervals)
    return {...beat, bpm: period > 0 ? 60 / period : beat.bpm}
  })
}

/**
 * Resolve the most common beat-tracking octave error without redefining beats as
 * "bass hits". Aubio supplies a good causal beat grid; this pass only asks whether
 * that grid is actually a double-time subdivision of the stronger musical tactus.
 */
export function resolveBeatGrid(beats: RawBeat[], timeline: FeatureTimeline): RawBeat[] {
  if (beats.length < 8) return recalculateLocalBpm(beats)

  const aubioBpms = beats.map((beat) => beat.bpm).filter((bpm) => Number.isFinite(bpm) && bpm > 0)
  const bpm = median(aubioBpms)
  if (bpm < 130) return recalculateLocalBpm(beats)

  const halfBpm = bpm / 2
  if (halfBpm < 55) return recalculateLocalBpm(beats)

  const fullScore = periodScore(timeline, bpm)
  const halfScore = periodScore(timeline, halfBpm)

  // Require real evidence for the lower metrical level. This deliberately does not
  // halve every fast song: genuinely strong quarter-note pulses at 150–190 BPM keep
  // their original grid. The margin is intentionally modest because the 120-BPM
  // prior is already broad rather than prescriptive.
  if (!(halfScore > fullScore * 1.08)) return recalculateLocalBpm(beats)

  const even = phaseSalience(timeline, beats, 0)
  const odd = phaseSalience(timeline, beats, 1)
  const parity: 0 | 1 = odd > even ? 1 : 0
  const selected = beats.filter((_, index) => index % 2 === parity)

  return recalculateLocalBpm(selected)
}

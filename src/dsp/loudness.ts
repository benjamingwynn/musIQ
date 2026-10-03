import {clamp} from "../math.js"

/**
 * Loudness analysis for decoded programme audio.
 *
 * `trueLoudness` is momentary K-weighted loudness in LUFS (400 ms window),
 * following the BS.1770/EBU-R128 programme-loudness model closely enough for
 * our browser use. `perceivedLoudness` is deliberately *not* a standards unit:
 * it is a responsive 0..1 control signal derived from K-weighted short-time
 * energy, with fast attack / slower release and an approximately sone-like
 * 10 dB-per-doubling mapping.
 *
 * The distinction matters: a digital file has no absolute playback SPL, so a
 * true psychoacoustic loudness-in-sones claim would require a listening-level
 * calibration (and a substantially heavier ISO 532 model).
 */

export type LoudnessPoint = {
  /** Start of this control interval, seconds. */
  start: number
  /** EBU-style momentary loudness over 400 ms, in LUFS. */
  trueLoudness: number
  /** Music-reactive perceptual/control loudness, normalized 0..1. */
  perceivedLoudness: number
}

export type LoudnessTimeline = {
  duration: number
  pointsPerSecond: number
  points: LoudnessPoint[]
}

type Biquad = {b0: number; b1: number; b2: number; a1: number; a2: number}

function highShelfDeMan(sampleRate: number): Biquad {
  // Parameters used by the De Man BS.1770 K-weighting implementation.
  const gainDb = 3.99984385397
  const q = 0.7071752369554193
  const fc = 1681.974450955533
  const k = Math.tan(Math.PI * fc / sampleRate)
  const vh = 10 ** (gainDb / 20)
  const vb = vh ** 0.499666774155
  const a0 = 1 + k / q + k * k
  return {
    b0: (vh + vb * k / q + k * k) / a0,
    b1: 2 * (k * k - vh) / a0,
    b2: (vh - vb * k / q + k * k) / a0,
    a1: 2 * (k * k - 1) / a0,
    a2: (1 - k / q + k * k) / a0,
  }
}

function highPassDeMan(sampleRate: number): Biquad {
  const q = 0.5003270373238773
  const fc = 38.13547087602444
  const k = Math.tan(Math.PI * fc / sampleRate)
  const norm = 1 + k / q + k * k
  return {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: 2 * (k * k - 1) / norm,
    a2: (1 - k / q + k * k) / norm,
  }
}

function applyBiquad(input: Float32Array, filter: Biquad): Float32Array {
  const output = new Float32Array(input.length)
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i] ?? 0
    const y0 = filter.b0 * x0 + filter.b1 * x1 + filter.b2 * x2 - filter.a1 * y1 - filter.a2 * y2
    output[i] = y0
    x2 = x1
    x1 = x0
    y2 = y1
    y1 = y0
  }
  return output
}

export function kWeightChannel(input: Float32Array, sampleRate: number): Float32Array {
  return applyBiquad(applyBiquad(input, highShelfDeMan(sampleRate)), highPassDeMan(sampleRate))
}

function finiteLufs(meanSquare: number): number {
  if (!(meanSquare > 0)) return -120
  return Math.max(-120, -0.691 + 10 * Math.log10(meanSquare))
}

function rangeEnergy(prefix: Float64Array, start: number, end: number): number {
  const lo = Math.max(0, Math.min(prefix.length - 1, start))
  const hi = Math.max(lo + 1, Math.min(prefix.length - 1, end))
  return Math.max(0, ((prefix[hi] ?? 0) - (prefix[lo] ?? 0)) / Math.max(1, hi - lo))
}

/**
 * Build the loudness timeline from the original channels, not the mono mix.
 * Summing channel energies avoids phase cancellation and matches how programme
 * loudness meters treat ordinary left/right channels.
 */
export function extractLoudnessTimeline(
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  duration: number,
  pointsPerSecond = 10,
): LoudnessTimeline {
  const sampleLength = Math.max(0, ...channels.map((channel) => channel.length))
  const summedPower = new Float64Array(sampleLength)

  for (const channel of channels) {
    const weighted = kWeightChannel(channel, sampleRate)
    for (let i = 0; i < weighted.length; i++) {
      const x = weighted[i] ?? 0
      summedPower[i] = (summedPower[i] ?? 0) + x * x
    }
  }

  const prefix = new Float64Array(sampleLength + 1)
  for (let i = 0; i < sampleLength; i++) prefix[i + 1] = (prefix[i] ?? 0) + (summedPower[i] ?? 0)

  const count = Math.max(1, Math.ceil(duration * pointsPerSecond))
  const interval = duration / count
  const fastSeconds = 0.100
  const momentarySeconds = 0.400
  const attackSeconds = 0.050
  const releaseSeconds = 0.250
  let sensation = 0
  const points: LoudnessPoint[] = []

  for (let i = 0; i < count; i++) {
    const start = i * interval
    const end = i === count - 1 ? duration : (i + 1) * interval
    const endSample = Math.min(sampleLength, Math.max(1, Math.round(end * sampleRate)))
    const fastStart = Math.max(0, endSample - Math.round(fastSeconds * sampleRate))
    const momentaryStart = Math.max(0, endSample - Math.round(momentarySeconds * sampleRate))

    const fastEnergy = rangeEnergy(prefix, fastStart, endSample)
    const momentaryEnergy = rangeEnergy(prefix, momentaryStart, endSample)
    const trueLoudness = finiteLufs(momentaryEnergy)

    // Human loudness is closer to multiplicative than linear-in-dB. Use the
    // familiar approximation that +10 dB feels roughly twice as loud. The
    // -8 LUFS reference is only the 1.0 endpoint for our visual-control range.
    const fastLufs = finiteLufs(fastEnergy)
    const targetSensation = clamp(2 ** ((fastLufs + 8) / 10))
    const dt = Math.max(1 / pointsPerSecond, end - start)
    const tau = targetSensation > sensation ? attackSeconds : releaseSeconds
    const alpha = 1 - Math.exp(-dt / tau)
    sensation += (targetSensation - sensation) * alpha

    // Let sustained programme loudness hold the envelope up without allowing a
    // single 100 ms transient to define the whole 400 ms interval.
    const momentarySensation = clamp(2 ** ((trueLoudness + 8) / 10))
    const perceivedLoudness = clamp(Math.max(sensation, momentarySensation * 0.9))

    points.push({start, trueLoudness, perceivedLoudness})
  }

  return {duration, pointsPerSecond, points}
}

export function loudnessAt(timeline: LoudnessTimeline, time: number): LoudnessPoint | undefined {
  if (timeline.points.length === 0) return undefined
  const index = Math.max(0, Math.min(timeline.points.length - 1, Math.floor(time * timeline.pointsPerSecond)))
  return timeline.points[index]
}

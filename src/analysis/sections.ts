import type {FeatureFrame, FeatureTimeline} from "../dsp/features.js"
import type {DetectedBeat, PositionEstimate} from "../types.js"
import {clamp, cosineDistance, meanVectors, percentile} from "../math.js"

const CHROMA_DIMS = 12
const BAND_DIMS = 8
const DIMS = CHROMA_DIMS + BAND_DIMS + 2

function framesBetween(timeline: FeatureTimeline, start: number, end: number): FeatureFrame[] {
  return timeline.frames.filter((frame) => frame.center >= start && frame.center < end)
}

function intervalFeature(frames: FeatureFrame[]): Float32Array {
  const vector = new Float32Array(DIMS)
  if (frames.length === 0) return vector
  for (const frame of frames) {
    for (let i = 0; i < CHROMA_DIMS; i++) vector[i] = (vector[i] ?? 0) + (frame.chroma[i] ?? 0)
    for (let i = 0; i < BAND_DIMS; i++) {
      const at = CHROMA_DIMS + i
      vector[at] = (vector[at] ?? 0) + (frame.bands[i] ?? 0)
    }
    vector[CHROMA_DIMS + BAND_DIMS] = (vector[CHROMA_DIMS + BAND_DIMS] ?? 0) + frame.loudness
    vector[CHROMA_DIMS + BAND_DIMS + 1] = (vector[CHROMA_DIMS + BAND_DIMS + 1] ?? 0) + Math.log1p(frame.spectralFlux * 1e4)
  }
  const inv = 1 / frames.length
  for (let i = 0; i < vector.length; i++) vector[i] = (vector[i] ?? 0) * inv
  return vector
}

function makeUnits(timeline: FeatureTimeline, beats: DetectedBeat[]): {start: number; end: number; feature: Float32Array}[] {
  if (beats.length >= 8) {
    const units: {start: number; end: number; feature: Float32Array}[] = []
    for (let i = 0; i < beats.length; i++) {
      const start = beats[i]?.start ?? 0
      const end = beats[i + 1]?.start ?? timeline.duration
      if (end <= start) continue
      units.push({start, end, feature: intervalFeature(framesBetween(timeline, start, end))})
    }
    return units
  }

  // Graceful fallback for beatless/ambient audio: 1-second structural units.
  const units: {start: number; end: number; feature: Float32Array}[] = []
  for (let start = 0; start < timeline.duration; start += 1) {
    const end = Math.min(timeline.duration, start + 1)
    units.push({start, end, feature: intervalFeature(framesBetween(timeline, start, end))})
  }
  return units
}

function noveltyAt(features: Float32Array[], boundary: number, radius: number): number {
  if (boundary < radius || boundary + radius > features.length) return 0
  const left = meanVectors(features.slice(boundary - radius, boundary), DIMS)
  const right = meanVectors(features.slice(boundary, boundary + radius), DIMS)

  // Split tonal/timbral features so a giant loudness jump doesn't drown everything else.
  const tonal = cosineDistance(left.subarray(0, CHROMA_DIMS), right.subarray(0, CHROMA_DIMS))
  const timbral = cosineDistance(left.subarray(CHROMA_DIMS, CHROMA_DIMS + BAND_DIMS), right.subarray(CHROMA_DIMS, CHROMA_DIMS + BAND_DIMS))
  const loudness = Math.abs((left[CHROMA_DIMS + BAND_DIMS] ?? 0) - (right[CHROMA_DIMS + BAND_DIMS] ?? 0))
  const onset = Math.abs((left[CHROMA_DIMS + BAND_DIMS + 1] ?? 0) - (right[CHROMA_DIMS + BAND_DIMS + 1] ?? 0))
  return tonal * 0.45 + timbral * 0.35 + loudness * 0.12 + onset * 0.08
}

export function detectSectionStarts(timeline: FeatureTimeline, beats: DetectedBeat[]): PositionEstimate[] {
  const units = makeUnits(timeline, beats)
  if (units.length < 6) return [{start: 0, confidence: 1, index: 0}]
  const features = units.map((unit) => unit.feature)
  const novelty = new Float32Array(units.length)
  const radii = beats.length >= 8 ? [4, 8, 16] : [2, 4, 8]

  for (let i = 0; i < units.length; i++) {
    let total = 0
    let weights = 0
    for (let rIndex = 0; rIndex < radii.length; rIndex++) {
      const radius = radii[rIndex] ?? 1
      if (i < radius || i + radius > units.length) continue
      const weight = 1 / (1 + rIndex * 0.35)
      total += noveltyAt(features, i, radius) * weight
      weights += weight
    }
    novelty[i] = weights ? total / weights : 0
  }

  // Robustly normalize the curve and choose locally prominent changes.
  const floor = percentile(novelty, 0.5)
  const high = percentile(novelty, 0.9)
  const scale = Math.max(1e-6, high - floor)
  const candidates: PositionEstimate[] = []
  for (let i = 1; i < novelty.length - 1; i++) {
    const value = novelty[i] ?? 0
    if (value <= (novelty[i - 1] ?? 0) || value < (novelty[i + 1] ?? 0)) continue
    const confidence = clamp((value - floor) / scale)
    if (confidence < 0.25) continue
    const start = units[i]?.start ?? 0
    if (start < 4 || timeline.duration - start < 4) continue
    candidates.push({start, confidence, index: i})
  }

  // Non-maximum suppression in time. Structural sections shorter than ~6 s are rarely
  // useful to the visualizer; keep the stronger candidate when two are too close.
  const chosen: PositionEstimate[] = [{start: 0, confidence: 1, index: 0}]
  for (const candidate of candidates.sort((a, b) => a.start - b.start)) {
    const previous = chosen[chosen.length - 1]
    if (!previous || candidate.start - previous.start >= 6) {
      chosen.push(candidate)
      continue
    }
    if (previous.start !== 0 && candidate.confidence > previous.confidence) chosen[chosen.length - 1] = candidate
  }

  return chosen.map((section, index) => ({...section, index}))
}

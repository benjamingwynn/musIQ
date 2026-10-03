import type {FeatureTimeline} from "../dsp/features.js"
import type {DetectedBeat, PositionEstimate} from "../types.js"
import {clamp} from "../math.js"

function onsetEvidence(timeline: FeatureTimeline, time: number): number {
  const frameIndex = Math.round(time * timeline.sampleRate / timeline.hopSize)
  const radius = 2
  let localMax = 0
  let localMean = 0
  let count = 0
  for (let i = Math.max(0, frameIndex - radius); i <= Math.min(timeline.frames.length - 1, frameIndex + radius); i++) {
    const flux = timeline.frames[i]?.onsetStrength ?? 0
    localMax = Math.max(localMax, flux)
    localMean += flux
    count++
  }
  if (count === 0 || localMax === 0) return 0
  return clamp((localMean / count) / localMax)
}

function candidateScore(timeline: FeatureTimeline, a: number, b: number, subdivisions: number): number {
  let score = 0
  for (let k = 1; k < subdivisions; k++) {
    const t = a + (b - a) * k / subdivisions
    score += onsetEvidence(timeline, t)
  }
  return score / Math.max(1, subdivisions - 1)
}

/**
 * Estimate the tatum grid as the smallest perceptually-supported regular subdivision
 * of each beat interval. This is intentionally tied to the beat grid rather than a
 * second independent beat detector.
 */
export function makeTatums(beats: DetectedBeat[], timeline: FeatureTimeline): PositionEstimate[] {
  if (beats.length < 2) return []
  const tatums: PositionEstimate[] = []

  for (let i = 0; i < beats.length - 1; i++) {
    const current = beats[i]
    const next = beats[i + 1]
    if (!current || !next) continue
    const duration = next.start - current.start
    if (!(duration > 0.12 && duration < 2.5)) continue

    const options = [2, 3, 4]
    let best = 2
    let bestScore = -Infinity
    for (const subdivision of options) {
      // Prefer the simpler grid unless extra subdivision points have actual onset support.
      const evidence = candidateScore(timeline, current.start, next.start, subdivision)
      const complexityPenalty = (subdivision - 2) * 0.08
      const score = evidence - complexityPenalty
      if (score > bestScore) {
        best = subdivision
        bestScore = score
      }
    }

    for (let k = 0; k < best; k++) {
      const start = current.start + duration * k / best
      const support = k === 0 ? current.confidence : onsetEvidence(timeline, start)
      tatums.push({start, confidence: clamp(0.35 + support * 0.65), index: tatums.length})
    }
  }

  const last = beats[beats.length - 1]
  if (last) tatums.push({start: last.start, confidence: clamp(last.confidence), index: tatums.length})
  return tatums
}

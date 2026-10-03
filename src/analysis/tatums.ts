import type {FeatureTimeline} from "../dsp/features.js"
import type {DetectedBeat, PositionEstimate} from "../types.js"
import {clamp} from "../math.js"
import {createOnsetEvidence} from "./beat-salience.js"

/**
 * Estimate the tatum grid as the smallest perceptually-supported regular subdivision
 * of each beat interval. This is intentionally tied to the beat grid rather than a
 * second independent beat detector.
 */
export function makeTatums(beats: DetectedBeat[], timeline: FeatureTimeline): PositionEstimate[] {
	if (beats.length < 2) return []
	const tatums: PositionEstimate[] = []
	const evidenceAt = createOnsetEvidence(timeline)
	const minimumSupport = 0.23

	for (let i = 0; i < beats.length - 1; i++) {
		const current = beats[i]
		const next = beats[i + 1]
		if (!current || !next) continue
		const duration = next.start - current.start
		if (!(duration > 0.12 && duration < 2.5)) continue

		// Keep the beat as an anchor; absent evidence must not invent subdivisions.
		let bestSupport: number[] = []
		let bestScore = 0
		for (const subdivision of [2, 3, 4]) {
			// A nearby beat or neighbouring subdivision must not support this point.
			const tolerance = Math.min(0.035, duration / subdivision / 4)
			const support: number[] = []
			for (let k = 1; k < subdivision; k++) {
				const time = current.start + (duration * k) / subdivision
				support.push(evidenceAt(time, tolerance).evidence)
			}
			if (support.some((value) => value < minimumSupport)) continue
			// Reward additional supported attacks, charging each point an evidence
			// threshold. Sixteenths can beat eighths when all attacks are present.
			const score = support.reduce((sum, value) => sum + value - minimumSupport, 0)
			if (score > bestScore) {
				bestSupport = support
				bestScore = score
			}
		}

		tatums.push({start: current.start, confidence: clamp(current.confidence), index: tatums.length})
		for (let k = 0; k < bestSupport.length; k++) {
			const start = current.start + (duration * (k + 1)) / (bestSupport.length + 1)
			tatums.push({start, confidence: bestSupport[k] ?? 0, index: tatums.length})
		}
	}

	const last = beats[beats.length - 1]
	if (last) tatums.push({start: last.start, confidence: clamp(last.confidence), index: tatums.length})
	return tatums
}

import type {FeatureFrame} from "../dsp/features.js"
import {clamp} from "../math.js"

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

function normalizedCorrelation(chroma: Float64Array, profile: number[], shift: number): number {
	let dot = 0
	let aa = 0
	let bb = 0
	for (let pc = 0; pc < 12; pc++) {
		const a = chroma[pc] ?? 0
		const b = profile[(pc - shift + 12) % 12] ?? 0
		dot += a * b
		aa += a * a
		bb += b * b
	}
	return aa && bb ? dot / Math.sqrt(aa * bb) : 0
}

/** Returns C..B major followed by C..B minor; sums to 1. */
export function keyEvidence(frames: ReadonlyArray<FeatureFrame>): Float32Array {
	const chroma = new Float64Array(12)
	for (const frame of frames) {
		// Weight tonal evidence by loudness so silence doesn't dominate a section.
		const weight = 0.1 + frame.loudness
		for (let i = 0; i < 12; i++) chroma[i] = (chroma[i] ?? 0) + (frame.chroma[i] ?? 0) * weight
	}

	const scores = new Float64Array(24)
	for (let tonic = 0; tonic < 12; tonic++) {
		scores[tonic] = normalizedCorrelation(chroma, MAJOR, tonic)
		scores[12 + tonic] = normalizedCorrelation(chroma, MINOR, tonic)
	}

	// Softmax makes the result useful as relative evidence while preserving ambiguity.
	let max = -Infinity
	for (const score of scores) max = Math.max(max, score)
	const temperature = 0.08
	let total = 0
	for (let i = 0; i < scores.length; i++) {
		const value = Math.exp((clamp(scores[i] ?? 0, -1, 1) - max) / temperature)
		scores[i] = value
		total += value
	}
	const out = new Float32Array(24)
	if (!total) return out.fill(1 / 24)
	for (let i = 0; i < 24; i++) out[i] = (scores[i] ?? 0) / total
	return out
}

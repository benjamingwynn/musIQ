import type {FeatureTimeline} from "../dsp/features.js"
import {percentile} from "../math.js"

const EPS = 1e-12

function normalizedEnvelope(timeline: FeatureTimeline, from: number, to: number, pick: (index: number) => number): Float64Array {
	const values: number[] = []
	for (let i = Math.max(0, from); i < Math.min(timeline.frames.length, to); i++) values.push(Math.log1p(Math.max(0, pick(i))))
	const floor = percentile(values, 0.5)
	const high = percentile(values, 0.99)
	const scale = Math.max(EPS, high - floor)
	return Float64Array.from(values, (value) => Math.min(1.5, Math.max(0, value - floor) / scale))
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
	const logRatio = Math.log2(Math.max(EPS, bpm) / 120)
	return Math.exp(-0.5 * (logRatio / 0.8) ** 2)
}

/** Local autocorrelation-tempogram evidence for one candidate tempo. */
export function tempoEvidence(timeline: FeatureTimeline, fromFrame: number, toFrame: number, bpm: number): number {
	if (!(bpm > 0) || toFrame - fromFrame < 4) return 0
	const full = normalizedEnvelope(timeline, fromFrame, toFrame, (i) => timeline.frames[i]?.onsetStrength ?? 0)
	const bass = normalizedEnvelope(timeline, fromFrame, toFrame, (i) => timeline.frames[i]?.lowOnsetStrength ?? 0)
	const lag = Math.max(1, Math.round((timeline.sampleRate / timeline.hopSize) * 60 / bpm))
	return (autocorrelation(full, lag) * 0.72 + autocorrelation(bass, lag) * 0.28) * tempoPrior(bpm)
}

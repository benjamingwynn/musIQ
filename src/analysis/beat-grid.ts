import type {FeatureFrame, FeatureTimeline} from "../dsp/features.js"
import {percentile} from "../math.js"
export type RawBeat = {start: number; confidence: number; bpm: number}

const EPS = 1e-12

function median(values: number[]): number {
	return percentile(values, 0.5)
}

function normalizedEnvelope(frames: FeatureFrame[], pick: (frame: FeatureFrame) => number): Float64Array {
	const values = frames.map((frame) => Math.log1p(Math.max(0, pick(frame))))
	const floor = median(values)
	const scale = Math.max(EPS, percentile(values, 0.99) - floor)
	return Float64Array.from(values, (value) => Math.min(1.5, Math.max(0, value - floor) / scale))
}

function autocorrelation(envelope: Float64Array, lag: number): number {
	if (lag < 1 || lag >= envelope.length) return 0
	let dot = 0
	let left = 0
	let right = 0
	for (let i = 0; i + lag < envelope.length; i++) {
		const a = envelope[i]!
		const b = envelope[i + lag]!
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

function frameIndexAt(timeline: FeatureTimeline, time: number): number {
	return Math.max(0, Math.min(timeline.frames.length, Math.ceil((time * timeline.sampleRate - timeline.frameSize / 2) / timeline.hopSize)))
}

/** A single missed beat must not start a new tempo run. Require three new intervals. */
function tempoRuns(beats: RawBeat[]): RawBeat[][] {
	const runs: RawBeat[][] = []
	let start = 0
	let recent: number[] = []
	for (let i = 1; i < beats.length; i++) {
		const interval = beats[i]!.start - beats[i - 1]!.start
		const reference = median(recent)
		const changed = reference > 0 && (interval > reference * 1.25 || interval < reference / 1.25)
		if (changed && i + 2 < beats.length) {
			const following = [beats[i + 1]!.start - beats[i]!.start, beats[i + 2]!.start - beats[i + 1]!.start]
			if (following.every((value) => Math.abs(value / interval - 1) < 0.15)) {
				// The beat preceding the first new interval belongs to the new run.
				const boundary = i - 1
				if (boundary > start) runs.push(beats.slice(start, boundary))
				start = boundary
				recent = []
			}
		}
		if (interval > 0) recent.push(interval)
		if (recent.length > 5) recent.shift()
	}
	if (start < beats.length) runs.push(beats.slice(start))
	return runs
}

function beatStrength(timeline: FeatureTimeline, time: number): number {
	let full = 0
	let bass = 0
	const end = frameIndexAt(timeline, time + 0.035)
	for (let i = frameIndexAt(timeline, time - 0.035); i < end; i++) {
		full = Math.max(full, timeline.frames[i]!.onsetStrength)
		bass = Math.max(bass, timeline.frames[i]!.lowOnsetStrength)
	}
	return Math.log1p(full) * 0.68 + Math.log1p(bass) * 0.32
}

function resolveRun(beats: RawBeat[], timeline: FeatureTimeline): RawBeat[] {
	if (!beats.length) return []
	const intervals = beats.slice(1).map((beat, i) => beat.start - beats[i]!.start)
	const fallbackPeriod = median(intervals)
	// Estimate the underlying period before filtering. Missing events or a phase
	// switch must not turn a long output gap into an artificial tempo slowdown.
	const periods = beats.map((beat, i) => median(intervals.slice(Math.max(0, i - 2), Math.min(intervals.length, i + 3))) || fallbackPeriod || (beat.bpm > 0 ? 60 / beat.bpm : 0))
	const ticks = [0]
	for (let i = 1; i < beats.length; i++) {
		// Preserve metrical parity across missing raw events without inventing beats.
		const steps = Math.max(1, Math.round(intervals[i - 1]! / periods[i]!))
		ticks.push(ticks[i - 1]! + steps)
	}
	const strengths = beats.map((beat) => beatStrength(timeline, beat.start))
	const selected: RawBeat[] = []
	let halfTime = false
	let parity = 0
	let fullScore = 0
	let halfScore = 0
	for (let i = 0; i < beats.length; i++) {
		const bpm = periods[i]! > 0 ? 60 / periods[i]! : beats[i]!.bpm
		if (beats.length >= 8 && bpm >= 130) {
			// Reuse each spectral decision for four beats. Normalize each envelope
			// once for both candidate periods, rather than four times on every beat.
			if (i % 4 === 0) {
				const first = Math.max(0, Math.min(i - 8, beats.length - 17))
				const last = Math.min(beats.length - 1, first + 16)
				const from = frameIndexAt(timeline, beats[first]!.start - periods[i]! / 2)
				const to = frameIndexAt(timeline, beats[last]!.start + periods[i]! / 2)
				const frames = timeline.frames.slice(from, to)
				const full = normalizedEnvelope(frames, (frame) => frame.onsetStrength)
				const bass = normalizedEnvelope(frames, (frame) => frame.lowOnsetStrength)
				const score = (tempo: number) => {
					const lag = Math.round(timeline.sampleRate / timeline.hopSize * 60 / tempo)
					return (autocorrelation(full, lag) * 0.72 + autocorrelation(bass, lag) * 0.28) * tempoPrior(tempo)
				}
				fullScore = score(bpm)
				halfScore = score(bpm / 2)
			}
			const nextHalfTime: boolean = halfScore > fullScore * (halfTime ? 1 : 1.08)
			if (nextHalfTime) {
				const sums = [0, 0]
				const counts = [0, 0]
				for (let j = Math.max(0, i - 4); j <= Math.min(beats.length - 1, i + 4); j++) {
					const phase = ticks[j]! % 2
					sums[phase]! += strengths[j]!
					counts[phase]!++
				}
				const evidence = sums.map((sum, phase) => sum / Math.max(1, counts[phase]!))
				const preferred = evidence[1]! > evidence[0]! ? 1 : 0
				// Reconsider phase when several nearby attacks favour the other one.
				// A margin retains continuity through ambiguous/equal accents.
				if (!halfTime || evidence[preferred]! > evidence[parity]! * 1.5) parity = preferred
			}
			halfTime = nextHalfTime
		} else {
			halfTime = false
		}
		if (!halfTime || ticks[i]! % 2 === parity) selected.push({...beats[i]!, bpm: bpm / (halfTime ? 2 : 1)})
	}
	return selected
}

/** Correct double-time grids locally, preserving genuinely fast passages. */
export function resolveBeatGrid(beats: RawBeat[], timeline: FeatureTimeline): RawBeat[] {
	return tempoRuns(beats).flatMap((run) => resolveRun(run, timeline))
}

import type {FeatureFrame, FeatureTimeline} from "../dsp/features.js"
import {percentile} from "../math.js"
import {tempoEvidence} from "./tempogram.js"
export type RawBeat = {start: number; confidence: number; bpm: number}

const HALF_TIME_WEAK_PARITY_RATIO = 0.25
const HALF_TIME_MIN_STRONG_PARITY = 0.25

function median(values: number[]): number {
	return percentile(values, 0.5)
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

function parityEvidence(strengths: number[], ticks: number[], index: number): [number, number] {
	const sums = [0, 0]
	const counts = [0, 0]
	for (let j = Math.max(0, index - 4); j <= Math.min(strengths.length - 1, index + 4); j++) {
		const phase = ticks[j]! % 2
		sums[phase]! += strengths[j]!
		counts[phase]!++
	}
	return [sums[0]! / Math.max(1, counts[0]!), sums[1]! / Math.max(1, counts[1]!)]
}

function supportsHalfTime(evidence: [number, number]): boolean {
	const stronger = Math.max(evidence[0], evidence[1])
	const weaker = Math.min(evidence[0], evidence[1])
	return stronger >= HALF_TIME_MIN_STRONG_PARITY && weaker <= stronger * HALF_TIME_WEAK_PARITY_RATIO
}

function resolveRun(beats: RawBeat[], timeline: FeatureTimeline): RawBeat[] {
	if (!beats.length) return []
	const intervals = beats.slice(1).map((beat, i) => beat.start - beats[i]!.start)
	const fallbackPeriod = median(intervals)
	const periods = beats.map((beat, i) => median(intervals.slice(Math.max(0, i - 2), Math.min(intervals.length, i + 3))) || fallbackPeriod || (beat.bpm > 0 ? 60 / beat.bpm : 0))
	const ticks = [0]
	for (let i = 1; i < beats.length; i++) {
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
			if (i % 4 === 0) {
				const first = Math.max(0, Math.min(i - 8, beats.length - 17))
				const last = Math.min(beats.length - 1, first + 16)
				const from = frameIndexAt(timeline, beats[first]!.start - periods[i]! / 2)
				const to = frameIndexAt(timeline, beats[last]!.start + periods[i]! / 2)
				fullScore = tempoEvidence(timeline, from, to, bpm)
				halfScore = tempoEvidence(timeline, from, to, bpm / 2)
			}
			const evidence = parityEvidence(strengths, ticks, i)
			const spectralHalfTime: boolean = halfScore > fullScore * (halfTime ? 1 : 1.08)
			const nextHalfTime: boolean = spectralHalfTime && supportsHalfTime(evidence)
			if (nextHalfTime) {
				const preferred = evidence[1]! > evidence[0]! ? 1 : 0
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

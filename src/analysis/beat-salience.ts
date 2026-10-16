import type {FeatureFrame, FeatureTimeline} from "../dsp/features.js"
import {clamp, percentile} from "../math.js"
import type {RawBeat} from "./beat-grid.js"

const EPS = 1e-9

function frameIndexAt(timeline: FeatureTimeline, time: number): number {
	return Math.max(0, Math.min(timeline.frames.length - 1, Math.round((time * timeline.sampleRate - timeline.frameSize / 2) / timeline.hopSize)))
}

function framesAround(timeline: FeatureTimeline, time: number, seconds: number): FeatureFrame[] {
	if (!timeline.frames.length) return []
	const center = frameIndexAt(timeline, time)
	const radius = Math.ceil((seconds * timeline.sampleRate) / timeline.hopSize)
	return timeline.frames.slice(Math.max(0, center - radius), Math.min(timeline.frames.length, center + radius + 1))
}

function localPeak(timeline: FeatureTimeline, time: number, pick: (frame: FeatureFrame) => number, tolerance: number): number {
	// Beat timestamps and attack peaks need not coincide exactly. SuperFlux-style
	// onset evaluation commonly uses tens-of-ms peak windows; give the grid 70 ms.
	let peak = 0
	for (const frame of framesAround(timeline, time, tolerance)) {
		if (Math.abs(frame.center - time) <= tolerance) peak = Math.max(peak, Math.max(0, pick(frame)))
	}
	return peak
}

function adaptiveSupport(timeline: FeatureTimeline, time: number, pick: (frame: FeatureFrame) => number, globalHigh: number, tolerance: number): number {
	const peak = localPeak(timeline, time, pick, tolerance)
	if (!(peak > 0)) return 0

	// A several-second context lets the threshold adapt when a track moves from a
	// dense beat into a sustained/drone passage. Median + upper percentile is a
	// robust analogue of the local-mean threshold used by SuperFlux peak picking.
	const local = framesAround(timeline, time, 2.5).map((frame) => Math.max(0, pick(frame)))
	const floor = percentile(local, 0.5)
	const high = percentile(local, 0.9)
	const localContrast = clamp((peak - floor) / Math.max(EPS, high - floor))
	const globalContrast = clamp(peak / Math.max(EPS, globalHigh))

	// Local contrast lets quieter passages still produce beats. Global contrast
	// prevents a flat drone's tiny numerical ripples from becoming "strong" just
	// because everything nearby is equally tiny.
	// Both conditions matter: a peak should stand out from its local context, and
	// it should be non-trivial on the track's overall onset scale. Geometric
	// combination prevents tiny stationary-tone ripples from scoring 1.0 merely
	// because their local neighbourhood is equally tiny.
	return clamp(Math.sqrt(localContrast * globalContrast))
}

export type OnsetEvidence = {
	evidence: number
	fullBandEvidence: number
	bassEvidence: number
}

/** Reuse the track reference levels when evaluating beats or subdivisions. */
export function createOnsetEvidence(timeline: FeatureTimeline): (time: number, tolerance?: number) => OnsetEvidence {
	const fullGlobal = Math.max(
		EPS,
		percentile(
			timeline.frames.map((frame) => Math.max(0, frame.onsetStrength)),
			0.999
		)
	)
	const bassGlobal = Math.max(
		EPS,
		percentile(
			timeline.frames.map((frame) => Math.max(0, frame.lowOnsetStrength)),
			0.999
		)
	)

	return (time, tolerance = 0.07) => {
		const fullBandEvidence = adaptiveSupport(timeline, time, (frame) => frame.onsetStrength, fullGlobal, tolerance)
		const bassEvidence = adaptiveSupport(timeline, time, (frame) => frame.lowOnsetStrength, bassGlobal, tolerance)
		// Bass helps distinguish a kick-defined pulse from hats/subdivisions, but a
		// snare/clap must be allowed to support a beat on its own.
		const evidence = clamp(fullBandEvidence * 0.78 + bassEvidence * 0.22)
		return {evidence, fullBandEvidence, bassEvidence}
	}
}

export type BeatSalience = OnsetEvidence & {beat: RawBeat}

export function beatSalience(beats: RawBeat[], timeline: FeatureTimeline): BeatSalience[] {
	if (!beats.length || !timeline.frames.length) return []
	const evidenceAt = createOnsetEvidence(timeline)
	return beats.map((beat) => ({beat, ...evidenceAt(beat.start)}))
}

/**
 * Convert the internal metrical grid into public, acoustically salient beat
 * events. The grid may keep running through a held pad/drone; beats[] should not
 * fire the visualizer unless the audio supplies a real local attack.
 */
export function selectSalientBeats(beats: RawBeat[], timeline: FeatureTimeline): RawBeat[] {
	const salience = beatSalience(beats, timeline)
	if (!salience.length) return []

	return salience.flatMap(({beat, evidence, fullBandEvidence, bassEvidence}) => {
		// Require an actual onset. Aubio confidence is allowed to refine confidence
		// once evidence exists, but cannot manufacture a beat in a sustained region.
		const supported = evidence >= 0.23 && (fullBandEvidence >= 0.2 || bassEvidence >= 0.28)
		if (!supported) return []
		return [
			{
				...beat,
				confidence: clamp(evidence * 0.76 + beat.confidence * 0.24),
			},
		]
	})
}

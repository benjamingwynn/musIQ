import type {DetectedSegment} from "../types.js"
import type {FeatureFrame, FeatureTimeline} from "../dsp/features.js"
import {SPECTRUM_BAND_COUNT} from "../dsp/features.js"
import type {LoudnessTimeline} from "../dsp/loudness.js"
import {clamp, percentile} from "../math.js"

function mean(frames: FeatureFrame[], pick: (frame: FeatureFrame) => number): number {
	if (frames.length === 0) return 0
	let sum = 0
	for (const frame of frames) sum += pick(frame)
	return sum / frames.length
}

function meanSpectrum(frames: FeatureFrame[]): Float32Array {
	const spectrum = new Float32Array(SPECTRUM_BAND_COUNT)
	if (!frames.length) return spectrum
	for (const frame of frames) {
		for (let i = 0; i < spectrum.length; i++) spectrum[i] = (spectrum[i] ?? 0) + (frame.bands[i] ?? 0)
	}
	for (let i = 0; i < spectrum.length; i++) spectrum[i] = (spectrum[i] ?? 0) / frames.length
	return spectrum
}

export function makeSegments(timeline: FeatureTimeline, loudness: LoudnessTimeline, perSecond = 10): DetectedSegment[] {
	const count = Math.max(1, Math.ceil(timeline.duration * perSecond))
	const width = timeline.duration / count
	const segments: DetectedSegment[] = []
	let previousRms = 0
	let frameCursor = 0

	for (let i = 0; i < count; i++) {
		const start = i * width
		const end = i === count - 1 ? timeline.duration + Number.EPSILON : (i + 1) * width
		const frames: FeatureFrame[] = []
		while (frameCursor < timeline.frames.length && (timeline.frames[frameCursor]?.center ?? Infinity) < start) frameCursor++
		let j = frameCursor
		while (j < timeline.frames.length && (timeline.frames[j]?.center ?? Infinity) < end) {
			const frame = timeline.frames[j]
			if (frame) frames.push(frame)
			j++
		}
		// Very short segments can fall between STFT centres. Use the nearest frame rather than emit NaN/zero gaps.
		if (frames.length === 0 && timeline.frames.length) {
			const target = (start + end) / 2
			const nearestIndex = Math.min(timeline.frames.length - 1, Math.max(0, Math.round((target * timeline.sampleRate) / timeline.hopSize)))
			const nearest = timeline.frames[nearestIndex]
			if (nearest) frames.push(nearest)
		}

		const rmsEnergy = mean(frames, (f) => f.rms)
		const loudnessPoint = loudness.points[Math.min(loudness.points.length - 1, i)]
		const segment: DetectedSegment = {
			start,
			rmsEnergy,
			deltaRms: i === 0 ? 0 : rmsEnergy - previousRms,
			lowEnergy: mean(frames, (f) => f.lowEnergy),
			midEnergy: mean(frames, (f) => f.midEnergy),
			highEnergy: mean(frames, (f) => f.highEnergy),
			zeroCrossingRate: mean(frames, (f) => f.zcr),
			spectrum: meanSpectrum(frames),
			perceivedLoudness: loudnessPoint?.perceivedLoudness ?? 0,
			trueLoudness: loudnessPoint?.trueLoudness ?? -120,
		}
		previousRms = rmsEnergy
		segments.push(segment)
	}

	// Use one robust track-wide reference so adjacent segments are comparable and
	// quiet passages remain quiet. A handful of spectral spikes may clip without
	// compressing the response curve for the rest of the track.
	const spectrumValues: number[] = []
	for (const segment of segments) {
		for (const value of segment.spectrum) spectrumValues.push(value)
	}
	const spectrumReference = percentile(spectrumValues, 0.995)
	if (spectrumReference > 0) {
		for (const segment of segments) {
			for (let i = 0; i < segment.spectrum.length; i++) {
				segment.spectrum[i] = clamp((segment.spectrum[i] ?? 0) / spectrumReference)
			}
		}
	}
	return segments
}

export function segmentAt(segments: DetectedSegment[], time: number): DetectedSegment | undefined {
	if (segments.length === 0) return undefined
	let lo = 0
	let hi = segments.length - 1
	while (lo <= hi) {
		const mid = (lo + hi) >> 1
		const value = segments[mid]
		if (!value) break
		if (value.start <= time) lo = mid + 1
		else hi = mid - 1
	}
	return segments[Math.max(0, hi)]
}

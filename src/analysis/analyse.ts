import {extractFeatureTimeline} from "../dsp/features.js"
import {extractLoudnessTimeline} from "../dsp/loudness.js"
import {makeSegments, segmentAt} from "./segments.js"
import {detectRawBeats} from "./beats-core.js"
import {resolveBeatGrid} from "./beat-grid.js"
import {selectSalientBeats} from "./beat-salience.js"
import {makeTatums} from "./tatums.js"
import {detectSectionStarts} from "./sections.js"
import {keyEvidence} from "./keys.js"
import {numbersToStatisticalRange} from "../math.js"
import type {Analysis, DetectedBeat, DetectedSection} from "../types.js"

export type DecodedForAnalysis = {
	channels: Float32Array[]
	sampleRate: number
	duration: number
}

function mixToMono(channels: ReadonlyArray<Float32Array>): Float32Array {
	if (channels.length === 0) return new Float32Array()
	if (channels.length === 1) return channels[0]?.slice() ?? new Float32Array()

	let length = 0
	for (const channel of channels) length = Math.max(length, channel.length)
	const mono = new Float32Array(length)
	const gain = 1 / channels.length
	for (const channel of channels) {
		for (let i = 0; i < channel.length; i++) mono[i] = (mono[i] ?? 0) + (channel[i] ?? 0) * gain
	}
	return mono
}

/** Entire CPU-heavy musIQ pipeline. This function is deliberately worker-safe. */
export async function analyseDecoded(decoded: DecodedForAnalysis): Promise<Analysis> {
	const mono = mixToMono(decoded.channels)
	const timeline = extractFeatureTimeline(mono, decoded.sampleRate)
	const loudness = extractLoudnessTimeline(decoded.channels, decoded.sampleRate, decoded.duration, 10)
	const segments = makeSegments(timeline, loudness, 10)

	const aubioBeats = await detectRawBeats(decoded.sampleRate, mono)
	// Keep the metrical grid internally even when a sustained passage has no
	// acoustically salient attacks. Public beats[] is intentionally sparser: it
	// should drive visuals when something is actually perceived to hit.
	const rawBeatGrid = resolveBeatGrid(aubioBeats, timeline)
	const beatGrid: DetectedBeat[] = rawBeatGrid.map((beat, index) => ({
		...beat,
		index,
		perceivedLoudness: segmentAt(segments, beat.start)?.perceivedLoudness ?? 0,
		trueLoudness: segmentAt(segments, beat.start)?.trueLoudness ?? -120,
	}))

	const salientRawBeats = selectSalientBeats(rawBeatGrid, timeline)
	const beats: DetectedBeat[] = salientRawBeats.map((beat, index) => ({
		...beat,
		index,
		perceivedLoudness: segmentAt(segments, beat.start)?.perceivedLoudness ?? 0,
		trueLoudness: segmentAt(segments, beat.start)?.trueLoudness ?? -120,
	}))

	// Tatums and structural segmentation use the metrical grid, not the sparse
	// public event stream. A drone can still have an inferred tempo without
	// causing music.changed.beat to fire every grid tick.
	const tatums = makeTatums(beatGrid, timeline)
	const sectionStarts = detectSectionStarts(timeline, beatGrid)

	const sections: DetectedSection[] = sectionStarts.map((section, index) => {
		const end = sectionStarts[index + 1]?.start ?? decoded.duration
		const sectionSegments = segments.filter((segment) => segment.start >= section.start && segment.start < end)
		const sectionFrames = timeline.frames.filter((frame) => frame.center >= section.start && frame.center < end)
		const sectionBeats = beatGrid.filter((beat) => beat.start >= section.start && beat.start < end)
		return {
			start: section.start,
			confidence: section.confidence,
			index,
			keys: keyEvidence(sectionFrames),
			bpm: numbersToStatisticalRange(sectionBeats.map((beat) => beat.bpm)),
			perceivedLoudness: numbersToStatisticalRange(sectionSegments.map((segment) => segment.perceivedLoudness)),
			trueLoudness: numbersToStatisticalRange(sectionSegments.map((segment) => segment.trueLoudness)),
			segments: sectionSegments,
		}
	})

	return {sections, tatums, beats, segments}
}

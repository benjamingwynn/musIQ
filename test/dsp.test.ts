// @ts-ignore Node types are intentionally not a package dependency of the browser library
import test from "node:test"
// @ts-ignore Node types are intentionally not a package dependency of the browser library
import assert from "node:assert/strict"
import {extractFeatureTimeline} from "../src/dsp/features.js"
import {makeSegments} from "../src/analysis/segments.js"
import {extractLoudnessTimeline} from "../src/dsp/loudness.js"
import {keyEvidence} from "../src/analysis/keys.js"
import {numbersToStatisticalRange} from "../src/math.js"
import {detectSectionStarts} from "../src/analysis/sections.js"

function sine(frequency: number, seconds: number, sampleRate = 44100): Float32Array {
	const data = new Float32Array(Math.round(seconds * sampleRate))
	for (let i = 0; i < data.length; i++) data[i] = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 0.5
	return data
}

test("shared feature timeline produces finite truthful segment fields", () => {
	const timeline = extractFeatureTimeline(sine(440, 2), 44100)
	const loudness = extractLoudnessTimeline([sine(440, 2)], 44100, 2)
	const segments = makeSegments(timeline, loudness)
	assert.ok(segments.length >= 19 && segments.length <= 21)
	for (const segment of segments) {
		for (const value of Object.values(segment)) assert.equal(Number.isFinite(value), true)
		const bandSum = segment.lowEnergy + segment.midEnergy + segment.highEnergy
		assert.ok(Math.abs(bandSum - 1) < 0.05)
		assert.ok(segment.perceivedLoudness >= 0 && segment.perceivedLoudness <= 1)
		assert.ok(segment.trueLoudness <= 10 && segment.trueLoudness >= -120)
	}
})

test("statistical ranges do not emit Infinity/NaN for empty sections", () => {
	assert.deepEqual(numbersToStatisticalRange([]), {min: 0, max: 0, avg: 0})
})

test("key evidence is a 24-way probability distribution", () => {
	const timeline = extractFeatureTimeline(sine(261.625565, 2), 44100)
	const keys = keyEvidence(timeline.frames)
	assert.equal(keys.length, 24)
	const sum = Array.from(keys).reduce((a, b) => a + b, 0)
	assert.ok(Math.abs(sum - 1) < 1e-5)
	for (const key of keys) assert.ok(key >= 0 && key <= 1)
})

test("key evidence ranks a synthetic C-major triad as C major", () => {
	const sampleRate = 44100
	const data = new Float32Array(sampleRate * 3)
	const frequencies = [261.625565, 329.627557, 391.995436]
	for (let i = 0; i < data.length; i++) {
		for (const frequency of frequencies) data[i] = (data[i] ?? 0) + 0.2 * Math.sin((2 * Math.PI * frequency * i) / sampleRate)
	}
	const keys = keyEvidence(extractFeatureTimeline(data, sampleRate).frames)
	let best = 0
	for (let i = 1; i < keys.length; i++) if ((keys[i] ?? 0) > (keys[best] ?? 0)) best = i
	assert.equal(best, 0) // C major
})

test("section novelty finds an obvious structural change", () => {
	const sampleRate = 44100
	const data = new Float32Array(sampleRate * 20)
	const first = [261.625565, 329.627557, 391.995436]
	const second = [220, 261.625565, 329.627557]
	for (let i = 0; i < data.length; i++) {
		const frequencies = i < sampleRate * 10 ? first : second
		for (const frequency of frequencies) data[i] = (data[i] ?? 0) + 0.15 * Math.sin((2 * Math.PI * frequency * i) / sampleRate)
	}
	const timeline = extractFeatureTimeline(data, sampleRate)
	const sections = detectSectionStarts(timeline, [])
	assert.ok(sections.some((section) => Math.abs(section.start - 10) < 1.1))
})

import {resolveBeatGrid} from "../src/analysis/beat-grid.js"
import type {FeatureTimeline} from "../src/dsp/features.js"
import type {RawBeat} from "../src/analysis/beat-grid.js"

function fakeBeatTimeline(bpm: number, strongEveryOther: boolean): {timeline: FeatureTimeline; beats: RawBeat[]} {
	const sampleRate = 44100
	const hopSize = 512
	const frameSize = 2048
	const duration = 16
	const count = Math.ceil((duration * sampleRate) / hopSize)
	const frames = Array.from({length: count}, (_, i) => ({
		start: (i * hopSize) / sampleRate,
		center: (i * hopSize + frameSize / 2) / sampleRate,
		rms: 0.1,
		zcr: 0.1,
		lowEnergy: 0.3,
		midEnergy: 0.4,
		highEnergy: 0.3,
		loudness: 0.6,
		spectralFlux: 0.01,
		lowFlux: 0.005,
		midFlux: 0.003,
		highFlux: 0.002,
		onsetStrength: 0.01,
		lowOnsetStrength: 0.005,
		chroma: new Float32Array(12),
		bands: new Float32Array(8),
	}))
	const period = 60 / bpm
	const beats: RawBeat[] = []
	for (let start = 1, index = 0; start < duration - 1; start += period, index++) {
		beats.push({start, confidence: 0.8, bpm})
		const target = frames.reduce((best, frame) => (Math.abs(frame.center - start) < Math.abs(best.center - start) ? frame : best), frames[0]!)
		const strong = !strongEveryOther || index % 2 === 0
		target.spectralFlux = strong ? 10 : 1
		target.lowFlux = strong ? 8 : 0.2
		target.onsetStrength = strong ? 10 : 1
		target.lowOnsetStrength = strong ? 8 : 0.2
	}
	return {timeline: {sampleRate, duration, frameSize, hopSize, frames}, beats}
}

test("beat grid halves a double-time grid when alternate pulses dominate", () => {
	const {timeline, beats} = fakeBeatTimeline(160, true)
	const resolved = resolveBeatGrid(beats, timeline)
	assert.ok(resolved.length <= Math.ceil(beats.length / 2))
	const bpm = resolved.slice(1).reduce((sum, beat) => sum + beat.bpm, 0) / Math.max(1, resolved.length - 1)
	assert.ok(Math.abs(bpm - 80) < 2)
})

test("beat grid keeps genuinely strong fast beats", () => {
	const {timeline, beats} = fakeBeatTimeline(160, false)
	const resolved = resolveBeatGrid(beats, timeline)
	assert.equal(resolved.length, beats.length)
	const bpm = resolved.slice(1).reduce((sum, beat) => sum + beat.bpm, 0) / Math.max(1, resolved.length - 1)
	assert.ok(Math.abs(bpm - 160) < 2)
})

test("BS.1770-style true loudness is close to -3.01 LUFS for a full-scale 997 Hz mono sine", () => {
	const sampleRate = 48000
	const signal = sine(997, 2, sampleRate)
	for (let i = 0; i < signal.length; i++) signal[i] = (signal[i] ?? 0) * 2
	const loudness = extractLoudnessTimeline([signal], sampleRate, 2)
	const steady = loudness.points[loudness.points.length - 1]!
	assert.ok(Math.abs(steady.trueLoudness - -3.01) < 0.35, `got ${steady.trueLoudness}`)
})

test("perceived loudness keeps bass materially alive compared with the old A-weighted proxy", () => {
	const sampleRate = 48000
	const bass = extractLoudnessTimeline([sine(100, 2, sampleRate)], sampleRate, 2)
	const mid = extractLoudnessTimeline([sine(1000, 2, sampleRate)], sampleRate, 2)
	const bassValue = bass.points[bass.points.length - 1]!.perceivedLoudness
	const midValue = mid.points[mid.points.length - 1]!.perceivedLoudness
	assert.ok(bassValue > 0.35 * midValue, `bass=${bassValue}, mid=${midValue}`)
})

import {selectSalientBeats} from "../src/analysis/beat-salience.js"

function regularRawBeats(duration: number, bpm: number): RawBeat[] {
	const period = 60 / bpm
	const out: RawBeat[] = []
	for (let start = 0.5; start < duration - 0.25; start += period) out.push({start, confidence: 0.9, bpm})
	return out
}

function droneWithPulses(seconds: number, bpm: number, pulses: boolean, sampleRate = 44100): Float32Array {
	const data = new Float32Array(Math.round(seconds * sampleRate))
	for (let i = 0; i < data.length; i++) {
		const t = i / sampleRate
		// Continuous pitched bed: exactly the sort of material that should not
		// manufacture beat events merely because a metrical grid exists.
		data[i] = 0.2 * Math.sin(2 * Math.PI * 220 * t)
	}
	if (!pulses) return data

	const period = 60 / bpm
	for (let beat = 0.5; beat < seconds - 0.25; beat += period) {
		const start = Math.round(beat * sampleRate)
		const length = Math.round(0.09 * sampleRate)
		for (let j = 0; j < length && start + j < data.length; j++) {
			const t = j / sampleRate
			const envelope = Math.exp(-t * 38)
			data[start + j] = (data[start + j] ?? 0) + 0.65 * envelope * Math.sin(2 * Math.PI * 72 * t)
		}
	}
	return data
}

test("salient beat gate suppresses an extrapolated grid through a sustained note", () => {
	const duration = 8
	const timeline = extractFeatureTimeline(droneWithPulses(duration, 120, false), 44100)
	const grid = regularRawBeats(duration, 120)
	const salient = selectSalientBeats(grid, timeline)
	assert.ok(salient.length <= 1, `kept ${salient.length}/${grid.length} beats through a steady drone`)
})

test("salient beat gate retains transient-supported beats over a sustained bed", () => {
	const duration = 8
	const timeline = extractFeatureTimeline(droneWithPulses(duration, 120, true), 44100)
	const grid = regularRawBeats(duration, 120)
	const salient = selectSalientBeats(grid, timeline)
	assert.ok(salient.length >= grid.length * 0.75, `kept only ${salient.length}/${grid.length} supported beats`)
})

function sustainedMovingTone(seconds: number, mode: "vibrato" | "glide", sampleRate = 44100): Float32Array {
	const data = new Float32Array(Math.round(seconds * sampleRate))
	let phase = 0
	for (let i = 0; i < data.length; i++) {
		const t = i / sampleRate
		const frequency = mode === "vibrato" ? 220 * 2 ** ((0.7 * Math.sin(2 * Math.PI * 5 * t)) / 12) : 180 + 80 * (t / seconds)
		phase += (2 * Math.PI * frequency) / sampleRate
		data[i] = 0.2 * Math.sin(phase)
	}
	return data
}

test("salient beat gate does not turn vibrato into repeated attacks", () => {
	const duration = 8
	const timeline = extractFeatureTimeline(sustainedMovingTone(duration, "vibrato"), 44100)
	const grid = regularRawBeats(duration, 120)
	const salient = selectSalientBeats(grid, timeline)
	assert.ok(salient.length <= 1, `kept ${salient.length}/${grid.length} beats through vibrato`)
})

test("salient beat gate does not turn a smooth pitch glide into repeated attacks", () => {
	const duration = 8
	const timeline = extractFeatureTimeline(sustainedMovingTone(duration, "glide"), 44100)
	const grid = regularRawBeats(duration, 120)
	const salient = selectSalientBeats(grid, timeline)
	assert.ok(salient.length <= 1, `kept ${salient.length}/${grid.length} beats through a glide`)
})

import {makeTatums} from "../src/analysis/tatums.js"
import type {DetectedBeat} from "../src/types.js"

function detectedBeats(beats: RawBeat[]): DetectedBeat[] {
	return beats.map((beat, index) => ({...beat, index, perceivedLoudness: 0.5, trueLoudness: -16}))
}

function clearOnsets(timeline: FeatureTimeline, floor = 0): void {
	for (const frame of timeline.frames) {
		frame.onsetStrength = floor
		frame.lowOnsetStrength = floor
	}
}

function addOnset(timeline: FeatureTimeline, time: number, strength = 10): void {
	const index = Math.round((time * timeline.sampleRate - timeline.frameSize / 2) / timeline.hopSize)
	const frame = timeline.frames[index]
	if (frame) {
		frame.onsetStrength = strength
		frame.lowOnsetStrength = strength * 0.8
	}
}

for (const floor of [0, 1e-9, 1]) {
	test(`tatums do not invent subdivisions from a flat onset floor of ${floor}`, () => {
		const {timeline, beats} = fakeBeatTimeline(120, false)
		clearOnsets(timeline, floor)
		const tatums = makeTatums(detectedBeats(beats), timeline)
		assert.deepEqual(tatums.map((tatum) => tatum.start), beats.map((beat) => beat.start))
		assert.ok(tatums.every((tatum) => tatum.confidence === 0.8))
	})
}

for (const subdivision of [2, 3, 4]) {
	test(`tatums retain a supported ${subdivision}-way subdivision`, () => {
		const {timeline, beats} = fakeBeatTimeline(120, false)
		clearOnsets(timeline)
		const expected: number[] = []
		for (let i = 0; i < beats.length - 1; i++) {
			for (let k = 0; k < subdivision; k++) {
				const start = beats[i]!.start + (beats[i + 1]!.start - beats[i]!.start) * k / subdivision
				expected.push(start)
				addOnset(timeline, start)
			}
		}
		expected.push(beats[beats.length - 1]!.start)
		addOnset(timeline, expected[expected.length - 1]!)
		const tatums = makeTatums(detectedBeats(beats), timeline)
		assert.equal(tatums.length, expected.length)
		for (let i = 0; i < expected.length; i++) {
			assert.ok(Math.abs(tatums[i]!.start - expected[i]!) < 1e-8)
			assert.equal(tatums[i]!.index, i)
			assert.ok(tatums[i]!.confidence >= 0 && tatums[i]!.confidence <= 1)
		}
	})
}

test("fast beat attacks cannot support neighbouring tatum subdivisions", () => {
	const {timeline, beats} = fakeBeatTimeline(240, false)
	clearOnsets(timeline)
	for (const beat of beats) addOnset(timeline, beat.start)
	assert.deepEqual(makeTatums(detectedBeats(beats), timeline).map((tatum) => tatum.start), beats.map((beat) => beat.start))
})

function passageTimeline(passages: {bpm: number; halfTime: boolean}[]): {timeline: FeatureTimeline; beats: RawBeat[]; boundaries: number[]} {
	const base = fakeBeatTimeline(160, false).timeline
	const beats: RawBeat[] = []
	const boundaries: number[] = []
	let time = 1
	for (const passage of passages) {
		boundaries.push(time)
		for (let i = 0; i < 48; i++) {
			beats.push({start: time, confidence: 0.8, bpm: passage.bpm})
			time += 60 / passage.bpm
		}
	}
	boundaries.push(time)
	const frames = Array.from({length: Math.ceil((time + 1) * base.sampleRate / base.hopSize)}, (_, i) => ({
		...base.frames[0]!,
		start: i * base.hopSize / base.sampleRate,
		center: (i * base.hopSize + base.frameSize / 2) / base.sampleRate,
		onsetStrength: 0,
		lowOnsetStrength: 0,
	}))
	const timeline = {...base, duration: time + 1, frames}
	for (let i = 0; i < beats.length; i++) {
		const passage = passages[Math.floor(i / 48)]!
		addOnset(timeline, beats[i]!.start, !passage.halfTime || i % 2 === 0 ? 10 : 0.1)
	}
	return {timeline, beats, boundaries}
}

function assertPassageGrids(passages: {bpm: number; halfTime: boolean}[]): void {
	const {timeline, beats} = passageTimeline(passages)
	const resolved = resolveBeatGrid(beats, timeline)
	for (let p = 0; p < passages.length; p++) {
		// Leave the local evidence window around a transition unconstrained.
		const interior = beats.slice(p * 48 + 12, (p + 1) * 48 - 12)
		const kept = resolved.filter((beat) => beat.start >= interior[0]!.start && beat.start <= interior[interior.length - 1]!.start)
		const expectedCount = interior.length / (passages[p]!.halfTime ? 2 : 1)
		assert.equal(kept.length, expectedCount, `passage ${p}: expected ${expectedCount}, got ${kept.length}`)
		const expectedBpm = passages[p]!.bpm / (passages[p]!.halfTime ? 2 : 1)
		for (const beat of kept) assert.ok(Math.abs(beat.bpm - expectedBpm) < 0.01)
	}
	for (let i = 1; i < resolved.length; i++) assert.ok(resolved[i]!.start > resolved[i - 1]!.start)
}

test("half-time correction follows local rhythmic emphasis at a constant raw tempo", () => {
	assertPassageGrids([{bpm: 160, halfTime: true}, {bpm: 160, halfTime: false}, {bpm: 160, halfTime: true}])
})

test("half-time correction does not spill across tempo or tracker-octave changes", () => {
	assertPassageGrids([{bpm: 160, halfTime: true}, {bpm: 80, halfTime: false}, {bpm: 160, halfTime: true}, {bpm: 120, halfTime: false}])
})

test("half-time phase follows a sustained accent change", () => {
	const {timeline, beats} = passageTimeline([{bpm: 160, halfTime: true}, {bpm: 160, halfTime: true}])
	for (let i = 48; i < beats.length; i++) addOnset(timeline, beats[i]!.start, i % 2 === 1 ? 10 : 0.1)
	const resolved = resolveBeatGrid(beats, timeline)
	// Require the new phase within four input beats, including the rest of the track.
	const later = resolved.filter((beat) => beat.start >= beats[52]!.start)
	assert.ok(later.length >= 20)
	for (const beat of later) {
		const index = beats.findIndex((raw) => raw.start === beat.start)
		assert.equal(index % 2, 1, `weak phase retained at input beat ${index}`)
		assert.ok(Math.abs(beat.bpm - 80) < 0.01)
	}
})

for (const missing of [[20], [21], [20, 21], [35, 70]]) {
	test(`missing raw beats (${missing.join(", ")}) preserve phase and tempo`, () => {
		const {timeline, beats} = passageTimeline([{bpm: 160, halfTime: true}, {bpm: 160, halfTime: true}])
		const raw = beats.filter((_, i) => !missing.includes(i))
		const resolved = resolveBeatGrid(raw, timeline)
		const expected = beats.filter((_, i) => i % 2 === 0 && !missing.includes(i))
		assert.deepEqual(resolved.map((beat) => beat.start), expected.map((beat) => beat.start))
		for (const beat of resolved) assert.ok(Math.abs(beat.bpm - 80) < 0.01, `unexpected ${beat.bpm} BPM at ${beat.start}`)
	})
}

test("a real tempo change preserves beats and BPM at the transition itself", () => {
	const {timeline, beats} = passageTimeline([{bpm: 120, halfTime: false}, {bpm: 80, halfTime: false}])
	const resolved = resolveBeatGrid(beats, timeline)
	assert.deepEqual(resolved.map((beat) => beat.start), beats.map((beat) => beat.start))
	for (let i = 0; i < resolved.length; i++) {
		assert.ok(Math.abs(resolved[i]!.bpm - (i < 48 ? 120 : 80)) < 0.01, `incorrect tempo at input beat ${i}`)
	}
})

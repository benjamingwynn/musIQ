// @ts-ignore Node types are intentionally not a package dependency of the browser library
import test from "node:test"
// @ts-ignore Node types are intentionally not a package dependency of the browser library
import assert from "node:assert/strict"
import {hpssMask} from "../src/dsp/hpss.js"
import {extractFeatureTimeline, type FeatureFrame, type FeatureTimeline} from "../src/dsp/features.js"
import {keyEvidence} from "../src/analysis/keys.js"
import {tempoEvidence} from "../src/analysis/tempogram.js"
import {selectSalientBeats} from "../src/analysis/beat-salience.js"
import {recurrenceBoundaryNovelty, recurrenceProfiles} from "../src/analysis/sections.js"

function triad(rootMidi: number, seconds: number, detuneSemitones = 0, sampleRate = 44100): Float32Array {
	const data = new Float32Array(Math.round(seconds * sampleRate))
	const notes = [rootMidi, rootMidi + 4, rootMidi + 7]
	for (let i = 0; i < data.length; i++) {
		for (const midi of notes) {
			const frequency = 440 * 2 ** ((midi + detuneSemitones - 69) / 12)
			data[i] = (data[i] ?? 0) + 0.16 * Math.sin((2 * Math.PI * frequency * i) / sampleRate)
		}
	}
	return data
}

function addClicks(signal: Float32Array, everySeconds: number, sampleRate = 44100): void {
	for (let time = 0.4; time < signal.length / sampleRate; time += everySeconds) {
		const start = Math.round(time * sampleRate)
		for (let j = 0; j < 180 && start + j < signal.length; j++) {
			// Deterministic broadband-ish click, deliberately much brighter than the triad.
			const sign = ((j * 17 + j * j) & 2) === 0 ? 1 : -1
			signal[start + j] = (signal[start + j] ?? 0) + sign * 0.7 * Math.exp(-j / 45)
		}
	}
}

function bestKey(keys: Float32Array): number {
	let best = 0
	for (let i = 1; i < keys.length; i++) if ((keys[i] ?? 0) > (keys[best] ?? 0)) best = i
	return best
}

test("log-band HPSS distinguishes persistent tonal energy from broadband transients", () => {
	const history = Array.from({length: 4}, () => {
		const bands = new Float32Array(24)
		bands[7] = 8
		return bands
	})
	const current = new Float32Array(24).fill(3)
	current[7] = 10
	const mask = hpssMask(current, history)
	assert.ok(mask.harmonic[7]! > mask.harmonic[6]!, `${mask.harmonic[7]} <= ${mask.harmonic[6]}`)
	assert.ok(mask.percussive[6]! > mask.percussive[7]!)
})

test("percussive clicks do not knock harmonic C-major evidence off C major", () => {
	const clean = triad(60, 4)
	const mixed = clean.slice()
	addClicks(mixed, 0.5)
	const cleanKeys = keyEvidence(extractFeatureTimeline(clean, 44100).frames)
	const mixedKeys = keyEvidence(extractFeatureTimeline(mixed, 44100).frames)
	assert.equal(bestKey(cleanKeys), 0)
	assert.equal(bestKey(mixedKeys), 0)
	assert.ok(mixedKeys[0]! >= mixedKeys[1]!, `C=${mixedKeys[0]} C#=${mixedKeys[1]}`)
})

test("spectral peak interpolation keeps a moderately detuned C-major triad tonally coherent", () => {
	const keys = keyEvidence(extractFeatureTimeline(triad(60, 4, 0.42), 44100).frames)
	assert.equal(bestKey(keys), 0)
})

function emptyFrame(index: number, hopSeconds: number): FeatureFrame {
	return {
		start: index * hopSeconds,
		center: index * hopSeconds,
		rms: 0,
		zcr: 0,
		lowEnergy: 0,
		midEnergy: 0,
		highEnergy: 0,
		loudness: 0,
		spectralFlux: 0,
		lowFlux: 0,
		midFlux: 0,
		highFlux: 0,
		onsetStrength: 0,
		lowOnsetStrength: 0,
		chroma: new Float32Array(12),
		bands: new Float32Array(24),
	}
}

test("local tempogram prefers the actual pulse period over its double-time octave", () => {
	const sampleRate = 100
	const hopSize = 1
	const hopSeconds = hopSize / sampleRate
	const frames = Array.from({length: 1200}, (_, i) => emptyFrame(i, hopSeconds))
	const timeline: FeatureTimeline = {sampleRate, hopSize, frameSize: 4, duration: 12, frames}
	const period = Math.round((60 / 80) / hopSeconds)
	for (let i = 40; i < frames.length; i += period) {
		frames[i]!.onsetStrength = 8
		frames[i]!.lowOnsetStrength = 6
	}
	const eighty = tempoEvidence(timeline, 0, frames.length, 80)
	const oneSixty = tempoEvidence(timeline, 0, frames.length, 160)
	assert.ok(eighty > oneSixty * 1.15, `80=${eighty}, 160=${oneSixty}`)
})

test("fast beat salience does not borrow support from a nearby subdivision", () => {
	const sampleRate = 1000
	const hopSize = 10
	const hopSeconds = hopSize / sampleRate
	const makeTimeline = (attackTime: number): FeatureTimeline => {
		const frames = Array.from({length: 200}, (_, i) => emptyFrame(i, hopSeconds))
		const attackIndex = Math.round(attackTime / hopSeconds)
		frames[attackIndex]!.onsetStrength = 8
		return {sampleRate, hopSize, frameSize: 20, duration: 2, frames}
	}
	const beat = {start: 1, confidence: 0.8, bpm: 174}
	assert.equal(selectSalientBeats([beat], makeTimeline(1.05)).length, 0)
	assert.equal(selectSalientBeats([beat], makeTimeline(1.03)).length, 1)
})

test("recurrence fingerprints distinguish repeated A/B form across a boundary", () => {
	const A = new Float32Array([1, 0, 0, 0])
	const B = new Float32Array([0, 1, 0, 0])
	const features = [A, A, B, B, A, A, B, B]
	const profiles = recurrenceProfiles(features, 1)
	const novelty = recurrenceBoundaryNovelty(profiles, 2, 2)
	assert.ok(novelty > 0.5, `novelty=${novelty}`)
})

test("silent structural units are not recurrence matches for arbitrary music", () => {
	const silence = new Float32Array([0, 0, 0, 0])
	const A = new Float32Array([1, 0, 0, 0])
	const profiles = recurrenceProfiles([silence, A, A], 0)
	assert.equal(profiles[0]?.[1], 0)
	assert.equal(profiles[0]?.[2], 0)
	assert.ok((profiles[1]?.[2] ?? 0) > 0.9)
})

test("recurrence analysis is deliberately bounded for very long unit sequences", () => {
	const features = Array.from({length: 901}, () => new Float32Array([1, 0]))
	assert.deepEqual(recurrenceProfiles(features), [])
})

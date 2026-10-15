// @ts-ignore Node types are intentionally not a package dependency of the browser library
import test from "node:test"
// @ts-ignore Node types are intentionally not a package dependency of the browser library
import assert from "node:assert/strict"
import {analyseDecoded} from "../src/analysis/analyse.js"
import {keyEvidence} from "../src/analysis/keys.js"
import {extractFeatureTimeline} from "../src/dsp/features.js"
import {mixForBeatTracking} from "../src/dsp/mix.js"

function sine(frequency: number, seconds: number, sampleRate = 44100): Float32Array {
	const data = new Float32Array(Math.round(seconds * sampleRate))
	for (let i = 0; i < data.length; i++) data[i] = 0.5 * Math.sin((2 * Math.PI * frequency * i) / sampleRate)
	return data
}

function invert(input: Float32Array): Float32Array {
	return Float32Array.from(input, (sample) => -sample)
}

function triad(frequencies: number[], seconds: number, sampleRate = 44100): Float32Array {
	const data = new Float32Array(Math.round(seconds * sampleRate))
	for (let i = 0; i < data.length; i++) {
		for (const frequency of frequencies) data[i] = (data[i] ?? 0) + 0.18 * Math.sin((2 * Math.PI * frequency * i) / sampleRate)
	}
	return data
}

function pulseTrain(seconds: number, bpm: number, sampleRate = 44100): Float32Array {
	const data = new Float32Array(Math.round(seconds * sampleRate))
	for (let start = 0.5; start < seconds; start += 60 / bpm) {
		const offset = Math.round(start * sampleRate)
		for (let j = 0; j < sampleRate * 0.09 && offset + j < data.length; j++) {
			const time = j / sampleRate
			data[offset + j] = 0.8 * Math.exp(-time * 38) * Math.sin(2 * Math.PI * 72 * time)
		}
	}
	return data
}

function meanSquare(input: Float32Array): number {
	let sum = 0
	for (const sample of input) sum += sample * sample
	return input.length ? sum / input.length : 0
}

function assertNear(actual: number, expected: number, tolerance = 1e-6): void {
	assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${expected}, got ${actual}`)
}

function assertArrayNear(actual: ArrayLike<number>, expected: ArrayLike<number>, tolerance = 1e-6): void {
	assert.equal(actual.length, expected.length)
	for (let i = 0; i < actual.length; i++) assertNear(actual[i] ?? 0, expected[i] ?? 0, tolerance)
}

test("one-channel collection preserves the single-channel feature path", () => {
	const signal = sine(440, 1)
	const direct = extractFeatureTimeline(signal, 44100)
	const collection = extractFeatureTimeline([signal], 44100)
	assert.equal(collection.frames.length, direct.frames.length)
	for (let i = 0; i < direct.frames.length; i++) {
		const a = direct.frames[i]!
		const b = collection.frames[i]!
		assertNear(b.rms, a.rms)
		assertNear(b.zcr, a.zcr)
		assertNear(b.spectralFlux, a.spectralFlux)
		assertNear(b.onsetStrength, a.onsetStrength)
		assertArrayNear(b.chroma, a.chroma)
		assertArrayNear(b.bands, a.bands)
	}
})

test("anti-phase stereo cannot cancel spectral, tonal, or onset features", () => {
	const signal = sine(440, 1)
	const mono = extractFeatureTimeline(signal, 44100)
	const stereo = extractFeatureTimeline([signal, invert(signal)], 44100)
	assert.equal(stereo.frames.length, mono.frames.length)
	for (let i = 0; i < mono.frames.length; i++) {
		const a = mono.frames[i]!
		const b = stereo.frames[i]!
		assertNear(b.rms, a.rms)
		assertNear(b.zcr, a.zcr, 1 / 2047)
		assertNear(b.lowEnergy, a.lowEnergy)
		assertNear(b.midEnergy, a.midEnergy)
		assertNear(b.highEnergy, a.highEnergy)
		assertNear(b.spectralFlux, a.spectralFlux)
		assertNear(b.onsetStrength, a.onsetStrength)
		assertArrayNear(b.chroma, a.chroma)
		assertArrayNear(b.bands, a.bands)
	}
})

test("beat-tracking mix falls back to a real channel under severe phase cancellation", () => {
	const signal = sine(72, 1)
	const mixed = mixForBeatTracking([signal, invert(signal)])
	assert.ok(meanSquare(mixed) > meanSquare(signal) * 0.99)
})

test("beat-tracking mix keeps the ordinary arithmetic downmix when cancellation is not severe", () => {
	const left = sine(220, 1)
	const right = sine(330, 1)
	const mixed = mixForBeatTracking([left, right])
	for (let i = 0; i < 100; i++) assertNear(mixed[i] ?? 0, ((left[i] ?? 0) + (right[i] ?? 0)) / 2)
})

test("anti-phase stereo preserves section key evidence", () => {
	const cMajor = triad([261.625565, 329.627557, 391.995436], 2)
	const mono = keyEvidence(extractFeatureTimeline(cMajor, 44100).frames)
	const stereo = keyEvidence(extractFeatureTimeline([cMajor, invert(cMajor)], 44100).frames)
	assertArrayNear(stereo, mono, 1e-6)
	let best = 0
	for (let i = 1; i < stereo.length; i++) if ((stereo[i] ?? 0) > (stereo[best] ?? 0)) best = i
	assert.equal(best, 0)
})

test("complete analysis does not collapse an anti-phase stereo pulse train to silence", async () => {
	const sampleRate = 44100
	const duration = 12
	const signal = pulseTrain(duration, 120, sampleRate)
	const result = await analyseDecoded({channels: [signal, invert(signal)], sampleRate, duration})
	assert.ok(result.beats.length >= 6, `only ${result.beats.length} beats from an anti-phase pulse train`)
	for (const beat of result.beats) {
		const nearestPulse = Math.round(beat.start * 2) / 2
		assert.ok(Math.abs(beat.start - nearestPulse) < 0.08, `beat at ${beat.start} misses the pulse train`)
	}
	assert.equal(result.segments.length, duration * 10)
	assert.ok(result.segments.some((segment) => Math.max(...segment.spectrum) > 0.5))
})

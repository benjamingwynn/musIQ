// @ts-ignore Node types are intentionally not a package dependency of the browser library
import test from "node:test"
// @ts-ignore Node types are intentionally not a package dependency of the browser library
import assert from "node:assert/strict"
import {analyseDecoded} from "../src/analysis/analyse.js"

test("decoded pulse audio passes through aubio and the complete analysis pipeline", async () => {
	const sampleRate = 44100
	const duration = 20
	const channel = new Float32Array(sampleRate * duration)
	for (let start = 0.5; start < duration; start += 0.5) {
		const offset = Math.round(start * sampleRate)
		for (let j = 0; j < sampleRate * 0.09; j++) {
			const time = j / sampleRate
			channel[offset + j] = 0.8 * Math.exp(-time * 38) * Math.sin(2 * Math.PI * 72 * time)
		}
	}
	const result = await analyseDecoded({channels: [channel], sampleRate, duration})
	// Smoke coverage for the real tracker path, not a beat-recall benchmark:
	// aubio does not track every pulse of this minimal synthetic bass signal.
	assert.ok(result.beats.length >= 10, `only ${result.beats.length} beats from a regular pulse train`)
	for (const beat of result.beats) {
		const nearestPulse = Math.round(beat.start * 2) / 2
		assert.ok(Math.abs(beat.start - nearestPulse) < 0.08, `beat at ${beat.start} misses the pulse train`)
	}
	assert.equal(result.segments.length, duration * 10)
	assert.ok(result.segments.some((segment) => Math.max(...segment.spectrum) > 0.5))
	for (const segment of result.segments) {
		assert.equal(segment.spectrum.length, 24)
		for (const value of segment.spectrum) assert.ok(Number.isFinite(value) && value >= 0 && value <= 1)
	}
	assert.equal(result.sections[0]?.start, 0)
	for (const events of [result.beats, result.tatums, result.sections]) {
		for (let i = 0; i < events.length; i++) {
			const event = events[i]!
			assert.equal(event.index, i)
			assert.ok(event.start >= 0 && event.start < duration)
			assert.ok(event.confidence >= 0 && event.confidence <= 1)
			if (i > 0) assert.ok(event.start > events[i - 1]!.start)
		}
	}
})

test("silent decoded audio produces no rhythmic events", async () => {
	const sampleRate = 44100
	const duration = 8
	const result = await analyseDecoded({channels: [new Float32Array(sampleRate * duration)], sampleRate, duration})
	assert.deepEqual(result.beats, [])
	assert.deepEqual(result.tatums, [])
	assert.equal(result.sections.length, 1)
	for (const segment of result.segments) {
		assert.equal(segment.spectrum.length, 24)
		assert.deepEqual(Array.from(segment.spectrum), Array(24).fill(0))
	}
})

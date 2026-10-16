// @ts-ignore Node types are intentionally not a package dependency of the browser library
import test from "node:test"
// @ts-ignore Node types are intentionally not a package dependency of the browser library
import assert from "node:assert/strict"
import {extractFeatureTimeline} from "../src/dsp/features.js"
import {extractLoudnessTimeline} from "../src/dsp/loudness.js"
import {makeSegments} from "../src/analysis/segments.js"

function sine(frequency: number, seconds: number, sampleRate = 44100): Float32Array {
	const data = new Float32Array(Math.round(seconds * sampleRate))
	for (let i = 0; i < data.length; i++) data[i] = 0.5 * Math.sin((2 * Math.PI * frequency * i) / sampleRate)
	return data
}

test("segments expose normalized 12-bin chroma", () => {
	const sampleRate = 44100
	const audio = sine(440, 2, sampleRate)
	const timeline = extractFeatureTimeline(audio, sampleRate)
	const loudness = extractLoudnessTimeline([audio], sampleRate, 2)
	const segments = makeSegments(timeline, loudness)

	assert.ok(segments.length > 0)
	for (const segment of segments) {
		assert.equal(segment.chroma.length, 12)
		for (const value of segment.chroma) assert.ok(Number.isFinite(value) && value >= 0 && value <= 1)
		const sum = Array.from(segment.chroma).reduce((a, b) => a + b, 0)
		assert.ok(sum === 0 || Math.abs(sum - 1) < 1e-5, `chroma sum=${sum}`)
	}

	const average = new Float64Array(12)
	for (const segment of segments) for (let i = 0; i < 12; i++) average[i] += segment.chroma[i] ?? 0
	let strongest = 0
	for (let i = 1; i < average.length; i++) if (average[i]! > average[strongest]!) strongest = i
	assert.equal(strongest, 9) // A
})

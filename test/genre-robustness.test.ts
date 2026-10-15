// @ts-ignore Node types are intentionally not a package dependency of the browser library
import test from "node:test"
// @ts-ignore Node types are intentionally not a package dependency of the browser library
import assert from "node:assert/strict"
import {resolveBeatGrid} from "../src/analysis/beat-grid.js"
import {detectSectionStarts} from "../src/analysis/sections.js"
import type {RawBeat} from "../src/analysis/beat-grid.js"
import type {FeatureFrame, FeatureTimeline} from "../src/dsp/features.js"

function baseFrame(start: number, center: number, bands = new Float32Array(24)): FeatureFrame {
	return {
		start,
		center,
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
		bands,
	}
}

test("section novelty sees changes confined to upper spectral bands", () => {
	const frames: FeatureFrame[] = []
	for (let i = 0; i < 20; i++) {
		const bands = new Float32Array(24)
		bands[i < 10 ? 12 : 21] = 1
		frames.push(baseFrame(i, i + 0.5, bands))
	}
	const timeline: FeatureTimeline = {sampleRate: 1, duration: 20, frameSize: 1, hopSize: 1, frames}
	const sections = detectSectionStarts(timeline, [])
	assert.ok(sections.some((section) => Math.abs(section.start - 10) < 1.1))
})

test("half-time correction keeps a fast grid when alternating beats remain acoustically supported", () => {
	const sampleRate = 44100
	const hopSize = 512
	const frameSize = 2048
	const duration = 16
	const bpm = 170
	const frames = Array.from({length: Math.ceil((duration * sampleRate) / hopSize)}, (_, i) =>
		baseFrame((i * hopSize) / sampleRate, (i * hopSize + frameSize / 2) / sampleRate)
	)
	const beats: RawBeat[] = []
	for (let start = 1, index = 0; start < duration - 1; start += 60 / bpm, index++) {
		beats.push({start, confidence: 0.8, bpm})
		const target = frames.reduce((best, frame) => (Math.abs(frame.center - start) < Math.abs(best.center - start) ? frame : best), frames[0]!)
		const strength = index % 2 === 0 ? 10 : 1.5
		target.onsetStrength = strength
		target.lowOnsetStrength = strength * 0.8
	}
	const timeline: FeatureTimeline = {sampleRate, duration, frameSize, hopSize, frames}
	const resolved = resolveBeatGrid(beats, timeline)
	assert.equal(resolved.length, beats.length)
	for (const beat of resolved) assert.ok(Math.abs(beat.bpm - bpm) < 0.01)
})

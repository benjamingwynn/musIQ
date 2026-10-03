import {hann, powerSpectrum} from "./fft.js"
import {clamp} from "../math.js"

export type FeatureFrame = {
	start: number
	center: number
	rms: number
	zcr: number
	lowEnergy: number
	midEnergy: number
	highEnergy: number
	loudness: number
	spectralFlux: number
	lowFlux: number
	midFlux: number
	highFlux: number
	/**
	 * SuperFlux-inspired onset evidence. Unlike ordinary spectral flux this
	 * tolerates small pitch trajectories, so vibrato / drifting sustained notes
	 * do not look like a sequence of fresh attacks.
	 */
	onsetStrength: number
	/** Low-frequency component of onsetStrength (< 250 Hz). */
	lowOnsetStrength: number
	chroma: Float32Array
	bands: Float32Array
}

export type FeatureTimeline = {
	sampleRate: number
	duration: number
	frameSize: number
	hopSize: number
	frames: FeatureFrame[]
}

export type ExtractFeatureOptions = {
	frameSize?: number
	hopSize?: number
	bandCount?: number
}

function aWeightingDb(f: number): number {
	if (f <= 0) return -100
	const f2 = f * f
	const ra = (12200 ** 2 * f2 * f2) / ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12200 ** 2))
	return 20 * Math.log10(Math.max(ra, 1e-12)) + 2
}

function hzToChroma(frequency: number): number | null {
	if (frequency < 40 || frequency > 5000) return null
	const midi = 69 + 12 * Math.log2(frequency / 440)
	const rounded = Math.round(midi)
	return ((rounded % 12) + 12) % 12
}

function logBandIndex(frequency: number, count: number): number {
	const minHz = 40
	const maxHz = 16000
	if (frequency <= minHz) return 0
	if (frequency >= maxHz) return count - 1
	const position = Math.log(frequency / minHz) / Math.log(maxHz / minHz)
	return Math.min(count - 1, Math.max(0, Math.floor(position * count)))
}

const ONSET_MIN_HZ = 30
const ONSET_MAX_HZ = 16000
const ONSET_BANDS_PER_OCTAVE = 24 // quarter-tone spacing, as in SuperFlux
const ONSET_BAND_COUNT = Math.ceil(Math.log2(ONSET_MAX_HZ / ONSET_MIN_HZ) * ONSET_BANDS_PER_OCTAVE) + 1

function addOnsetMagnitude(bands: Float32Array, frequency: number, magnitude: number): void {
	if (frequency < ONSET_MIN_HZ || frequency > ONSET_MAX_HZ || magnitude <= 0) return

	// Interpolate each FFT bin between neighbouring quarter-tone centres instead
	// of hard-bucketing it. Hard bucket edges turn a slowly moving harmonic into
	// an artificial disappearance/appearance pair -- exactly the false-onset
	// failure this representation exists to avoid. This is a cheap triangular
	// log-frequency filterbank: wider high-frequency bands naturally collect
	// more linear FFT bins, matching the unnormalised filterbank used by
	// SuperFlux rather than equalising every band's area.
	const position = Math.log2(frequency / ONSET_MIN_HZ) * ONSET_BANDS_PER_OCTAVE - 0.5
	const lower = Math.floor(position)
	const fraction = position - lower
	if (lower >= 0 && lower < bands.length) bands[lower] = (bands[lower] ?? 0) + magnitude * (1 - fraction)
	const upper = lower + 1
	if (upper >= 0 && upper < bands.length) bands[upper] = (bands[upper] ?? 0) + magnitude * fraction
}

function onsetBandCenter(index: number): number {
	return ONSET_MIN_HZ * 2 ** ((index + 0.5) / ONSET_BANDS_PER_OCTAVE)
}

/**
 * SuperFlux-style positive difference against a maximum-filtered earlier
 * log-frequency spectrum. The +/- one-band max follows local pitch motion
 * instead of interpreting vibrato as repeated note attacks.
 */
function trajectoryFlux(current: Float32Array, previous: Float32Array): {full: number; low: number} {
	let full = 0
	let low = 0
	for (let i = 0; i < current.length; i++) {
		let previousMax = previous[i] ?? 0
		if (i > 0) previousMax = Math.max(previousMax, previous[i - 1] ?? 0)
		if (i + 1 < previous.length) previousMax = Math.max(previousMax, previous[i + 1] ?? 0)
		const diff = (current[i] ?? 0) - previousMax
		if (diff <= 0) continue
		full += diff
		if (onsetBandCenter(i) < 250) low += diff
	}

	return {full, low}
}

export function extractFeatureTimeline(mono: Float32Array, sampleRate: number, options: ExtractFeatureOptions = {}): FeatureTimeline {
	const frameSize = options.frameSize ?? 2048
	const hopSize = options.hopSize ?? 512
	const bandCount = options.bandCount ?? 8
	if ((frameSize & (frameSize - 1)) !== 0) throw new Error("frameSize must be a power of two")
	if (hopSize <= 0) throw new Error("hopSize must be positive")

	const window = hann(frameSize)
	const frames: FeatureFrame[] = []
	let previousSpectrum: Float32Array | null = null
	// Retain the preceding log-frequency spectra for the onset comparison.
	const onsetHistory: Float32Array[] = []
	const duration = mono.length / sampleRate

	for (let offset = 0; offset < mono.length; offset += hopSize) {
		const samples = new Float32Array(frameSize)
		samples.set(mono.subarray(offset, Math.min(offset + frameSize, mono.length)))

		let sumSquares = 0
		let crossings = 0
		for (let i = 0; i < frameSize; i++) {
			const x = samples[i] ?? 0
			sumSquares += x * x
			if (i > 0 && x >= 0 !== (samples[i - 1] ?? 0) >= 0) crossings++
		}
		const rms = Math.sqrt(sumSquares / frameSize)
		const zcr = crossings / Math.max(1, frameSize - 1)
		const spectrum = powerSpectrum(samples, frameSize, window)

		let totalPower = 0
		let low = 0
		let mid = 0
		let high = 0
		let weightedPower = 0
		let flux = 0
		let lowFlux = 0
		let midFlux = 0
		let highFlux = 0
		const chroma = new Float32Array(12)
		const bands = new Float32Array(bandCount)
		const onsetBands = new Float32Array(ONSET_BAND_COUNT)

		for (let bin = 1; bin < spectrum.length; bin++) {
			const power = spectrum[bin] ?? 0
			const frequency = (bin * sampleRate) / frameSize
			totalPower += power
			if (frequency < 250) low += power
			else if (frequency < 2000) mid += power
			else high += power

			const weight = 10 ** (aWeightingDb(frequency) / 10)
			weightedPower += power * weight

			const chromaIndex = hzToChroma(frequency)
			if (chromaIndex !== null) chroma[chromaIndex] = (chroma[chromaIndex] ?? 0) + power
			{
				const band = logBandIndex(frequency, bandCount)
				bands[band] = (bands[band] ?? 0) + power
			}

			// Work in magnitude rather than power; logarithmic compression is done
			// after summing into the quarter-tone filterbank.
			addOnsetMagnitude(onsetBands, frequency, Math.sqrt(Math.max(0, power)))

			if (previousSpectrum) {
				const diff = power - (previousSpectrum[bin] ?? 0)
				if (diff > 0) {
					flux += diff
					if (frequency < 250) lowFlux += diff
					else if (frequency < 2000) midFlux += diff
					else highFlux += diff
				}
			}
		}

		const invTotal = totalPower > 0 ? 1 / totalPower : 0
		for (let i = 0; i < 12; i++) chroma[i] = (chroma[i] ?? 0) * invTotal
		for (let i = 0; i < bandCount; i++) bands[i] = Math.log1p((bands[i] ?? 0) * 1e6)
		// Log compression makes the onset detector care about relative spectral
		// change instead of letting one huge partial dominate the whole function.
		for (let i = 0; i < onsetBands.length; i++) onsetBands[i] = Math.log1p((onsetBands[i] ?? 0) * 2048)

		// SuperFlux's common setup compares spectra roughly 10 ms apart. With our
		// 512-sample hop that is one frame at 44.1/48 kHz; using a fixed two-frame
		// lag (~21-23 ms) lets a sustained vibrato/glissando travel too far for the
		// local maximum filter and turns pitch motion into fake attacks.
		const targetLagFrames = Math.max(1, Math.round((0.01 * sampleRate) / hopSize))
		const comparison = onsetHistory.length >= targetLagFrames ? onsetHistory[onsetHistory.length - targetLagFrames] : null
		const robustFlux = comparison ? trajectoryFlux(onsetBands, comparison) : {full: 0, low: 0}
		onsetHistory.push(onsetBands)
		if (onsetHistory.length > Math.max(3, targetLagFrames + 1)) onsetHistory.shift()

		const weightedRms = Math.sqrt(Math.max(weightedPower, 1e-20))
		const loudnessDb = 20 * Math.log10(weightedRms)
		// Kept only as a structural feature for the section baseline. Public
		// perceived/true loudness is computed separately in dsp/loudness.ts.
		const loudness = clamp((loudnessDb + 70) / 64)

		frames.push({
			start: offset / sampleRate,
			center: (offset + frameSize / 2) / sampleRate,
			rms,
			zcr,
			lowEnergy: low * invTotal,
			midEnergy: mid * invTotal,
			highEnergy: high * invTotal,
			loudness,
			spectralFlux: Math.sqrt(flux),
			lowFlux: Math.sqrt(lowFlux),
			midFlux: Math.sqrt(midFlux),
			highFlux: Math.sqrt(highFlux),
			onsetStrength: robustFlux.full,
			lowOnsetStrength: robustFlux.low,
			chroma,
			bands,
		})
		previousSpectrum = spectrum
	}

	return {sampleRate, duration, frameSize, hopSize, frames}
}

export function frameRange(timeline: FeatureTimeline, start: number, end: number): FeatureFrame[] {
	return timeline.frames.filter((frame) => frame.center >= start && frame.center < end)
}

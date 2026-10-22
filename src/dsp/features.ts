import {hann, powerSpectrum} from "./fft.js"
import {hpssMask} from "./hpss.js"
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
	/** SuperFlux-inspired onset evidence. */
	onsetStrength: number
	/** Low-frequency component of onsetStrength (< 250 Hz). */
	lowOnsetStrength: number
	/** Harmonic-weighted pitch-class energy from interpolated spectral peaks. */
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

export const SPECTRUM_BAND_COUNT = 24

function aWeightingDb(f: number): number {
	if (f <= 0) return -100
	const f2 = f * f
	const ra = (12200 ** 2 * f2 * f2) / ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12200 ** 2))
	return 20 * Math.log10(Math.max(ra, 1e-12)) + 2
}

function addPitchClass(chroma: Float32Array, frequency: number, power: number): void {
	if (frequency < 40 || frequency > 5000 || power <= 0) return
	const midi = 69 + 12 * Math.log2(frequency / 440)
	const lower = Math.floor(midi)
	const fraction = midi - lower
	const lowerPc = ((lower % 12) + 12) % 12
	const upperPc = (((lower + 1) % 12) + 12) % 12
	chroma[lowerPc] = (chroma[lowerPc] ?? 0) + power * (1 - fraction)
	chroma[upperPc] = (chroma[upperPc] ?? 0) + power * fraction
}

/**
 * Refine a local FFT maximum to sub-bin precision with a parabola in log power.
 * This is far cheaper than a separate CQT, but avoids letting the coarse linear
 * FFT grid decide the apparent pitch of a slightly detuned musical partial.
 */
function interpolatedPeakFrequency(spectrum: Float32Array, bin: number, sampleRate: number, frameSize: number): number {
	const left = Math.log(Math.max(1e-20, spectrum[bin - 1] ?? 0))
	const center = Math.log(Math.max(1e-20, spectrum[bin] ?? 0))
	const right = Math.log(Math.max(1e-20, spectrum[bin + 1] ?? 0))
	const denominator = left - 2 * center + right
	const offset = Math.abs(denominator) > 1e-12 ? clamp(0.5 * (left - right) / denominator, -0.5, 0.5) : 0
	return ((bin + offset) * sampleRate) / frameSize
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
const ONSET_BANDS_PER_OCTAVE = 24
const ONSET_BAND_COUNT = Math.ceil(Math.log2(ONSET_MAX_HZ / ONSET_MIN_HZ) * ONSET_BANDS_PER_OCTAVE) + 1

function addOnsetMagnitude(bands: Float32Array, frequency: number, magnitude: number): void {
	if (frequency < ONSET_MIN_HZ || frequency > ONSET_MAX_HZ || magnitude <= 0) return
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

function channelsOf(input: Float32Array | ReadonlyArray<Float32Array>): ReadonlyArray<Float32Array> {
	return input instanceof Float32Array ? [input] : input
}

function sampleLength(channels: ReadonlyArray<Float32Array>): number {
	let length = 0
	for (const channel of channels) length = Math.max(length, channel.length)
	return length
}

/** Phase-safe low-level feature extraction for mono or multichannel audio. */
export function extractFeatureTimeline(input: Float32Array | ReadonlyArray<Float32Array>, sampleRate: number, options: ExtractFeatureOptions = {}): FeatureTimeline {
	const channels = channelsOf(input)
	const frameSize = options.frameSize ?? 2048
	const hopSize = options.hopSize ?? 512
	const bandCount = options.bandCount ?? SPECTRUM_BAND_COUNT
	if ((frameSize & (frameSize - 1)) !== 0) throw new Error("frameSize must be a power of two")
	if (hopSize <= 0) throw new Error("hopSize must be positive")

	const window = hann(frameSize)
	const frames: FeatureFrame[] = []
	let previousSpectrum: Float32Array | null = null
	const onsetHistory: Float32Array[] = []
	const hpssHistory: Float32Array[] = []
	const length = sampleLength(channels)
	const duration = length / sampleRate
	const channelCount = channels.length

	for (let offset = 0; offset < length; offset += hopSize) {
		const spectrum = new Float32Array(frameSize >> 1)
		let sumSquares = 0
		let crossings = 0
		for (const channel of channels) {
			const samples = new Float32Array(frameSize)
			samples.set(channel.subarray(offset, Math.min(offset + frameSize, channel.length)))
			for (let i = 0; i < frameSize; i++) {
				const x = samples[i] ?? 0
				sumSquares += x * x
				if (i > 0 && x >= 0 !== (samples[i - 1] ?? 0) >= 0) crossings++
			}
			const channelSpectrum = powerSpectrum(samples, frameSize, window)
			for (let bin = 0; bin < spectrum.length; bin++) spectrum[bin] = (spectrum[bin] ?? 0) + (channelSpectrum[bin] ?? 0)
		}
		const invChannels = channelCount > 0 ? 1 / channelCount : 0
		for (let bin = 0; bin < spectrum.length; bin++) spectrum[bin] = (spectrum[bin] ?? 0) * invChannels
		const rms = Math.sqrt((sumSquares * invChannels) / frameSize)
		const zcr = (crossings * invChannels) / Math.max(1, frameSize - 1)

		// HPSS is deliberately restricted to tonal evidence. Beat/onset features
		// stay on the raw spectrum so time-varying masks cannot manufacture attacks.
		const rawBands = new Float32Array(bandCount)
		for (let bin = 1; bin < spectrum.length; bin++) {
			const frequency = (bin * sampleRate) / frameSize
			const power = spectrum[bin] ?? 0
			// Interpolate between log-band centres. Narrow bass bands can contain
			// no FFT-bin centres at 2048 samples (e.g. band 2 at 44.1 kHz),
			// so hard-bucketing would otherwise leave them permanently empty.
			const position = clamp((Math.log(frequency / 40) / Math.log(16000 / 40)) * bandCount - 0.5, 0, bandCount - 1)
			const lower = Math.floor(position)
			const fraction = position - lower
			rawBands[lower] = (rawBands[lower] ?? 0) + power * (1 - fraction)
			if (lower + 1 < bandCount) rawBands[lower + 1] = (rawBands[lower + 1] ?? 0) + power * fraction
		}
		const masks = hpssMask(rawBands, hpssHistory)
		hpssHistory.push(rawBands)
		if (hpssHistory.length > 8) hpssHistory.shift()

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
		const onsetBands = new Float32Array(ONSET_BAND_COUNT)

		for (let bin = 1; bin < spectrum.length; bin++) {
			const power = spectrum[bin] ?? 0
			const frequency = (bin * sampleRate) / frameSize

			totalPower += power
			if (frequency < 250) low += power
			else if (frequency < 2000) mid += power
			else high += power
			weightedPower += power * 10 ** (aWeightingDb(frequency) / 10)
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

		// Chroma is intentionally peak-based. Summing every linear FFT bin lets
		// spectral leakage and the ~21.5 Hz bin spacing at 44.1 kHz bias a detuned
		// note toward the wrong pitch class. Local peak interpolation recovers the
		// actual partial frequency cheaply and is much closer to how HPCP features
		// are normally built.
		const chromaFloor = totalPower * 1e-7
		for (let bin = 2; bin + 2 < spectrum.length; bin++) {
			const power = spectrum[bin] ?? 0
			if (power <= chromaFloor || power < (spectrum[bin - 1] ?? 0) || power <= (spectrum[bin + 1] ?? 0)) continue
			const frequency = interpolatedPeakFrequency(spectrum, bin, sampleRate, frameSize)
			if (frequency < 40 || frequency > 5000) continue
			const band = logBandIndex(frequency, bandCount)
			const harmonicWeight = 0.12 + 0.88 * (masks.harmonic[band] ?? 0.5)
			const localPower = (spectrum[bin - 1] ?? 0) + power + (spectrum[bin + 1] ?? 0)
			addPitchClass(chroma, frequency, localPower * harmonicWeight)
		}

		let chromaTotal = 0
		for (const value of chroma) chromaTotal += value
		if (chromaTotal > 0) for (let i = 0; i < chroma.length; i++) chroma[i] = (chroma[i] ?? 0) / chromaTotal
		const bands = rawBands.slice()
		for (let i = 0; i < bands.length; i++) bands[i] = Math.log1p((bands[i] ?? 0) * 1e6)
		for (let i = 0; i < onsetBands.length; i++) onsetBands[i] = Math.log1p((onsetBands[i] ?? 0) * 2048)
		const targetLagFrames = Math.max(1, Math.round((0.01 * sampleRate) / hopSize))
		const comparison = onsetHistory.length >= targetLagFrames ? onsetHistory[onsetHistory.length - targetLagFrames] : null
		const robustFlux = comparison ? trajectoryFlux(onsetBands, comparison) : {full: 0, low: 0}
		onsetHistory.push(onsetBands)
		if (onsetHistory.length > Math.max(3, targetLagFrames + 1)) onsetHistory.shift()

		const invTotal = totalPower > 0 ? 1 / totalPower : 0
		const loudnessDb = 20 * Math.log10(Math.sqrt(Math.max(weightedPower, 1e-20)))
		const loudness = clamp((loudnessDb + 70) / 64)
		frames.push({start: offset / sampleRate, center: (offset + frameSize / 2) / sampleRate, rms, zcr, lowEnergy: low * invTotal, midEnergy: mid * invTotal, highEnergy: high * invTotal, loudness, spectralFlux: Math.sqrt(flux), lowFlux: Math.sqrt(lowFlux), midFlux: Math.sqrt(midFlux), highFlux: Math.sqrt(highFlux), onsetStrength: robustFlux.full, lowOnsetStrength: robustFlux.low, chroma, bands})
		previousSpectrum = spectrum
	}

	return {sampleRate, duration, frameSize, hopSize, frames}
}

export function frameRange(timeline: FeatureTimeline, start: number, end: number): FeatureFrame[] {
	return timeline.frames.filter((frame) => frame.center >= start && frame.center < end)
}

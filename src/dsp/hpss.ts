import {clamp} from "../math.js"

const EPS = 1e-12

function medianSmall(values: number[]): number {
	if (!values.length) return 0
	values.sort((a, b) => a - b)
	const mid = values.length >> 1
	return values.length % 2 ? values[mid] ?? 0 : ((values[mid - 1] ?? 0) + (values[mid] ?? 0)) / 2
}

export type HpssMask = {
	harmonic: Float32Array
	percussive: Float32Array
}

/**
 * Lightweight HPSS masks on log-frequency bands.
 *
 * Fitzgerald-style HPSS relies on harmonic energy persisting through time while
 * percussive energy spreads across neighbouring frequencies. Running the median
 * filters on the 24-band analysis representation keeps the browser cost bounded
 * while still giving chroma and onset extraction separate harmonic/percussive
 * evidence.
 */
export function hpssMask(current: Float32Array, history: ReadonlyArray<Float32Array>, timeRadius = 4, frequencyRadius = 2): HpssMask {
	const harmonic = new Float32Array(current.length)
	const percussive = new Float32Array(current.length)
	for (let band = 0; band < current.length; band++) {
		const timeValues: number[] = []
		const firstHistory = Math.max(0, history.length - timeRadius)
		for (let i = firstHistory; i < history.length; i++) timeValues.push(Math.max(0, history[i]?.[band] ?? 0))
		timeValues.push(Math.max(0, current[band] ?? 0))
		const frequencyValues: number[] = []
		for (let j = Math.max(0, band - frequencyRadius); j <= Math.min(current.length - 1, band + frequencyRadius); j++) frequencyValues.push(Math.max(0, current[j] ?? 0))
		const h = medianSmall(timeValues)
		const p = medianSmall(frequencyValues)
		const h2 = h * h
		const p2 = p * p
		const total = h2 + p2
		const hMask = total > EPS ? clamp(h2 / total) : 0.5
		harmonic[band] = hMask
		percussive[band] = 1 - hMask
	}
	return {harmonic, percussive}
}

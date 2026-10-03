const TWO_PI = Math.PI * 2

export function hann(size: number): Float32Array {
	const out = new Float32Array(size)
	if (size <= 1) return out.fill(1)
	for (let i = 0; i < size; i++) out[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / (size - 1))
	return out
}

/** In-place radix-2 FFT. */
export function fft(real: Float64Array, imag: Float64Array): void {
	const n = real.length
	if (n !== imag.length || n === 0 || (n & (n - 1)) !== 0) throw new Error("FFT length must be a non-zero power of two")

	for (let i = 1, j = 0; i < n; i++) {
		let bit = n >> 1
		for (; j & bit; bit >>= 1) j ^= bit
		j ^= bit
		if (i < j) {
			;[real[i], real[j]] = [real[j] ?? 0, real[i] ?? 0]
			;[imag[i], imag[j]] = [imag[j] ?? 0, imag[i] ?? 0]
		}
	}

	for (let len = 2; len <= n; len <<= 1) {
		const angle = -TWO_PI / len
		const wlenCos = Math.cos(angle)
		const wlenSin = Math.sin(angle)
		for (let i = 0; i < n; i += len) {
			let wr = 1
			let wi = 0
			const half = len >> 1
			for (let j = 0; j < half; j++) {
				const uR = real[i + j] ?? 0
				const uI = imag[i + j] ?? 0
				const vR0 = real[i + j + half] ?? 0
				const vI0 = imag[i + j + half] ?? 0
				const vR = vR0 * wr - vI0 * wi
				const vI = vR0 * wi + vI0 * wr
				real[i + j] = uR + vR
				imag[i + j] = uI + vI
				real[i + j + half] = uR - vR
				imag[i + j + half] = uI - vI
				const nextWr = wr * wlenCos - wi * wlenSin
				wi = wr * wlenSin + wi * wlenCos
				wr = nextWr
			}
		}
	}
}

export function powerSpectrum(frame: Float32Array, fftSize: number, window: Float32Array): Float32Array {
	const real = new Float64Array(fftSize)
	const imag = new Float64Array(fftSize)
	const n = Math.min(frame.length, fftSize, window.length)
	for (let i = 0; i < n; i++) real[i] = (frame[i] ?? 0) * (window[i] ?? 1)
	fft(real, imag)
	const bins = fftSize >> 1
	const out = new Float32Array(bins)
	const scale = 1 / (fftSize * fftSize)
	for (let i = 0; i < bins; i++) {
		const r = real[i] ?? 0
		const im = imag[i] ?? 0
		out[i] = (r * r + im * im) * scale
	}
	return out
}

const CANCELLATION_ENERGY_RATIO = 0.125

function meanSquare(input: Float32Array, length = input.length): number {
	if (length <= 0) return 0
	let sum = 0
	for (let i = 0; i < input.length; i++) {
		const sample = input[i] ?? 0
		sum += sample * sample
	}
	return sum / length
}

/**
 * Produce the mono waveform required by aubio without letting a pathological
 * stereo downmix erase the signal. Ordinary material keeps the arithmetic
 * downmix. If that mix has less than one eighth of the mean per-channel energy
 * (about 9 dB of cancellation), use the strongest channel instead.
 *
 * Spectral features do not use this waveform: they pool channel powers directly
 * in features.ts. This fallback is only for algorithms that require a waveform.
 */
export function mixForBeatTracking(channels: ReadonlyArray<Float32Array>): Float32Array {
	if (channels.length === 0) return new Float32Array()
	if (channels.length === 1) return channels[0]?.slice() ?? new Float32Array()

	let length = 0
	for (const channel of channels) length = Math.max(length, channel.length)
	const mixed = new Float32Array(length)
	const gain = 1 / channels.length
	let strongest: Float32Array | undefined
	let strongestEnergy = -Infinity
	let channelEnergyTotal = 0

	for (const channel of channels) {
		const energy = meanSquare(channel, length)
		channelEnergyTotal += energy
		if (energy > strongestEnergy) {
			strongestEnergy = energy
			strongest = channel
		}
		for (let i = 0; i < channel.length; i++) mixed[i] = (mixed[i] ?? 0) + (channel[i] ?? 0) * gain
	}

	const averageChannelEnergy = channelEnergyTotal / channels.length
	const mixedEnergy = meanSquare(mixed, length)
	if (averageChannelEnergy > 0 && mixedEnergy < averageChannelEnergy * CANCELLATION_ENERGY_RATIO && strongest) {
		const fallback = new Float32Array(length)
		fallback.set(strongest.subarray(0, length))
		return fallback
	}
	return mixed
}

export type DecodedAudio = {
	channels: Float32Array[]
	sampleRate: number
	duration: number
}

/**
 * Browser media decoding has to happen through Web Audio for the formats musIQ accepts.
 * Keep the expensive DSP out of this function: we only copy each decoded channel into a
 * transferable Float32Array, then the analysis worker owns mixing + feature extraction.
 */
export async function decodeAudio(song: ArrayBuffer): Promise<DecodedAudio> {
	const Context = globalThis.AudioContext ?? (globalThis as typeof globalThis & {webkitAudioContext?: typeof AudioContext}).webkitAudioContext
	if (!Context) throw new Error("musIQ requires Web Audio's AudioContext")
	const context = new Context()
	try {
		const audio = await context.decodeAudioData(song.slice(0))
		const channels: Float32Array[] = []
		for (let channel = 0; channel < audio.numberOfChannels; channel++) {
			// getChannelData() is owned by the AudioBuffer and cannot be safely detached.
			// slice() is a native copy, and the resulting ArrayBuffer can be transferred to
			// the worker without another copy.
			channels.push(audio.getChannelData(channel).slice())
		}
		return {channels, sampleRate: audio.sampleRate, duration: audio.duration}
	} finally {
		await context.close()
	}
}

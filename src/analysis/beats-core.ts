import aubio from "aubiojs"

export type RawBeat = {start: number; confidence: number; bpm: number}

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value))

/** Run aubio on a mono channel. Intended to execute inside the analysis worker. */
export async function detectRawBeats(sampleRate: number, mono: Float32Array): Promise<RawBeat[]> {
	const {Tempo} = await aubio()
	const hopSize = 512
	const bufferSize = 1024
	const detector = new Tempo(bufferSize, hopSize, sampleRate)
	const beats: RawBeat[] = []

	for (let offset = 0; offset < mono.length; offset += hopSize) {
		const frame = new Float32Array(hopSize)
		frame.set(mono.subarray(offset, Math.min(offset + hopSize, mono.length)))
		const beatOffset = detector.do(frame)
		if (!beatOffset) continue

		// aubio returns the fractional position of the beat within the current hop,
		// but the tempo tracker itself has ~4 hops of algorithmic latency (the
		// correction used by aubio's own demo_tempo.py).
		const algorithmicDelay = 4 * hopSize
		const start = Math.max(0, (offset - algorithmicDelay + beatOffset * hopSize) / sampleRate)
		const rawConfidence = Math.max(0, detector.getConfidence())
		const confidence = clamp(rawConfidence / (1 + rawConfidence))
		beats.push({start, confidence, bpm: detector.getBpm()})
	}
	return beats
}

declare module "*?inline-worker" {
	const createWorker: () => Worker
	export default createWorker
}

declare module "aubiojs" {
	type InputBuffer = Float32Array | number[]
	class Tempo {
		constructor(bufferSize: number, hopSize: number, sampleRate: number)
		do(buffer: InputBuffer): number
		getBpm(): number
		getConfidence(): number
	}
	export default function aubio(): Promise<{Tempo: typeof Tempo}>
}

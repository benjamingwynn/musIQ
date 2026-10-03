import {decodeAudio} from "./decode.js"
import createAnalysisWorker from "./analysis.worker.ts?inline-worker"
import {numbersToStatisticalRange} from "./math.js"
import type {Analysis, AnalyserSettings} from "./types.js"

export type {Analysis, AnalyserSettings, DetectedBeat, DetectedSection, DetectedSegment, PositionEstimate, StatisticalRange} from "./types.js"
export {numbersToStatisticalRange} from "./math.js"

type WorkerResponse = {id: number; analysis?: Analysis; error?: string}
let sequence = 0

export async function makeAnalyser(_settings?: AnalyserSettings) {
	return async function analyse(song: ArrayBuffer): Promise<Analysis> {
		// decodeAudioData is browser-managed; after decoding, transfer channel copies to a
		// worker so FFTs, feature extraction, aubio, tatums, keys and sections never run on
		// the UI thread.
		const decoded = await decodeAudio(song)
		const worker = createAnalysisWorker()
		const id = sequence++

		try {
			const response = await new Promise<WorkerResponse>((resolve, reject) => {
				worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
					if (event.data.id === id) resolve(event.data)
				}
				worker.onerror = (event) => reject(new Error(event.message || "musIQ analysis worker failed"))
				const transfer = decoded.channels.map((channel) => channel.buffer)
				worker.postMessage({id, decoded}, transfer)
			})

			if (response.error) throw new Error(response.error)
			if (!response.analysis) throw new Error("musIQ analysis worker returned no analysis")
			return response.analysis
		} finally {
			worker.terminate()
		}
	}
}

export type Analyser = Awaited<ReturnType<typeof makeAnalyser>>
export default makeAnalyser

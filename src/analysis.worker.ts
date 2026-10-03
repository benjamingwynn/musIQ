/// <reference lib="webworker" />
import {analyseDecoded, type DecodedForAnalysis} from "./analysis/analyse.js"
import type {Analysis} from "./types.js"

type Request = {id: number; decoded: DecodedForAnalysis}
type Response = {id: number; analysis?: Analysis; error?: string}

self.onmessage = async (event: MessageEvent<Request>) => {
  const {id, decoded} = event.data
  try {
    const analysis = await analyseDecoded(decoded)
    const response: Response = {id, analysis}
    self.postMessage(response)
  } catch (error) {
    const response: Response = {
      id,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    }
    self.postMessage(response)
  }
}

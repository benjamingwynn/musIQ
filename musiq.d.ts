export type PositionEstimate = {confidence: number; start: number; index: number}
export type StatisticalRange = {min: number; max: number; avg: number}
export type DetectedBeat = {start: number; confidence: number; index: number; bpm: number; perceivedLoudness: number; trueLoudness: number}
export type DetectedSegment = {
  start: number
  rmsEnergy: number
  deltaRms: number
  lowEnergy: number
  midEnergy: number
  highEnergy: number
  zeroCrossingRate: number
  perceivedLoudness: number
  trueLoudness: number
}
export type DetectedSection = {
  start: number
  confidence: number
  /** C..B major, then C..B minor. Values sum to 1. */
  keys: Float32Array
  index: number
  bpm: StatisticalRange
  perceivedLoudness: StatisticalRange
  trueLoudness: StatisticalRange
  segments: DetectedSegment[]
}
export type Analysis = {sections: DetectedSection[]; tatums: PositionEstimate[]; beats: DetectedBeat[]; segments: DetectedSegment[]}
export type AnalyserSettings = {/** Retained for compatibility; ignored by v2. */ modelUrlRoot: string}
export function numbersToStatisticalRange(numbers: Iterable<number>): StatisticalRange
export function makeAnalyser(settings?: AnalyserSettings): Promise<(song: ArrayBuffer) => Promise<Analysis>>
export type Analyser = Awaited<ReturnType<typeof makeAnalyser>>
export default makeAnalyser

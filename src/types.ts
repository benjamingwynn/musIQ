/** Public musIQ API. Keep this shape compatible with the original library. */

export type PositionEstimate = {
	confidence: number
	start: number
	index: number
}

export type StatisticalRange = {
	min: number
	max: number
	avg: number
}

export type DetectedBeat = {
	start: number
	confidence: number
	index: number
	bpm: number
	perceivedLoudness: number
	/** EBU-style momentary programme loudness, in LUFS. */
	trueLoudness: number
}

export type DetectedSegment = {
	start: number
	rmsEnergy: number
	deltaRms: number
	lowEnergy: number
	midEnergy: number
	highEnergy: number
	zeroCrossingRate: number
	/** Eight log-spaced spectrum bands spanning roughly 40 Hz to 16 kHz, low to high, normalized to 0..1 across the track. */
	spectrum: Float32Array
	perceivedLoudness: number
	/** EBU-style momentary programme loudness, in LUFS. */
	trueLoudness: number
}

export type DetectedSection = {
	start: number
	confidence: number
	/**
	 * Relative evidence for 24 musical keys.
	 * Ordering: C..B major, then C..B minor. Values sum to 1.
	 */
	keys: Float32Array
	index: number
	bpm: StatisticalRange
	perceivedLoudness: StatisticalRange
	/** Range of momentary programme loudness values, in LUFS. */
	trueLoudness: StatisticalRange
	segments: DetectedSegment[]
}

export type Analysis = {
	sections: DetectedSection[]
	tatums: PositionEstimate[]
	beats: DetectedBeat[]
	segments: DetectedSegment[]
}

export type AnalyserSettings = {
	/** Retained for API compatibility. v2 does not load ML models. */
	modelUrlRoot: string
}

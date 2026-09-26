module "musiq" {
  export const beatDetector: (
    sampleRate: number,
    channelData: Float32Array<ArrayBufferLike>
  ) => Promise<DetectedBeat[]>;

  export type PositionEstimate = {
    confidence: number;
    start: number;
    index: number;
  };
  export type DetectedBeat = {
    start: number;
    confidence: number;
    index: number;
    bpm: number;
    perceivedLoudness: number;
  };
  export type StatisticalRange = {
    min: number;
    max: number;
    avg: number;
  };
  type DetectedSectionPrePostAnalysis = {
    start: number;
    confidence: number;
    keys: Float32Array;
    index: number;
  };
  export type DetectedSection = DetectedSectionPrePostAnalysis & {
    bpm: StatisticalRange;
    perceivedLoudness: StatisticalRange;
    segments: DetectedSegment[];
  };
  export function numbersToStatisticalRange(
    numbers: Iterable<number>
  ): StatisticalRange;
  export type DetectedSegment = {
    start: number;
    rmsEnergy: number;
    deltaRms: number;
    lowEnergy: number;
    midEnergy: number;
    highEnergy: number;
    zeroCrossingRate: number;
    perceivedLoudness: number;
  };
  export type Analysis = {
    sections: DetectedSection[];
    tatums: PositionEstimate[];
    beats: DetectedBeat[];
    segments: DetectedSegment[];
  };
  export function makeAnalyser(settings?: {
    /** Optional URL to pull models from */
    modelUrlRoot: string;
  }): Promise<(song: ArrayBuffer) => Promise<Analysis>>;
  export type Analyser = Awaited<ReturnType<typeof makeAnalyser>>;
}

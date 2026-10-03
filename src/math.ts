import type {StatisticalRange} from "./types.js"

export const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value))

export function numbersToStatisticalRange(numbers: Iterable<number>): StatisticalRange {
  let min = Infinity
  let max = -Infinity
  let total = 0
  let count = 0
  for (const number of numbers) {
    if (!Number.isFinite(number)) continue
    min = Math.min(min, number)
    max = Math.max(max, number)
    total += number
    count++
  }
  if (count === 0) return {min: 0, max: 0, avg: 0}
  return {min, max, avg: total / count}
}

export function percentile(values: ArrayLike<number>, p: number): number {
  if (values.length === 0) return 0
  const copy = Array.from(values).filter(Number.isFinite).sort((a, b) => a - b)
  if (copy.length === 0) return 0
  const position = clamp(p, 0, 1) * (copy.length - 1)
  const low = Math.floor(position)
  const high = Math.ceil(position)
  const a = copy[low] ?? 0
  const b = copy[high] ?? a
  return a + (b - a) * (position - low)
}

export function cosineDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length)
  let dot = 0
  let aa = 0
  let bb = 0
  for (let i = 0; i < n; i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    dot += av * bv
    aa += av * av
    bb += bv * bv
  }
  if (aa === 0 || bb === 0) return 0
  return clamp(1 - dot / Math.sqrt(aa * bb), 0, 2)
}

export function meanVectors(vectors: ReadonlyArray<ArrayLike<number>>, dimension: number): Float32Array {
  const out = new Float32Array(dimension)
  if (vectors.length === 0) return out
  for (const vector of vectors) {
    for (let i = 0; i < dimension; i++) out[i] = (out[i] ?? 0) + (vector[i] ?? 0)
  }
  const inv = 1 / vectors.length
  for (let i = 0; i < dimension; i++) out[i] = (out[i] ?? 0) * inv
  return out
}

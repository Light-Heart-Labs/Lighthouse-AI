import { describe, test, expect } from 'vitest'
import { seriesFromHistory } from './Usage'

describe('seriesFromHistory', () => {
  test('returns the raw values when they vary across samples', () => {
    const history = [{ spend_usd: 1 }, { spend_usd: 4 }, { spend_usd: 2 }]
    expect(seriesFromHistory(history, 'spend_usd')).toEqual([1, 4, 2])
  })

  test('falls back to the provided series when history is flat and the fallback has signal', () => {
    const history = [{ spend_usd: 5 }, { spend_usd: 5 }, { spend_usd: 5 }]
    const fallback = [0, 3, 7]
    expect(seriesFromHistory(history, 'spend_usd', fallback)).toBe(fallback)
  })

  test('returns the flat values when both history and fallback are flat/zero', () => {
    const history = [{ spend_usd: 0 }, { spend_usd: 0 }]
    expect(seriesFromHistory(history, 'spend_usd', [0, 0])).toEqual([0, 0])
  })

  test('returns the flat values when history is flat and no fallback is given', () => {
    const history = [{ spend_usd: 5 }, { spend_usd: 5 }]
    expect(seriesFromHistory(history, 'spend_usd')).toEqual([5, 5])
  })

  test('treats missing key values as 0', () => {
    const history = [{}, { spend_usd: 3 }, {}]
    expect(seriesFromHistory(history, 'spend_usd')).toEqual([0, 3, 0])
  })

  test('treats a null/undefined history as an empty series', () => {
    expect(seriesFromHistory(null, 'spend_usd')).toEqual([])
    expect(seriesFromHistory(undefined, 'spend_usd', [1, 2])).toEqual([1, 2])
  })

  test('a single-sample history has no signal and falls back when possible', () => {
    expect(seriesFromHistory([{ spend_usd: 9 }], 'spend_usd', [1, 2])).toEqual([1, 2])
    expect(seriesFromHistory([{ spend_usd: 9 }], 'spend_usd')).toEqual([9])
  })
})

import { describe, test, expect, beforeEach } from 'vitest'
import {
  readOverviewHistory,
  writeOverviewHistory,
  readServiceCpuHistory,
  writeServiceCpuHistory,
} from './Dashboard'

const OVERVIEW_KEY = 'ods-system-overview-history-v1'
const SERVICE_CPU_KEY = 'ods-service-cpu-history-v1'

describe('readOverviewHistory / writeOverviewHistory', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  // Runs first, deliberately: readOverviewHistory/writeOverviewHistory share a
  // module-level in-memory fallback variable, so once a later test writes to
  // it this "empty" assertion would no longer hold within the same module
  // instance. Order matters here.
  test('returns an empty in-memory fallback when storage is empty', () => {
    expect(readOverviewHistory()).toEqual([])
  })

  test('round-trips a valid sample list through localStorage', () => {
    const samples = [{ t: 1, tokensPerSecond: 12.5, totalTokens: 100, tokenCountMode: 'measured' }]
    writeOverviewHistory(samples)
    expect(readOverviewHistory()).toEqual(samples)
  })

  test('filters out samples missing required numeric fields', () => {
    window.localStorage.setItem(
      OVERVIEW_KEY,
      JSON.stringify([
        { t: 1, tokensPerSecond: 5, totalTokens: 10 },
        { t: 2, tokensPerSecond: 'not-a-number', totalTokens: 10 },
        { t: null, tokensPerSecond: 5, totalTokens: 10 },
      ]),
    )
    const result = readOverviewHistory()
    expect(result).toHaveLength(1)
    expect(result[0].t).toBe(1)
  })

  test('falls back to the in-memory copy when storage holds malformed JSON', () => {
    window.localStorage.setItem(OVERVIEW_KEY, '{not valid json')
    expect(() => readOverviewHistory()).not.toThrow()
    expect(Array.isArray(readOverviewHistory())).toBe(true)
  })

  test('falls back to the in-memory copy when storage holds a non-array', () => {
    window.localStorage.setItem(OVERVIEW_KEY, JSON.stringify({ not: 'an array' }))
    expect(Array.isArray(readOverviewHistory())).toBe(true)
  })
})

describe('readServiceCpuHistory / writeServiceCpuHistory', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  test('round-trips a valid per-service history object', () => {
    const history = { 'llama-server': [{ t: 1, cpu: 12.5 }] }
    writeServiceCpuHistory(history)
    expect(readServiceCpuHistory()).toEqual(history)
  })

  test('filters out malformed samples within a service, per service', () => {
    window.localStorage.setItem(
      SERVICE_CPU_KEY,
      JSON.stringify({
        'llama-server': [{ t: 1, cpu: 10 }, { t: 'bad', cpu: 10 }],
      }),
    )
    const result = readServiceCpuHistory()
    expect(result['llama-server']).toHaveLength(1)
  })

  test('coerces a non-array value for a service id to an empty array', () => {
    window.localStorage.setItem(
      SERVICE_CPU_KEY,
      JSON.stringify({ 'llama-server': 'not-an-array' }),
    )
    expect(readServiceCpuHistory()['llama-server']).toEqual([])
  })

  test('falls back to the in-memory copy when storage holds an array instead of an object', () => {
    window.localStorage.setItem(SERVICE_CPU_KEY, JSON.stringify([1, 2, 3]))
    const result = readServiceCpuHistory()
    expect(typeof result).toBe('object')
    expect(Array.isArray(result)).toBe(false)
  })

  test('falls back to the in-memory copy when storage holds malformed JSON', () => {
    window.localStorage.setItem(SERVICE_CPU_KEY, '{broken')
    expect(() => readServiceCpuHistory()).not.toThrow()
  })
})

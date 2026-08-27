import { describe, test, expect } from 'vitest'
import { formatUsageSource, getErrorText, titleCase } from './Settings'

describe('titleCase', () => {
  test('replaces underscores/dashes with spaces and capitalizes each word', () => {
    expect(titleCase('not_configured')).toBe('Not Configured')
    expect(titleCase('rate-limited')).toBe('Rate Limited')
  })

  test('returns an empty string for a missing value', () => {
    expect(titleCase(null)).toBe('')
    expect(titleCase(undefined)).toBe('')
  })
})

describe('formatUsageSource', () => {
  test('reports unavailable when there is no status', () => {
    expect(formatUsageSource(null)).toBe('Usage source unavailable')
    expect(formatUsageSource({})).toBe('Usage source unavailable')
  })

  test('reports "Token Spy connected" for an ok status', () => {
    expect(formatUsageSource({ status: 'ok' })).toBe('Token Spy connected')
  })

  test('reports partial telemetry for a partial status', () => {
    expect(formatUsageSource({ status: 'partial' })).toBe('Partial usage telemetry')
  })

  test('title-cases any other status as a fallback', () => {
    expect(formatUsageSource({ status: 'rate_limited' })).toBe('Rate Limited')
  })
})

describe('getErrorText', () => {
  test('reports a timeout for an AbortError', () => {
    const err = new Error('irrelevant')
    err.name = 'AbortError'
    expect(getErrorText(err)).toBe('Request timed out')
  })

  test('prefers a structured details.message over the plain message', () => {
    const err = new Error('generic message')
    err.details = { message: 'specific backend detail' }
    expect(getErrorText(err)).toBe('specific backend detail')
  })

  test('falls back to err.message when there are no details', () => {
    const err = new Error('plain failure')
    expect(getErrorText(err)).toBe('plain failure')
  })

  test('falls back to a generic message when the error has neither', () => {
    expect(getErrorText({})).toBe('Failed to load settings')
    expect(getErrorText(null)).toBe('Failed to load settings')
  })
})

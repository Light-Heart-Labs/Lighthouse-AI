import { describe, test, expect } from 'vitest'
import {
  errorMessage,
  formatCompact,
  formatDate,
  formatLicense,
  formatPipeline,
  formatBytes,
  formatContext,
  contextSourceLabel,
  authorFallbackStyle,
} from './HuggingFaceModelBrowser'

describe('errorMessage', () => {
  test('prefers a plain string detail', () => {
    expect(errorMessage({ detail: 'not found' }, 'fallback')).toBe('not found')
  })

  test('falls back to detail.message when detail is an object', () => {
    expect(errorMessage({ detail: { message: 'bad request' } }, 'fallback')).toBe('bad request')
  })

  test('falls back to a top-level error string', () => {
    expect(errorMessage({ error: 'rate limited' }, 'fallback')).toBe('rate limited')
  })

  test('falls back to the provided default when nothing matches', () => {
    expect(errorMessage({}, 'fallback')).toBe('fallback')
    expect(errorMessage(null, 'fallback')).toBe('fallback')
  })
})

describe('formatCompact', () => {
  test('formats large numbers compactly', () => {
    expect(formatCompact(1500000)).toBe('1.5M')
    expect(formatCompact(950)).toBe('950')
  })

  test('treats missing/falsy values as 0', () => {
    expect(formatCompact(undefined)).toBe('0')
    expect(formatCompact(null)).toBe('0')
  })
})

describe('formatDate', () => {
  test('formats a valid ISO date', () => {
    expect(formatDate('2026-03-15T00:00:00Z')).toBe('Mar 15, 2026')
  })

  test('returns "unknown" for a missing or invalid value', () => {
    expect(formatDate(null)).toBe('unknown')
    expect(formatDate('not-a-date')).toBe('unknown')
  })
})

describe('formatLicense', () => {
  test('replaces dashes and uppercases a declared license', () => {
    expect(formatLicense('apache-2.0')).toBe('APACHE 2.0')
  })

  test('returns "Not declared" when missing', () => {
    expect(formatLicense(null)).toBe('Not declared')
    expect(formatLicense('')).toBe('Not declared')
  })
})

describe('formatPipeline', () => {
  test('replaces dashes with spaces', () => {
    expect(formatPipeline('text-generation')).toBe('text generation')
  })

  test('defaults to "text generation" when missing', () => {
    expect(formatPipeline(null)).toBe('text generation')
  })
})

describe('formatBytes', () => {
  test('formats gigabyte-scale values with one decimal', () => {
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB')
  })

  test('formats sub-gigabyte values in whole megabytes', () => {
    expect(formatBytes(512 * 1024 ** 2)).toBe('512 MB')
  })

  test('treats missing values as 0 bytes', () => {
    expect(formatBytes(undefined)).toBe('0 MB')
  })
})

describe('formatContext', () => {
  test('formats a token count in K tokens', () => {
    expect(formatContext(32768)).toBe('32K tokens')
  })

  test('returns "Unknown" for zero/missing context', () => {
    expect(formatContext(0)).toBe('Unknown')
    expect(formatContext(undefined)).toBe('Unknown')
  })
})

describe('contextSourceLabel', () => {
  test('maps known source keys to their labels', () => {
    expect(contextSourceLabel('gguf_metadata')).toBe('GGUF metadata')
    expect(contextSourceLabel('hub_config')).toBe('Hub config')
  })

  test('falls back for an unrecognized or missing source', () => {
    expect(contextSourceLabel('something-else')).toBe('Not published by repository')
    expect(contextSourceLabel(undefined)).toBe('Not published by repository')
  })
})

describe('authorFallbackStyle', () => {
  test('is deterministic for the same author', () => {
    expect(authorFallbackStyle('unsloth')).toEqual(authorFallbackStyle('unsloth'))
  })

  test('differs for different authors (not a constant fallback)', () => {
    expect(authorFallbackStyle('unsloth')).not.toEqual(authorFallbackStyle('ggml-org'))
  })

  test('defaults to a stable value when author is missing', () => {
    expect(authorFallbackStyle(undefined)).toEqual(authorFallbackStyle('huggingface'))
  })
})

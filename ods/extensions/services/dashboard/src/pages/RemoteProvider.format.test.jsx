import { describe, test, expect } from 'vitest'
import { boolLabel, modelSize, errorMessage } from './RemoteProvider'

describe('boolLabel', () => {
  test('renders Yes for a truthy value', () => {
    expect(boolLabel(true)).toBe('Yes')
    expect(boolLabel(1)).toBe('Yes')
  })

  test('renders No for a falsy value', () => {
    expect(boolLabel(false)).toBe('No')
    expect(boolLabel(null)).toBe('No')
    expect(boolLabel(undefined)).toBe('No')
    expect(boolLabel(0)).toBe('No')
  })
})

describe('modelSize', () => {
  test('prefers an explicit size string', () => {
    expect(modelSize({ size: '4.2 GB', sizeGb: 999 })).toBe('4.2 GB')
  })

  test('formats sizeGb to one decimal place when size is absent', () => {
    expect(modelSize({ sizeGb: 7.456 })).toBe('7.5 GB')
  })

  test('returns null when neither field is usable', () => {
    expect(modelSize({})).toBeNull()
    expect(modelSize(null)).toBeNull()
    expect(modelSize({ sizeGb: 'not-a-number' })).toBeNull()
  })
})

describe('errorMessage', () => {
  test('prefers a plain string detail', () => {
    expect(errorMessage({ detail: 'not found' }, 'fallback')).toBe('not found')
  })

  test('falls back to detail.message, then detail.error, within an object detail', () => {
    expect(errorMessage({ detail: { message: 'msg form' } }, 'fallback')).toBe('msg form')
    expect(errorMessage({ detail: { error: 'err form' } }, 'fallback')).toBe('err form')
  })

  test('falls back to a top-level message or error string', () => {
    expect(errorMessage({ message: 'top message' }, 'fallback')).toBe('top message')
    expect(errorMessage({ error: 'top error' }, 'fallback')).toBe('top error')
  })

  test('treats a blank/whitespace-only detail as absent and falls through', () => {
    expect(errorMessage({ detail: '   ' }, 'fallback')).toBe('fallback')
  })

  test('falls back to the provided default when nothing matches', () => {
    expect(errorMessage({}, 'fallback')).toBe('fallback')
    expect(errorMessage(null, 'fallback')).toBe('fallback')
  })
})

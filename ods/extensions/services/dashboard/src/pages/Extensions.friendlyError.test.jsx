import { describe, test, expect } from 'vitest'
import { friendlyError } from './Extensions'

describe('friendlyError', () => {
  test('passes through falsy and non-string details unchanged', () => {
    expect(friendlyError(null)).toBeNull()
    expect(friendlyError(undefined)).toBeUndefined()
    expect(friendlyError('')).toBe('')
    expect(friendlyError({ code: 500 })).toEqual({ code: 500 })
  })

  test('rewrites a local-build error', () => {
    expect(friendlyError('extension requires a local build context to install'))
      .toBe('This extension requires a local build and cannot be installed through the portal yet.')
    expect(friendlyError('needs local build'))
      .toBe('This extension requires a local build and cannot be installed through the portal yet.')
  })

  test('rewrites an already-installed error', () => {
    expect(friendlyError('extension foo is already installed'))
      .toBe('This extension is already installed.')
  })

  test('rewrites an already-enabled error', () => {
    expect(friendlyError('extension foo is already enabled'))
      .toBe('This extension is already enabled.')
  })

  test('rewrites an already-disabled error', () => {
    expect(friendlyError('extension foo is already disabled'))
      .toBe('This extension is already disabled.')
  })

  test('rewrites a disable-before-remove error', () => {
    expect(friendlyError('Disable extension before removing it'))
      .toBe('Please disable this extension before removing it.')
  })

  test('rewrites a still-enabled purge error', () => {
    expect(friendlyError('extension is still enabled, cannot purge data'))
      .toBe('Please disable this extension before purging its data.')
  })

  test('rewrites a missing data directory error', () => {
    expect(friendlyError('No data directory found for extension foo'))
      .toBe('No data directory found for this extension.')
  })

  test('passes a missing-dependencies error through unchanged', () => {
    const detail = 'Missing dependencies: docker-compose'
    expect(friendlyError(detail)).toBe(detail)
  })

  test('passes an unrecognized error string through unchanged', () => {
    const detail = 'something unexpected happened'
    expect(friendlyError(detail)).toBe(detail)
  })
})

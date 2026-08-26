import { describe, test, expect } from 'vitest'
import { friendlyError } from './Extensions'

describe('friendlyError', () => {
  test('passes through non-string or missing detail unchanged', () => {
    expect(friendlyError(null)).toBeNull()
    expect(friendlyError(undefined)).toBeUndefined()
    expect(friendlyError({ message: 'object detail' })).toEqual({ message: 'object detail' })
  })

  test('rewrites a build-context error', () => {
    expect(friendlyError('requires a local build context')).toBe(
      'This extension requires a local build and cannot be installed through the portal yet.',
    )
    expect(friendlyError('no local build available')).toBe(
      'This extension requires a local build and cannot be installed through the portal yet.',
    )
  })

  test('rewrites already-installed/enabled/disabled errors', () => {
    expect(friendlyError('service already installed')).toBe('This extension is already installed.')
    expect(friendlyError('service already enabled')).toBe('This extension is already enabled.')
    expect(friendlyError('service already disabled')).toBe('This extension is already disabled.')
  })

  test('rewrites the disable-before-remove error', () => {
    expect(friendlyError('Disable extension before removing')).toBe(
      'Please disable this extension before removing it.',
    )
  })

  test('rewrites the still-enabled (purge) error', () => {
    expect(friendlyError('extension still enabled')).toBe(
      'Please disable this extension before purging its data.',
    )
  })

  test('rewrites the missing-data-directory error', () => {
    expect(friendlyError('No data directory found')).toBe('No data directory found for this extension.')
  })

  test('passes a missing-dependencies error through verbatim (already detailed)', () => {
    const detail = 'Missing dependencies: qdrant, litellm'
    expect(friendlyError(detail)).toBe(detail)
  })

  test('passes an unrecognized error string through unchanged', () => {
    expect(friendlyError('some backend error we have never seen')).toBe(
      'some backend error we have never seen',
    )
  })
})

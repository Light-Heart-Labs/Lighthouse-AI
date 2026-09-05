import { describe, test, expect } from 'vitest'
import { tokenStatus, tokenCanRevoke } from './Invites'

describe('tokenStatus', () => {
  test('a revoked token is always revoked, regardless of other fields', () => {
    const token = { revoked_at: '2026-01-01T00:00:00Z', redemption_count: 3, reusable: true }
    expect(tokenStatus(token).label).toBe('revoked')
  })

  test('a non-owner token past its expiry is expired', () => {
    const token = { token_type: 'guest', expires_at: '2000-01-01T00:00:00Z' }
    expect(tokenStatus(token).label).toBe('expired')
  })

  test('an owner token past a nominal expires_at is not treated as expired', () => {
    const token = { token_type: 'owner', expires_at: '2000-01-01T00:00:00Z' }
    expect(tokenStatus(token).label).not.toBe('expired')
  })

  test('a single-use non-reusable non-owner token that has been redeemed is used', () => {
    const token = { token_type: 'guest', redemption_count: 1, reusable: false }
    expect(tokenStatus(token).label).toBe('used')
  })

  test('a reusable token that has been redeemed shows the redemption count', () => {
    const token = { token_type: 'guest', redemption_count: 4, reusable: true }
    expect(tokenStatus(token).label).toBe('used x 4')
  })

  test('an owner token that has been redeemed shows the redemption count, not "used"', () => {
    const token = { token_type: 'owner', redemption_count: 2, reusable: false }
    expect(tokenStatus(token).label).toBe('used x 2')
  })

  test('a fresh, unredeemed, unexpired token is active', () => {
    const token = { token_type: 'guest', redemption_count: 0 }
    expect(tokenStatus(token).label).toBe('active')
  })
})

describe('tokenCanRevoke', () => {
  test('an active token can be revoked', () => {
    expect(tokenCanRevoke({ token_type: 'guest', redemption_count: 0 })).toBe(true)
  })

  test('a redeemed reusable token (used x N) can still be revoked', () => {
    expect(tokenCanRevoke({ token_type: 'guest', redemption_count: 2, reusable: true })).toBe(true)
  })

  test('a revoked token cannot be revoked again', () => {
    expect(tokenCanRevoke({ revoked_at: '2026-01-01T00:00:00Z' })).toBe(false)
  })

  test('an expired token cannot be revoked', () => {
    expect(tokenCanRevoke({ token_type: 'guest', expires_at: '2000-01-01T00:00:00Z' })).toBe(false)
  })

  test('a single-use, already-used token can still be revoked (its label starts with "used")', () => {
    // tokenCanRevoke checks status.label.startsWith('used'), which matches both
    // the plain 'used' label and the 'used x N' label - only revoked/expired block it.
    expect(tokenCanRevoke({ token_type: 'guest', redemption_count: 1, reusable: false })).toBe(true)
  })
})

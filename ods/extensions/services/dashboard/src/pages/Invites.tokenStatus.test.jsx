import { describe, test, expect } from 'vitest'
import { formatRelative, isOwnerToken, tokenStatus, tokenCanRevoke } from './Invites'

describe('formatRelative', () => {
  test('returns null for a missing or invalid date', () => {
    expect(formatRelative(null)).toBeNull()
    expect(formatRelative('not-a-date')).toBeNull()
  })

  test('formats a recent past time in minutes', () => {
    const iso = new Date(Date.now() - 5 * 60_000).toISOString()
    expect(formatRelative(iso)).toBe('5m ago')
  })

  test('formats a recent future time in minutes', () => {
    const iso = new Date(Date.now() + 5 * 60_000).toISOString()
    expect(formatRelative(iso)).toBe('in 5m')
  })

  test('formats an hour-scale past time in hours', () => {
    const iso = new Date(Date.now() - 3 * 3_600_000).toISOString()
    expect(formatRelative(iso)).toBe('3h ago')
  })

  test('formats a day-scale future time in days', () => {
    const iso = new Date(Date.now() + 2 * 86_400_000).toISOString()
    expect(formatRelative(iso)).toBe('in 2d')
  })

  test('says "just now" for the past under a minute, "in seconds" for the future under a minute', () => {
    expect(formatRelative(new Date(Date.now() - 10_000).toISOString())).toBe('just now')
    expect(formatRelative(new Date(Date.now() + 10_000).toISOString())).toBe('in seconds')
  })
})

describe('isOwnerToken', () => {
  test('true only for token_type "owner"', () => {
    expect(isOwnerToken({ token_type: 'owner' })).toBe(true)
    expect(isOwnerToken({ token_type: 'guest' })).toBe(false)
  })
})

describe('tokenStatus', () => {
  test('revoked takes precedence over everything else', () => {
    expect(
      tokenStatus({ revoked_at: '2020-01-01', redemption_count: 5, reusable: true }).label,
    ).toBe('revoked')
  })

  test('a non-owner token past its expiry is "expired"', () => {
    const past = new Date(Date.now() - 86_400_000).toISOString()
    expect(tokenStatus({ token_type: 'guest', expires_at: past }).label).toBe('expired')
  })

  test('an owner token is never "expired" even with a past expires_at', () => {
    const past = new Date(Date.now() - 86_400_000).toISOString()
    expect(tokenStatus({ token_type: 'owner', expires_at: past }).label).not.toBe('expired')
  })

  test('a single-use non-reusable guest token that has been redeemed is "used"', () => {
    expect(
      tokenStatus({ token_type: 'guest', redemption_count: 1, reusable: false }).label,
    ).toBe('used')
  })

  test('a reusable token with redemptions shows "used x N"', () => {
    expect(
      tokenStatus({ token_type: 'guest', redemption_count: 3, reusable: true }).label,
    ).toBe('used x 3')
  })

  test('a fresh unused token is "active"', () => {
    expect(
      tokenStatus({ token_type: 'guest', redemption_count: 0, reusable: true }).label,
    ).toBe('active')
  })
})

describe('tokenCanRevoke', () => {
  test('active and used tokens can be revoked', () => {
    expect(tokenCanRevoke({ token_type: 'guest', redemption_count: 0, reusable: true })).toBe(true)
    expect(tokenCanRevoke({ token_type: 'guest', redemption_count: 1, reusable: false })).toBe(true)
    expect(tokenCanRevoke({ token_type: 'guest', redemption_count: 2, reusable: true })).toBe(true)
  })

  test('already-revoked or expired tokens cannot be revoked again', () => {
    expect(tokenCanRevoke({ revoked_at: '2020-01-01' })).toBe(false)
    const past = new Date(Date.now() - 86_400_000).toISOString()
    expect(tokenCanRevoke({ token_type: 'guest', expires_at: past })).toBe(false)
  })
})

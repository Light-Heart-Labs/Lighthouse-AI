import { describe, test, expect } from 'vitest'
import { serviceTokens } from './Usage'

describe('serviceTokens', () => {
  test('sums input, output, cache read, and cache write tokens', () => {
    const total = serviceTokens({
      input_tokens: 10,
      output_tokens: 20,
      cache_read_tokens: 5,
      cache_write_tokens: 3,
    })
    expect(total).toBe(38)
  })

  test('treats missing token fields as 0', () => {
    expect(serviceTokens({})).toBe(0)
  })

  test('treats partially populated fields as 0 for the rest', () => {
    expect(serviceTokens({ input_tokens: 100 })).toBe(100)
  })

  test('ignores unrelated fields on the service object', () => {
    const total = serviceTokens({
      service: 'llama-server',
      input_tokens: 1,
      output_tokens: 1,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    })
    expect(total).toBe(2)
  })
})

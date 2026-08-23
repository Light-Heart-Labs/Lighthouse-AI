import { renderHook, waitFor } from '@testing-library/react'
import { useGPUDetailed } from '../useGPUDetailed'

describe('useGPUDetailed', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn((url) => Promise.resolve({
      ok: url !== '/api/gpu/detailed',
      status: url === '/api/gpu/detailed' ? 503 : 200,
      json: () => Promise.resolve({}),
    })))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('surfaces a failed detailed snapshot instead of reporting a clean poll', async () => {
    const { result } = renderHook(() => useGPUDetailed())

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.detailed).toBeNull()
    expect(result.current.error).toBe('GPU detail request failed (503)')
    expect(fetch).toHaveBeenCalledWith('/api/gpu/detailed')
  })
})

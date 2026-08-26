import { renderHook, waitFor } from '@testing-library/react'
import { useGPUDetailed } from '../useGPUDetailed'

function mockOk(payload) {
  return { ok: true, json: () => Promise.resolve(payload) }
}

describe('useGPUDetailed', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('fetches detailed, history, and topology in parallel on mount', async () => {
    fetch.mockImplementation((url) => {
      if (url === '/api/gpu/detailed') return Promise.resolve(mockOk({ gpus: [] }))
      if (url === '/api/gpu/history') return Promise.resolve(mockOk({ points: [] }))
      if (url === '/api/gpu/topology') return Promise.resolve(mockOk({ nodes: [] }))
      throw new Error(`unexpected url ${url}`)
    })

    const { result } = renderHook(() => useGPUDetailed())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.detailed).toEqual({ gpus: [] })
    expect(result.current.history).toEqual({ points: [] })
    expect(result.current.topology).toEqual({ nodes: [] })
    expect(result.current.error).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  test('leaves a field unset when its endpoint responds non-ok, without failing the others', async () => {
    fetch.mockImplementation((url) => {
      if (url === '/api/gpu/detailed') return Promise.resolve({ ok: false, status: 503 })
      if (url === '/api/gpu/history') return Promise.resolve(mockOk({ points: [] }))
      if (url === '/api/gpu/topology') return Promise.resolve(mockOk({ nodes: [] }))
      throw new Error(`unexpected url ${url}`)
    })

    const { result } = renderHook(() => useGPUDetailed())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.detailed).toBeNull()
    expect(result.current.history).toEqual({ points: [] })
    expect(result.current.topology).toEqual({ nodes: [] })
    expect(result.current.error).toBeNull()
  })

  test('sets error and stops loading when a fetch rejects', async () => {
    fetch.mockRejectedValue(new Error('network down'))

    const { result } = renderHook(() => useGPUDetailed())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.error).toBe('network down')
  })

  test('skips polling while the tab is hidden', async () => {
    fetch.mockResolvedValue(mockOk({}))
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })

    renderHook(() => useGPUDetailed())

    // Give the effect's initial fetchAll() a tick; it should bail out on
    // document.hidden before calling fetch at all.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fetch).not.toHaveBeenCalled()
  })

  test('re-fetches when the tab becomes visible again', async () => {
    fetch.mockResolvedValue(mockOk({}))

    renderHook(() => useGPUDetailed())

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(3)
    })

    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    document.dispatchEvent(new Event('visibilitychange'))

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(6)
    })
  })
})

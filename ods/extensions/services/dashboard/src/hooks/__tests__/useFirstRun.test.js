import { renderHook, waitFor, act } from '@testing-library/react'
import { useFirstRun } from '../useFirstRun'

describe('useFirstRun', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('reports firstRun=true when the API says setup is incomplete', async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ first_run: true }),
    })

    const { result } = renderHook(() => useFirstRun())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.firstRun).toBe(true)
    expect(result.current.error).toBeNull()
  })

  test('reports firstRun=false when the API says setup is complete', async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ first_run: false }),
    })

    const { result } = renderHook(() => useFirstRun())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.firstRun).toBe(false)
  })

  test('defaults to firstRun=false when the response is not ok (fail closed)', async () => {
    fetch.mockResolvedValue({ ok: false, status: 503 })

    const { result } = renderHook(() => useFirstRun())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.firstRun).toBe(false)
    expect(result.current.error).toBeTruthy()
  })

  test('defaults to firstRun=false when the fetch throws (network error)', async () => {
    fetch.mockRejectedValue(new Error('network error'))

    const { result } = renderHook(() => useFirstRun())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.firstRun).toBe(false)
    expect(result.current.error).toBe('network error')
  })

  test('refresh() re-fetches and can flip firstRun back to true', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ first_run: false }),
    })

    const { result } = renderHook(() => useFirstRun())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.firstRun).toBe(false)

    fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ first_run: true }),
    })

    await act(async () => {
      await result.current.refresh()
    })

    expect(result.current.firstRun).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})

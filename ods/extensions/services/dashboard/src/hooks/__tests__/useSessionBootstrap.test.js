import { renderHook, waitFor } from '@testing-library/react'
import { useSessionBootstrap } from '../useSessionBootstrap'

describe('useSessionBootstrap', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('does nothing when disabled', async () => {
    renderHook(() => useSessionBootstrap(false))
    // Give any accidental async work a tick to run.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fetch).not.toHaveBeenCalled()
  })

  test('stops after verify-session succeeds (session already present)', async () => {
    fetch.mockResolvedValueOnce({ ok: true, status: 200 })

    renderHook(() => useSessionBootstrap())

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1)
    })
    expect(fetch).toHaveBeenCalledWith(
      '/api/auth/verify-session',
      expect.objectContaining({ credentials: 'same-origin' }),
    )
  })

  test('mints an admin session when verify-session returns 401', async () => {
    fetch
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({ ok: true, status: 200 })

    renderHook(() => useSessionBootstrap())

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(2)
    })
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/api/auth/admin-session',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' }),
    )
    expect(console.warn).not.toHaveBeenCalled()
  })

  test('warns quietly (does not throw) when admin-session 503s (secret not configured)', async () => {
    fetch
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: () => Promise.resolve({ detail: 'ODS_SESSION_SECRET not set' }),
      })

    renderHook(() => useSessionBootstrap())

    await waitFor(() => {
      expect(console.warn).toHaveBeenCalledWith(
        '[ods-session] could not mint admin session:',
        'ODS_SESSION_SECRET not set',
        expect.stringContaining('ODS_SESSION_SECRET'),
      )
    })
  })

  test('warns on other admin-session failures (e.g. 500) without throwing', async () => {
    fetch
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({ ok: false, status: 500 })

    renderHook(() => useSessionBootstrap())

    await waitFor(() => {
      expect(console.warn).toHaveBeenCalledWith('[ods-session] admin-session returned', 500)
    })
  })

  test('catches a network error without crashing the dashboard', async () => {
    fetch.mockRejectedValue(new Error('network down'))

    renderHook(() => useSessionBootstrap())

    await waitFor(() => {
      expect(console.warn).toHaveBeenCalledWith(
        '[ods-session] bootstrap failed:',
        expect.any(Error),
      )
    })
  })

  test('runs only once across re-renders of the same mount', async () => {
    fetch.mockResolvedValue({ ok: true, status: 200 })

    const { rerender } = renderHook(({ enabled }) => useSessionBootstrap(enabled), {
      initialProps: { enabled: true },
    })

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1)
    })

    rerender({ enabled: true })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

import { renderHook, waitFor } from '@testing-library/react'
import { useGPUDetailed } from '../useGPUDetailed'

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

describe('useGPUDetailed', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  })

  test('loads initial GPU state while the document is hidden', async () => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response({ gpus: [{ name: 'GPU' }] }))
      .mockResolvedValueOnce(response({ samples: [] }))
      .mockResolvedValueOnce(response({ links: [] })))

    const { result } = renderHook(() => useGPUDetailed())

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(result.current.detailed.gpus[0].name).toBe('GPU')
    expect(result.current.error).toBeNull()
  })

  test('surfaces non-success responses without discarding successful endpoints', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response({}, 500))
      .mockResolvedValueOnce(response({ samples: ['kept'] }))
      .mockResolvedValueOnce(response({}, 502)))

    const { result } = renderHook(() => useGPUDetailed())

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe(
      'GPU status unavailable: details HTTP 500, topology HTTP 502',
    )
    expect(result.current.history.samples).toEqual(['kept'])
  })
})

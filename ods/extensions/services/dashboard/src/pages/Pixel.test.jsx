import { fireEvent, screen, waitFor } from '@testing-library/react'
import { render } from '../test/test-utils'

// The repository's base ESLint profile does not mark JSX identifiers as uses.
// eslint-disable-next-line no-unused-vars
import Pixel from './Pixel'

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

// Build a fake fetch Response with streaming SSE body
const sseResponse = (frames, { status = 200, chunks } = {}) => {
  const encoder = new TextEncoder()
  const frameBytes = frames.map(f => encoder.encode(`data: ${f}\n\n`))
  const concatFrames = (group) => {
    const totalLen = group.reduce((acc, i) => acc + frameBytes[i].byteLength, 0)
    const out = new Uint8Array(totalLen)
    let offset = 0
    for (const i of group) {
      out.set(frameBytes[i], offset)
      offset += frameBytes[i].byteLength
    }
    return out
  }
  const chunkGroups = chunks
    ? chunks.map(group => concatFrames(group))
    : frameBytes
  let idx = 0
  const reader = {
    read: async () => {
      if (idx >= chunkGroups.length) return { done: true, value: undefined }
      return { done: false, value: chunkGroups[idx++] }
    },
    releaseLock: () => {},
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    body: { getReader: () => reader },
    headers: new Map([['content-type', 'text/event-stream']]),
  }
}

describe('Pixel', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows unavailable state when status fails', async () => {
    globalThis.fetch.mockResolvedValue(response({ available: false, detail: 'Edge unreachable' }))

    render(<Pixel />)

    await waitFor(() => {
      expect(screen.getByText('Degraded')).toBeInTheDocument()
    })
    expect(screen.getAllByText(/Edge unreachable/).length).toBeGreaterThan(0)
  })

  it('shows available state when status succeeds', async () => {
    globalThis.fetch.mockResolvedValue(response({ available: true, model: 'pixel/default', detail: 'local' }))

    render(<Pixel />)

    await waitFor(() => {
      expect(screen.getByText('Available')).toBeInTheDocument()
    })
  })

  it('sends exact body to stream endpoint', async () => {
    globalThis.fetch.mockResolvedValueOnce(
      response({ available: true, model: 'pixel/default', detail: 'local' })
    )

    render(<Pixel />)

    await waitFor(() => {
      expect(screen.getByText('Available')).toBeInTheDocument()
    })

    // Prepare stream response
    const streamFrames = [
      JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }),
      '[DONE]',
    ]
    globalThis.fetch.mockResolvedValueOnce(sseResponse(streamFrames))

    const textarea = screen.getByPlaceholderText('Message Pixel...')
    fireEvent.change(textarea, { target: { value: 'hi there' } })
    fireEvent.click(screen.getByTitle('Send'))

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/pixel/chat/stream',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
      )
    })

    const call = globalThis.fetch.mock.calls.find(
      c => c[0] === '/api/pixel/chat/stream'
    )
    const body = JSON.parse(call[1].body)
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].role).toBe('user')
    expect(body.messages[0].content).toBe('hi there')
    expect(body.chat_id).toBeDefined()
    expect(call[1].headers).toEqual({ 'Content-Type': 'application/json' })
    expect(call[1].headers.Authorization).toBeUndefined()
  })

  it('parses SSE chunks and displays content', async () => {
    globalThis.fetch.mockResolvedValueOnce(
      response({ available: true, model: 'pixel/default', detail: 'local' })
    )

    render(<Pixel />)

    await waitFor(() => {
      expect(screen.getByText('Available')).toBeInTheDocument()
    })

    const frames = [
      JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }),
      JSON.stringify({ choices: [{ delta: { content: ' world' } }] }),
      '[DONE]',
    ]
    globalThis.fetch.mockResolvedValueOnce(sseResponse(frames))

    const textarea = screen.getByPlaceholderText('Message Pixel...')
    fireEvent.change(textarea, { target: { value: 'hello' } })
    fireEvent.click(screen.getByTitle('Send'))

    await waitFor(() => {
      expect(screen.getByText('Hello world')).toBeInTheDocument()
    })
  })

  it('parses chunks across arbitrary boundaries', async () => {
    globalThis.fetch.mockResolvedValueOnce(
      response({ available: true, model: 'pixel/default', detail: 'local' })
    )

    render(<Pixel />)

    await waitFor(() => {
      expect(screen.getByText('Available')).toBeInTheDocument()
    })

    // Split the JSON across two reader.read() calls
    const frames = [
      JSON.stringify({ choices: [{ delta: { content: 'Split' } }] }),
      JSON.stringify({ choices: [{ delta: { content: ' test' } }] }),
      '[DONE]',
    ]
    // First chunk has only partial first frame, second has rest
    const encoder = new TextEncoder()
    const full = frames.map(f => encoder.encode(`data: ${f}\n\n`))
    const firstFrame = full[0]
    const mid = Math.floor(firstFrame.length / 2)

    let idx = 0
    const chunks = [firstFrame.slice(0, mid), firstFrame.slice(mid), full[1], full[2]]

    globalThis.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            if (idx >= chunks.length) return { done: true, value: undefined }
            return { done: false, value: chunks[idx++] }
          },
          releaseLock: () => {},
        }),
      },
      headers: new Map([['content-type', 'text/event-stream']]),
    })

    const textarea = screen.getByPlaceholderText('Message Pixel...')
    fireEvent.change(textarea, { target: { value: 'boundaries' } })
    fireEvent.click(screen.getByTitle('Send'))

    await waitFor(() => {
      expect(screen.getByText('Split test')).toBeInTheDocument()
    })
  })

  it('disables send while streaming', async () => {
    globalThis.fetch.mockResolvedValueOnce(
      response({ available: true, model: 'pixel/default', detail: 'local' })
    )

    // Stream that holds open
    const holdReader = {
      read: async () => new Promise(() => {}),
      releaseLock: () => {},
    }
    globalThis.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { getReader: () => holdReader },
      headers: new Map([['content-type', 'text/event-stream']]),
    })

    render(<Pixel />)

    await waitFor(() => {
      expect(screen.getByText('Available')).toBeInTheDocument()
    })

    const textarea = screen.getByPlaceholderText('Message Pixel...')
    fireEvent.change(textarea, { target: { value: 'test' } })
    fireEvent.click(screen.getByTitle('Send'))

    // During streaming the Send button is replaced by a Stop button;
    // the textarea itself is disabled.
    await waitFor(() => {
      expect(screen.queryByTitle('Send')).not.toBeInTheDocument()
      const ta = screen.getByPlaceholderText('Message Pixel...')
      expect(ta).toBeDisabled()
    })
  })

  it('enforces input limit', async () => {
    globalThis.fetch.mockResolvedValueOnce(
      response({ available: true, model: 'pixel/default', detail: 'local' })
    )

    render(<Pixel />)

    await waitFor(() => {
      expect(screen.getByText('Available')).toBeInTheDocument()
    })

    const textarea = screen.getByPlaceholderText('Message Pixel...')
    const longText = 'a'.repeat(16 * 1024 + 1)
    fireEvent.change(textarea, { target: { value: longText } })

    await waitFor(() => {
      expect(screen.getByText(/too long/)).toBeInTheDocument()
    })

    const sendBtn = screen.getByTitle('Send')
    expect(sendBtn).toBeDisabled()
  })

  it('shows only a generic message for an upstream error frame', async () => {
    globalThis.fetch.mockResolvedValueOnce(
      response({ available: true, model: 'pixel/default', detail: 'local' })
    )
    globalThis.fetch.mockResolvedValueOnce(sseResponse([
      JSON.stringify({ error: 'upstream-secret-value' }),
      '[DONE]',
    ]))

    render(<Pixel />)
    await waitFor(() => expect(screen.getByText('Available')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText('Message Pixel...'), { target: { value: 'test' } })
    fireEvent.click(screen.getByTitle('Send'))

    await waitFor(() => {
      expect(screen.getByText('Pixel could not complete the response.')).toBeInTheDocument()
    })
    expect(screen.queryByText(/upstream-secret-value/)).not.toBeInTheDocument()
  })

  it('marks a stream that closes without DONE as interrupted', async () => {
    globalThis.fetch.mockResolvedValueOnce(
      response({ available: true, model: 'pixel/default', detail: 'local' })
    )
    globalThis.fetch.mockResolvedValueOnce(sseResponse([
      JSON.stringify({ choices: [{ delta: { content: 'Partial answer' } }] }),
    ]))

    render(<Pixel />)
    await waitFor(() => expect(screen.getByText('Available')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText('Message Pixel...'), { target: { value: 'test' } })
    fireEvent.click(screen.getByTitle('Send'))

    await waitFor(() => expect(screen.getByText('Response interrupted.')).toBeInTheDocument())
    expect(screen.getByText('Partial answer')).toBeInTheDocument()
  })

  it('renders assistant HTML as inert text', async () => {
    const maliciousFrames = [
      JSON.stringify({ choices: [{ delta: { content: '<script>alert(1)</script>' } }] }),
      '[DONE]',
    ]

    globalThis.fetch.mockResolvedValueOnce(
      response({ available: true, model: 'pixel/default', detail: 'local' })
    )
    globalThis.fetch.mockResolvedValueOnce(sseResponse(maliciousFrames))

    render(<Pixel />)

    await waitFor(() => {
      expect(screen.getByText('Available')).toBeInTheDocument()
    })

    const textarea = screen.getByPlaceholderText('Message Pixel...')
    fireEvent.change(textarea, { target: { value: 'test' } })
    fireEvent.click(screen.getByTitle('Send'))

    await waitFor(() => {
      const el = screen.getByText('<script>alert(1)</script>')
      expect(el.tagName.toLowerCase()).not.toBe('script')
    })
  })
})

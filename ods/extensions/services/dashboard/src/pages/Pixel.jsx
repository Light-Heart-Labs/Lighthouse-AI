import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { AlertCircle, Bot, Loader2, Send, Square } from 'lucide-react'

const MARKDOWN_COMPONENTS = {
  p: ({ children }) => <p className="break-words [&:not(:first-child)]:mt-3">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
  li: ({ children }) => <li className="break-words">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  code: ({ inline, children }) => inline
    ? <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[13px] text-zinc-800">{children}</code>
    : <code className="block whitespace-pre-wrap break-words rounded bg-zinc-100 p-2 font-mono text-[13px] text-zinc-800">{children}</code>,
  pre: ({ children }) => <pre className="my-2 overflow-x-auto rounded bg-zinc-100">{children}</pre>,
  a: ({ href, children }) => {
    const safe = typeof href === 'string' && /^https?:\/\//i.test(href)
    return safe
      ? <a href={href} target="_blank" rel="noopener noreferrer" className="underline">{children}</a>
      : <span>{children}</span>
  },
}

const MAX_INPUT_LEN = 16 * 1024
let fallbackChatSequence = 0

function makeChatId() {
  const cryptoApi = globalThis.crypto
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID()
  if (cryptoApi?.getRandomValues) {
    const bytes = new Uint8Array(16)
    cryptoApi.getRandomValues(bytes)
    return `chat-${Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')}`
  }
  fallbackChatSequence += 1
  return `chat-${Date.now()}-${fallbackChatSequence}`
}

function replaceLastAssistant(messages, update) {
  const index = messages.length - 1
  if (index < 0 || messages[index]?.role !== 'assistant') return messages
  const next = [...messages]
  next[index] = { ...next[index], ...update }
  return next
}

export default function Pixel() {
  const [status, setStatus] = useState('loading')
  const [statusDetail, setStatusDetail] = useState('')
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)

  const abortRef = useRef(null)
  const chatIdRef = useRef(makeChatId())
  const scrollRef = useRef(null)

  useEffect(() => {
    const controller = new AbortController()
    async function fetchStatus() {
      try {
        const response = await fetch('/api/pixel/status', { signal: controller.signal })
        if (!response.ok) throw new Error('status unavailable')
        const data = await response.json()
        setStatus(data.available === true ? 'available' : 'unavailable')
        setStatusDetail(typeof data.detail === 'string' ? data.detail : '')
      } catch (error) {
        if (error?.name !== 'AbortError') {
          setStatus('unavailable')
          setStatusDetail('Could not reach Pixel backend')
        }
      }
    }
    fetchStatus()
    return () => controller.abort()
  }, [])

  useEffect(() => () => abortRef.current?.abort(), [])

  useEffect(() => {
    scrollRef.current?.scrollIntoView?.({ behavior: 'smooth' })
  }, [messages])

  const sendMessage = useCallback(async () => {
    const trimmed = input.trim()
    if (!trimmed || sending || status !== 'available' || trimmed.length > MAX_INPUT_LEN) return

    const userMessage = { role: 'user', content: trimmed }
    const conversation = [...messages, userMessage]
    setMessages([...conversation, { role: 'assistant', content: '', status: 'streaming' }])
    setInput('')
    setSending(true)

    const controller = new AbortController()
    abortRef.current = controller
    let reader
    let assistantText = ''
    let receivedDone = false
    let receivedError = false

    try {
      const response = await fetch('/api/pixel/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatIdRef.current, messages: conversation }),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error('chat unavailable')

      reader = response.body?.getReader()
      if (!reader) throw new Error('stream unavailable')

      const decoder = new TextDecoder()
      let buffer = ''

      while (!receivedDone) {
        const { done, value } = await reader.read()
        if (done) {
          buffer += decoder.decode()
          break
        }
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const rawLine of lines) {
          const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trimStart()
          if (payload === '[DONE]') {
            receivedDone = true
            break
          }

          try {
            const frame = JSON.parse(payload)
            if (frame?.error) {
              receivedError = true
              setMessages(previous => replaceLastAssistant(previous, {
                content: 'Pixel could not complete the response.',
                status: 'error',
              }))
              continue
            }
            const content = frame?.choices?.[0]?.delta?.content
            if (typeof content === 'string' && content.length > 0) {
              assistantText += content
              setMessages(previous => replaceLastAssistant(previous, { content: assistantText }))
            }
          } catch {
            // Ignore malformed data frames; the server bounds and terminates the stream.
          }
        }
      }

      if (!receivedError && receivedDone) {
        setMessages(previous => replaceLastAssistant(previous, { status: 'done' }))
      } else if (!receivedError) {
        const content = assistantText
          ? `${assistantText}\n\n_Response interrupted._`
          : 'Connection interrupted'
        setMessages(previous => replaceLastAssistant(previous, { content, status: 'error' }))
      }
    } catch (error) {
      if (error?.name !== 'AbortError') {
        setMessages(previous => replaceLastAssistant(previous, {
          content: assistantText || 'Request failed',
          status: 'error',
        }))
      }
    } finally {
      setSending(false)
      if (abortRef.current === controller) abortRef.current = null
      reader?.releaseLock?.()
    }
  }, [input, messages, sending, status])

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setMessages(previous => replaceLastAssistant(previous, {
      content: previous.at(-1)?.content || 'Response stopped',
      status: 'error',
    }))
    setSending(false)
  }, [])

  const inputOver = input.length > MAX_INPUT_LEN
  const isDisabled = sending || status !== 'available'

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-zinc-200 px-4 py-3">
        <Bot className="h-5 w-5 text-zinc-500" />
        <h1 className="text-lg font-semibold">Pixel</h1>
        <span className={`ml-auto inline-flex items-center gap-1.5 text-xs font-medium ${
          status === 'available' ? 'text-green-600' : 'text-amber-600'
        }`}>
          {status === 'loading' && <Loader2 className="h-3 w-3 animate-spin" />}
          {status === 'available' ? 'Available' : status === 'loading' ? 'Connecting...' : 'Degraded'}
          {status === 'unavailable' && statusDetail && (
            <span className="ml-1 text-zinc-400">{statusDetail}</span>
          )}
        </span>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {status === 'loading' && messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center text-zinc-400">
            <Loader2 className="mb-3 h-8 w-8 animate-spin" />
            <p>Connecting to Pixel...</p>
          </div>
        )}
        {status === 'unavailable' && messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center text-zinc-400">
            <AlertCircle className="mb-3 h-8 w-8" />
            <p>Pixel is currently unavailable</p>
            {statusDetail && <p className="mt-1 text-sm">{statusDetail}</p>}
          </div>
        )}
        {messages.map((message, index) => (
          <div key={index} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm ${
              message.role === 'user'
                ? 'bg-zinc-800 text-white'
                : message.status === 'error'
                  ? 'border border-red-200 bg-red-50 text-red-700'
                  : 'bg-zinc-100 text-zinc-800'
            }`}>
              {message.role === 'assistant' && message.content ? (
                <ReactMarkdown components={MARKDOWN_COMPONENTS}>{message.content}</ReactMarkdown>
              ) : (
                <span className="break-words whitespace-pre-wrap">{message.content}</span>
              )}
              {message.status === 'streaming' && !message.content && (
                <span className="ml-1 inline-flex gap-1">
                  <span className="animate-bounce">●</span>
                  <span className="animate-bounce [animation-delay:0.1s]">●</span>
                  <span className="animate-bounce [animation-delay:0.2s]">●</span>
                </span>
              )}
            </div>
          </div>
        ))}
        <div ref={scrollRef} />
      </div>

      <div className="border-t border-zinc-200 p-4">
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                sendMessage()
              }
            }}
            placeholder={status !== 'available' ? 'Pixel is unavailable' : 'Message Pixel...'}
            disabled={isDisabled}
            rows={1}
            className={`flex-1 resize-none rounded-xl border px-4 py-2.5 text-sm outline-none transition focus:ring-2 focus:ring-zinc-400 disabled:opacity-50 ${
              inputOver ? 'border-red-400' : 'border-zinc-300'
            }`}
          />
          {sending ? (
            <button
              onClick={stopStreaming}
              className="inline-flex items-center justify-center rounded-xl bg-red-500 px-3 py-2.5 text-white transition hover:bg-red-600"
              title="Stop"
            >
              <Square className="h-4 w-4" />
            </button>
          ) : (
            <button
              onClick={sendMessage}
              disabled={isDisabled || inputOver}
              className="inline-flex items-center justify-center rounded-xl bg-zinc-800 px-3 py-2.5 text-white transition hover:bg-zinc-900 disabled:opacity-50"
              title="Send"
            >
              <Send className="h-4 w-4" />
            </button>
          )}
        </div>
        {inputOver && (
          <p className="mt-1 text-xs text-red-500">
            Message too long (max {MAX_INPUT_LEN.toLocaleString()} characters)
          </p>
        )}
      </div>
    </div>
  )
}

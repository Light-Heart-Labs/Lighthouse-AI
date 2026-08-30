import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { Link } from 'react-router-dom'
import {
  AlertCircle,
  Bot,
  Code2,
  Globe2,
  Loader2,
  Plus,
  Send,
  ShieldCheck,
  Sparkles,
  Square,
  Wrench,
} from 'lucide-react'

const MARKDOWN_COMPONENTS = {
  p: ({ children }) => <p className="break-words [&:not(:first-child)]:mt-3">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
  li: ({ children }) => <li className="break-words">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  code: ({ inline, children }) => inline
    ? <code className="rounded border border-theme-border bg-theme-bg/70 px-1 py-0.5 font-mono text-[13px] text-theme-text">{children}</code>
    : <code className="block whitespace-pre-wrap break-words rounded bg-theme-bg/70 p-2 font-mono text-[13px] text-theme-text">{children}</code>,
  pre: ({ children }) => <pre className="my-2 overflow-x-auto rounded border border-theme-border bg-theme-bg/70">{children}</pre>,
  a: ({ href, children }) => {
    const safe = typeof href === 'string' && /^https?:\/\//i.test(href)
    return safe
      ? <a href={href} target="_blank" rel="noopener noreferrer" className="text-theme-accent-light underline">{children}</a>
      : <span>{children}</span>
  },
}

const MAX_INPUT_LEN = 16 * 1024
const MAX_REQUEST_MESSAGES = 50
const MAX_TOTAL_MESSAGE_BYTES = 256 * 1024
const CHAT_STORAGE_KEY = 'ods.pixel.chat.v1'
const SAFE_CHAT_ID = /^[A-Za-z0-9_-]{1,128}$/
let fallbackChatSequence = 0

const SUGGESTED_TASKS = [
  {
    icon: ShieldCheck,
    label: 'Check ODS health',
    description: 'Inspect the live stack and explain anything that needs attention.',
    prompt: 'Check the current ODS status. Summarize what is healthy, identify anything degraded or stopped, and suggest the safest next action.',
  },
  {
    icon: Code2,
    label: 'Build in my workspace',
    description: 'Create, edit, run, and verify code instead of only suggesting it.',
    prompt: 'Help me build and verify something useful in your writable workspace. Start by asking what outcome I want if it is not clear.',
  },
  {
    icon: Globe2,
    label: 'Research with sources',
    description: 'Use public web evidence and keep citations exact.',
    prompt: 'Research a public topic for me using current sources. Ask what topic and decision I need to make, then return a concise evidence-backed answer with exact source URLs.',
  },
  {
    icon: Wrench,
    label: 'Plan a multi-step task',
    description: 'Break down a larger job, use tools, and report verified progress.',
    prompt: 'Help me complete a multi-step task safely. Ask for the objective, then make a short plan and carry out the steps you can verify.',
  },
]

function formatContext(value) {
  const context = Number(value || 0)
  if (!Number.isFinite(context) || context <= 0) return ''
  if (context >= 1024 && context % 1024 === 0) return `${context / 1024}K context`
  return `${context.toLocaleString()} context`
}

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

function loadStoredChat() {
  try {
    const stored = JSON.parse(globalThis.localStorage?.getItem(CHAT_STORAGE_KEY) || 'null')
    if (
      stored?.schema !== 1
      || !SAFE_CHAT_ID.test(stored.chatId || '')
      || !Array.isArray(stored.messages)
      || stored.messages.length > MAX_REQUEST_MESSAGES
    ) return null

    let totalBytes = 0
    const messages = stored.messages.map((message) => {
      if (
        !message
        || !['user', 'assistant'].includes(message.role)
        || typeof message.content !== 'string'
        || message.content.length > MAX_INPUT_LEN
      ) throw new Error('invalid stored Pixel message')
      totalBytes += new TextEncoder().encode(message.content).byteLength
      if (totalBytes > MAX_TOTAL_MESSAGE_BYTES) throw new Error('stored Pixel chat is too large')
      return { role: message.role, content: message.content }
    })
    return { chatId: stored.chatId, messages }
  } catch {
    return null
  }
}

function boundedHistory(messages, nextUserContent) {
  const encoder = new TextEncoder()
  const budget = MAX_TOTAL_MESSAGE_BYTES - encoder.encode(nextUserContent).byteLength
  const selected = []
  let bytes = 0
  for (let index = messages.length - 1; index >= 0 && selected.length < MAX_REQUEST_MESSAGES - 2; index -= 1) {
    const { role, content } = messages[index]
    const size = encoder.encode(content).byteLength
    if (bytes + size > budget) break
    selected.unshift({ role, content })
    bytes += size
  }
  while (selected[0]?.role === 'assistant') selected.shift()
  return selected
}

export default function Pixel({ systemStatus = null }) {
  const [initialChat] = useState(loadStoredChat)
  const [status, setStatus] = useState('loading')
  const [statusDetail, setStatusDetail] = useState('')
  const [messages, setMessages] = useState(() => initialChat?.messages || [])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)

  const abortRef = useRef(null)
  const chatIdRef = useRef(initialChat?.chatId || makeChatId())
  const inputRef = useRef(null)
  const scrollRef = useRef(null)

  const activeModel = systemStatus?.inference?.loadedModel || systemStatus?.model?.name || ''
  const activeContext = formatContext(
    systemStatus?.inference?.contextSize || systemStatus?.model?.contextLength
  )

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

  useEffect(() => {
    const field = inputRef.current
    if (!field) return
    field.style.height = 'auto'
    field.style.height = `${Math.min(field.scrollHeight, 160)}px`
  }, [input])

  useEffect(() => {
    if (sending) return
    try {
      const storedMessages = boundedHistory(messages, '')
      globalThis.localStorage?.setItem(CHAT_STORAGE_KEY, JSON.stringify({
        schema: 1,
        chatId: chatIdRef.current,
        messages: storedMessages.map(({ role, content }) => ({
          role,
          content,
        })),
      }))
    } catch {
      // Conversation persistence is a convenience; chat remains usable when
      // storage is unavailable, full, or blocked by the browser.
    }
  }, [messages, sending])

  const sendMessage = useCallback(async () => {
    const trimmed = input.trim()
    if (!trimmed || sending || status !== 'available' || trimmed.length > MAX_INPUT_LEN) return

    const userMessage = { role: 'user', content: trimmed }
    // Local assistant messages carry UI-only status metadata. Keep the API
    // boundary exact so a completed or failed first turn cannot make the next
    // request fail the dashboard API's extra="forbid" contract.
    const conversation = [...boundedHistory(messages, trimmed), userMessage]
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
      status: 'stopped',
    }))
    setSending(false)
  }, [])

  const startNewChat = useCallback(() => {
    if (sending) return
    chatIdRef.current = makeChatId()
    setMessages([])
    setInput('')
    inputRef.current?.focus?.()
  }, [sending])

  const selectSuggestion = useCallback((prompt) => {
    setInput(prompt)
    inputRef.current?.focus?.()
  }, [])

  const inputOver = input.length > MAX_INPUT_LEN
  const inputEmpty = !input.trim()
  const isDisabled = sending || status !== 'available'
  const statusLabel = sending
    ? 'Working'
    : status === 'available'
      ? 'Available'
      : status === 'loading'
        ? 'Connecting...'
        : 'Degraded'

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden text-theme-text">
      <div className="flex flex-wrap items-center gap-3 border-b border-theme-border bg-theme-card/35 px-4 py-3 sm:px-6">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-theme-accent/30 bg-theme-accent/15 text-theme-accent-light">
          <Bot className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <h1 className="text-base font-semibold leading-tight">Pixel</h1>
          <p className="text-[11px] text-theme-text-muted">Your local ODS owner agent</p>
        </div>

        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
          {activeModel && (
            <div
              className="hidden min-w-0 items-center gap-2 rounded-lg border border-theme-border bg-theme-bg/40 px-2.5 py-1.5 font-mono text-[10px] text-theme-text-muted sm:flex"
              title={activeModel}
            >
              <span className="max-w-52 truncate text-theme-text-secondary">{activeModel}</span>
              {activeContext && <span className="shrink-0 text-theme-accent-light">{activeContext}</span>}
            </div>
          )}
          <Link
            to="/models"
            className="hidden rounded-lg px-2.5 py-1.5 text-xs font-medium text-theme-text-muted transition hover:bg-theme-surface-hover hover:text-theme-text sm:inline-flex"
          >
            Change model
          </Link>
          {messages.length > 0 && (
            <button
              type="button"
              onClick={startNewChat}
              disabled={sending}
              className="inline-flex items-center gap-1.5 rounded-lg border border-theme-border bg-theme-card px-2.5 py-1.5 text-xs font-medium text-theme-text-secondary transition hover:border-theme-accent/40 hover:text-theme-text disabled:cursor-not-allowed disabled:opacity-50"
              title="Start a new chat"
            >
              <Plus className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">New chat</span>
            </button>
          )}
          <span
            aria-live="polite"
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
            sending
              ? 'border-theme-accent/35 bg-theme-accent/15 text-theme-accent-light'
              : status === 'available'
              ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-400'
              : 'border-amber-500/25 bg-amber-500/10 text-amber-300'
          }`}
          >
            {sending || status === 'loading' ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <span className={`h-1.5 w-1.5 rounded-full ${
                status === 'available' ? 'bg-emerald-400' : 'bg-amber-300'
              }`} />
            )}
            {statusLabel}
          </span>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-5 sm:px-6">
        {status === 'loading' && messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center text-theme-text-muted">
            <Loader2 className="mb-3 h-8 w-8 animate-spin" />
            <p>Connecting to Pixel...</p>
          </div>
        )}
        {status === 'unavailable' && messages.length === 0 && (
          <div className="mx-auto flex h-full max-w-lg flex-col items-center justify-center text-center text-theme-text-muted">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-amber-500/25 bg-amber-500/10 text-amber-300">
              <AlertCircle className="h-7 w-7" />
            </div>
            <p className="font-medium text-theme-text">Pixel is currently unavailable</p>
            {statusDetail && <p className="mt-1 text-sm">{statusDetail}</p>}
            <p className="mt-4 text-xs">Your other ODS applications remain available while the agent reconnects.</p>
          </div>
        )}
        {status === 'available' && messages.length === 0 && (
          <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center py-8">
            <div className="mb-7 text-center">
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-theme-accent/30 bg-theme-accent/15 text-theme-accent-light shadow-[0_0_32px_rgba(157,0,255,0.18)]">
                <Sparkles className="h-7 w-7" />
              </div>
              <h2 className="text-2xl font-semibold tracking-tight">What should we accomplish?</h2>
              <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-theme-text-muted">
                Pixel can research, write and run code, inspect ODS, and carry multi-step work through to a verified result using the active local model.
              </p>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              {SUGGESTED_TASKS.map(({ icon: Icon, label, description, prompt }) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => selectSuggestion(prompt)}
                  className="group flex items-start gap-3 rounded-xl border border-theme-border bg-theme-card/70 p-4 text-left transition hover:border-theme-accent/45 hover:bg-theme-surface-hover"
                >
                  <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-theme-accent/12 text-theme-accent-light">
                    <Icon className="h-4 w-4" />
                  </span>
                  <span>
                    <span className="block text-sm font-medium text-theme-text">{label}</span>
                    <span className="mt-1 block text-xs leading-5 text-theme-text-muted">{description}</span>
                  </span>
                </button>
              ))}
            </div>

            <div className="mt-6 flex flex-wrap justify-center gap-x-4 gap-y-2 text-[11px] text-theme-text-muted">
              <span className="inline-flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5" /> Local-first</span>
              <span>Workspace tools</span>
              <span>Public-source research</span>
              <span>Explicit safety boundaries</span>
            </div>
          </div>
        )}
        {messages.map((message, index) => (
          <div key={index} className={`mx-auto flex w-full max-w-5xl ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-6 xl:max-w-3xl ${
              message.role === 'user'
                ? 'bg-theme-accent text-white shadow-lg shadow-black/10'
                : message.status === 'error'
                  ? 'border border-red-500/25 bg-red-500/10 text-red-200'
                  : 'border border-theme-border bg-theme-card text-theme-text-secondary shadow-lg shadow-black/10'
            }`}>
              {message.role === 'assistant' && message.content ? (
                <ReactMarkdown components={MARKDOWN_COMPONENTS}>{message.content}</ReactMarkdown>
              ) : (
                <span className="break-words whitespace-pre-wrap">{message.content}</span>
              )}
              {message.status === 'streaming' && !message.content && (
                <span className="inline-flex items-center gap-2 text-theme-text-muted">
                  <Loader2 className="h-4 w-4 animate-spin text-theme-accent-light" />
                  <span>Pixel is working…</span>
                </span>
              )}
            </div>
          </div>
        ))}
        <div ref={scrollRef} />
      </div>

      <div className="border-t border-theme-border bg-theme-bg/80 px-4 py-3 backdrop-blur sm:px-6">
        <div className="mx-auto max-w-5xl">
          <div className="flex gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                if (event.nativeEvent?.isComposing) return
                event.preventDefault()
                sendMessage()
              }
            }}
            placeholder={status !== 'available' ? 'Pixel is unavailable' : 'Message Pixel...'}
            disabled={isDisabled}
            rows={1}
            className={`min-h-11 flex-1 resize-none rounded-xl border bg-theme-card px-4 py-2.5 text-sm text-theme-text outline-none transition placeholder:text-theme-text-muted/70 focus:ring-2 focus:ring-theme-accent/30 disabled:opacity-50 ${
              inputOver ? 'border-red-400' : 'border-theme-border focus:border-theme-accent/60'
            }`}
          />
          {sending ? (
            <button
              onClick={stopStreaming}
              className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-red-500 text-white transition hover:bg-red-600"
              title="Stop"
            >
              <Square className="h-4 w-4" />
            </button>
          ) : (
            <button
              onClick={sendMessage}
              disabled={isDisabled || inputOver || inputEmpty}
              className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-theme-accent text-white shadow-[0_0_22px_rgba(157,0,255,0.18)] transition hover:bg-theme-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
              title="Send"
            >
              <Send className="h-4 w-4" />
            </button>
          )}
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-3 px-1 text-[10px] text-theme-text-muted/70">
            <span>{sending ? 'Pixel is using the active ODS model and tools.' : 'Enter to send • Shift+Enter for a new line'}</span>
            <span className={inputOver ? 'text-red-400' : ''}>{input.length.toLocaleString()} / {MAX_INPUT_LEN.toLocaleString()}</span>
          </div>
        </div>
        {inputOver && (
          <p className="mx-auto mt-1 max-w-5xl px-1 text-xs text-red-400">
            Message too long (max {MAX_INPUT_LEN.toLocaleString()} characters)
          </p>
        )}
      </div>
    </div>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
import { Command, Search } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

function routeMatches(route, query) {
  const haystack = `${route.label} ${route.path}`.toLocaleLowerCase()
  return haystack.includes(query.trim().toLocaleLowerCase())
}

export default function CommandPalette({ routes }) {
  const navigate = useNavigate()
  const inputRef = useRef(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)

  const results = useMemo(
    () => routes.filter(route => route.label && routeMatches(route, query)),
    [query, routes],
  )

  useEffect(() => {
    const handleShortcut = event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault()
        setOpen(current => !current)
      }
    }

    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const close = () => {
    setOpen(false)
    setQuery('')
    setSelectedIndex(0)
  }

  const selectRoute = route => {
    navigate(route.path)
    close()
  }

  const handleKeyDown = event => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (results.length === 0) return

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSelectedIndex(index => (index + 1) % results.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSelectedIndex(index => (index - 1 + results.length) % results.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      selectRoute(results[Math.min(selectedIndex, results.length - 1)])
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-5 right-5 z-30 flex items-center gap-2 rounded-xl border border-theme-border bg-theme-card px-3 py-2 text-sm text-theme-text-secondary shadow-lg transition hover:border-theme-accent hover:text-theme-text"
        aria-label="Open command palette"
      >
        <Command size={16} aria-hidden="true" />
        <span className="hidden sm:inline">Navigate</span>
        <kbd className="hidden rounded border border-theme-border px-1.5 py-0.5 font-mono text-xs text-theme-text-muted sm:inline">
          Ctrl K
        </kbd>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-[15vh] backdrop-blur-sm"
          onMouseDown={event => {
            if (event.target === event.currentTarget) close()
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Navigate ODS"
            className="w-full max-w-xl overflow-hidden rounded-2xl border border-theme-border bg-theme-card shadow-2xl"
            onKeyDown={handleKeyDown}
          >
            <div className="flex items-center gap-3 border-b border-theme-border px-4">
              <Search size={19} className="shrink-0 text-theme-text-muted" aria-hidden="true" />
              <input
                ref={inputRef}
                value={query}
                onChange={event => {
                  setQuery(event.target.value)
                  setSelectedIndex(0)
                }}
                placeholder="Search dashboard pages..."
                aria-label="Search dashboard pages"
                aria-controls="ods-command-results"
                aria-activedescendant={results.length ? `ods-command-${results[Math.min(selectedIndex, results.length - 1)].id}` : undefined}
                className="min-w-0 flex-1 bg-transparent py-4 text-theme-text outline-none placeholder:text-theme-text-muted"
              />
              <kbd className="rounded border border-theme-border px-1.5 py-0.5 font-mono text-xs text-theme-text-muted">
                Esc
              </kbd>
            </div>

            <ul id="ods-command-results" role="listbox" className="max-h-80 overflow-y-auto p-2">
              {results.map((route, index) => {
                const Icon = route.icon
                const selected = index === Math.min(selectedIndex, results.length - 1)
                return (
                  <li
                    id={`ods-command-${route.id}`}
                    key={route.id || route.path}
                    role="option"
                    aria-selected={selected}
                    onClick={() => selectRoute(route)}
                    onMouseEnter={() => setSelectedIndex(index)}
                    className={`flex cursor-pointer items-center gap-3 rounded-xl px-3 py-3 text-left transition ${
                      selected ? 'bg-theme-accent/15 text-theme-text' : 'text-theme-text-secondary hover:bg-theme-bg'
                    }`}
                  >
                    {Icon && <Icon size={18} className="shrink-0 text-theme-accent" aria-hidden="true" />}
                    <span className="min-w-0 flex-1 font-medium">{route.label}</span>
                    <span className="truncate font-mono text-xs text-theme-text-muted">{route.path}</span>
                  </li>
                )
              })}
              {results.length === 0 && (
                <li className="px-3 py-8 text-center text-sm text-theme-text-muted">
                  No dashboard pages match “{query}”.
                </li>
              )}
            </ul>
          </section>
        </div>
      )}
    </>
  )
}

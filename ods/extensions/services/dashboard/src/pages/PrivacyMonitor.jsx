import {
  Activity,
  AlertTriangle,
  Database,
  ExternalLink,
  RefreshCw,
  Server,
  ShieldCheck,
  Users,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

const POLL_INTERVAL_MS = 10000

const formatCount = (value) => {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.round(number).toLocaleString() : '0'
}

export default function PrivacyMonitor() {
  const [status, setStatus] = useState(null)
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const [statsError, setStatsError] = useState(null)
  const controllerRef = useRef(null)

  const loadPrivacy = useCallback(async ({ background = false } = {}) => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    if (background) setRefreshing(true)
    else setLoading(true)

    try {
      const statusResponse = await fetch('/api/privacy-shield/status', { signal: controller.signal })
      if (!statusResponse.ok) throw new Error(`Privacy status request failed (${statusResponse.status})`)
      const statusPayload = await statusResponse.json()
      setStatus(statusPayload)
      setError(null)

      if (statusPayload.enabled) {
        const statsResponse = await fetch('/api/privacy-shield/stats', { signal: controller.signal })
        if (!statsResponse.ok) throw new Error(`Privacy stats request failed (${statsResponse.status})`)
        const statsPayload = await statsResponse.json()
        if (statsPayload.error) {
          setStatsError(statsPayload.error)
        } else {
          setStats(statsPayload)
          setStatsError(null)
        }
      } else {
        setStats(null)
        setStatsError(null)
      }
    } catch (err) {
      if (err.name !== 'AbortError') setError(err.message || 'Privacy Shield status is unavailable')
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [])

  useEffect(() => {
    void loadPrivacy()
    const timer = window.setInterval(() => void loadPrivacy({ background: true }), POLL_INTERVAL_MS)
    return () => {
      window.clearInterval(timer)
      controllerRef.current?.abort()
    }
  }, [loadPrivacy])

  if (loading && !status) return <PrivacyMonitorSkeleton />

  const enabled = status?.enabled === true
  const cacheEnabled = stats?.cache_enabled ?? status?.pii_cache_enabled

  return (
    <div className="min-h-full px-3 py-6 sm:px-4 lg:px-5 xl:px-6">
      <header className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-[-0.01em] text-theme-text sm:text-4xl">Privacy Shield</h1>
          <p className="mt-2 text-base text-theme-text-muted">Observe local PII scrubbing without exposing captured values.</p>
        </div>
        <button
          type="button"
          onClick={() => void loadPrivacy({ background: true })}
          disabled={refreshing}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-theme-border bg-theme-card px-4 text-sm font-medium text-theme-text hover:border-theme-accent/50 disabled:opacity-60"
        >
          <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
          Refresh
        </button>
      </header>

      {error ? <WarningBanner>{error}. Showing the latest successful snapshot when available.</WarningBanner> : null}
      {statsError ? <WarningBanner>Statistics unavailable: {statsError}. Shield health is reported independently.</WarningBanner> : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <PrivacyMetric icon={ShieldCheck} label="Protection" value={enabled ? 'Active' : 'Inactive'} detail={status?.message || 'Status unavailable'} tone={enabled ? 'good' : 'muted'} />
        <PrivacyMetric icon={Users} label="Active sessions" value={formatCount(stats?.active_sessions)} detail="Sessions with in-memory PII mappings" />
        <PrivacyMetric icon={Activity} label="Active PII mappings" value={formatCount(stats?.total_pii_scrubbed)} detail="Current mappings, not a lifetime counter" />
        <PrivacyMetric icon={Database} label="PII cache" value={cacheEnabled ? 'Enabled' : 'Disabled'} detail={stats?.cache_size ? `Configured capacity: ${formatCount(stats.cache_size)}` : 'Capacity unavailable'} />
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.7fr)]">
        <section className="liquid-metal-frame liquid-metal-frame--soft rounded-lg border p-5">
          <div className="flex items-start gap-3">
            <Server size={20} className="mt-0.5 text-theme-accent-light" />
            <div>
              <h2 className="text-lg font-semibold text-theme-text">Runtime route</h2>
              <p className="mt-1 text-sm text-theme-text-muted">Requests must use the shield endpoint to receive PII scrubbing.</p>
            </div>
          </div>
          <dl className="mt-5 grid gap-4 sm:grid-cols-2">
            <RouteValue label="Shield port" value={status?.port ? `:${status.port}` : 'Unavailable'} />
            <RouteValue label="Target API" value={status?.target_api || 'Unavailable'} />
            <RouteValue label="Container" value={status?.container_running ? 'Running' : 'Not running'} />
            <RouteValue label="Session cache" value={cacheEnabled ? 'Enabled' : 'Disabled'} />
          </dl>
        </section>

        <section className="liquid-metal-frame liquid-metal-frame--soft flex flex-col justify-between rounded-lg border p-5">
          <div>
            <h2 className="text-lg font-semibold text-theme-text">Configuration</h2>
            <p className="mt-2 text-sm leading-6 text-theme-text-muted">
              {enabled
                ? 'Privacy Shield is healthy. Configuration and service lifecycle remain in the authenticated Extensions and Environment workflows.'
                : 'Enable Privacy Shield from Extensions, then route supported LLM clients through its proxy endpoint.'}
            </p>
          </div>
          <Link to="/extensions" className="mt-5 inline-flex items-center justify-between border-t border-theme-border pt-4 text-sm font-medium text-theme-accent-light">
            Manage extension <ExternalLink size={15} />
          </Link>
        </section>
      </div>
    </div>
  )
}

function PrivacyMetric({ icon: Icon, label, value, detail, tone = 'default' }) {
  const valueClass = tone === 'good' ? 'text-emerald-300' : tone === 'muted' ? 'text-theme-text-muted' : 'text-theme-text'
  return (
    <section className="liquid-metal-frame liquid-metal-frame--soft rounded-lg border p-5">
      <div className="flex items-center gap-2 text-theme-text-muted">
        <Icon size={17} />
        <h2 className="text-xs font-semibold uppercase tracking-[0.16em]">{label}</h2>
      </div>
      <p className={`mt-4 text-2xl font-semibold ${valueClass}`}>{value}</p>
      <p className="mt-2 line-clamp-2 text-xs text-theme-text-muted" title={detail}>{detail}</p>
    </section>
  )
}

function RouteValue({ label, value }) {
  return (
    <div className="min-w-0 rounded-lg border border-theme-border bg-theme-bg/25 p-4">
      <dt className="text-xs text-theme-text-muted">{label}</dt>
      <dd className="mt-1 truncate font-mono text-sm text-theme-text" title={value}>{value}</dd>
    </div>
  )
}

function WarningBanner({ children }) {
  return (
    <div role="alert" className="mb-5 flex items-center gap-3 rounded-lg border border-amber-400/25 bg-amber-400/10 p-4 text-sm text-amber-100">
      <AlertTriangle size={18} className="shrink-0" />
      <span>{children}</span>
    </div>
  )
}

function PrivacyMonitorSkeleton() {
  return (
    <div className="min-h-full animate-pulse px-5 py-7">
      <div className="h-10 w-64 rounded-lg bg-theme-card" />
      <div className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map(item => <div key={item} className="h-32 rounded-lg bg-theme-card" />)}
      </div>
    </div>
  )
}

import {
  Activity,
  AlertTriangle,
  Bot,
  Clock3,
  Cpu,
  Gauge,
  RefreshCw,
  Server,
  ShieldCheck,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

const POLL_INTERVAL_MS = 5000

const formatRate = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? number.toFixed(number >= 10 ? 1 : 2) : '0.00'
}

const formatTimestamp = (value) => {
  if (!value) return 'Not yet updated'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? 'Timestamp unavailable' : parsed.toLocaleString()
}

export default function AgentMonitor() {
  const [metrics, setMetrics] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const controllerRef = useRef(null)

  const loadMetrics = useCallback(async ({ background = false } = {}) => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    if (background) setRefreshing(true)
    else setLoading(true)

    try {
      const response = await fetch('/api/agents/metrics', { signal: controller.signal })
      if (!response.ok) throw new Error(`Agent metrics request failed (${response.status})`)
      const payload = await response.json()
      setMetrics(payload)
      setError(null)
    } catch (err) {
      if (err.name !== 'AbortError') setError(err.message || 'Agent metrics are unavailable')
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [])

  useEffect(() => {
    void loadMetrics()
    const timer = window.setInterval(() => void loadMetrics({ background: true }), POLL_INTERVAL_MS)
    return () => {
      window.clearInterval(timer)
      controllerRef.current?.abort()
    }
  }, [loadMetrics])

  if (loading && !metrics) return <AgentMonitorSkeleton />

  const agent = metrics?.agent || {}
  const cluster = metrics?.cluster || {}
  const throughput = metrics?.throughput || {}
  const nodes = Array.isArray(cluster.nodes) ? cluster.nodes : []
  const activeGpus = Number(cluster.active_gpus) || 0
  const totalGpus = Number(cluster.total_gpus) || 0

  return (
    <div className="min-h-full px-3 py-6 sm:px-4 lg:px-5 xl:px-6">
      <header className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-[-0.01em] text-theme-text sm:text-4xl">Agent Monitor</h1>
          <p className="mt-2 text-base text-theme-text-muted">Live sessions, token throughput, and cluster readiness.</p>
        </div>
        <button
          type="button"
          onClick={() => void loadMetrics({ background: true })}
          disabled={refreshing}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-theme-border bg-theme-card px-4 text-sm font-medium text-theme-text hover:border-theme-accent/50 disabled:opacity-60"
        >
          <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
          Refresh
        </button>
      </header>

      {error ? (
        <div role="alert" className="mb-5 flex items-center gap-3 rounded-lg border border-amber-400/25 bg-amber-400/10 p-4 text-sm text-amber-100">
          <AlertTriangle size={18} />
          <span>{error}. Showing the latest successful snapshot when available.</span>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon={Bot} label="Active sessions" value={String(Number(agent.session_count) || 0)} detail={`Updated ${formatTimestamp(agent.last_update)}`} />
        <MetricCard icon={Gauge} label="Token rate sample" value={`${formatRate(throughput.current)} tok/s`} detail={`Average ${formatRate(throughput.average)} · Peak ${formatRate(throughput.peak)}`} />
        <MetricCard icon={Cpu} label="Active GPUs" value={`${activeGpus}/${totalGpus}`} detail={totalGpus > 0 ? 'Cluster nodes reporting healthy' : 'No cluster nodes reported'} />
        <MetricCard icon={ShieldCheck} label="Failover" value={cluster.failover_ready ? 'Ready' : 'Not ready'} detail={cluster.failover_ready ? 'More than one GPU is active' : 'A second active GPU is required'} />
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(20rem,0.75fr)]">
        <section className="liquid-metal-frame liquid-metal-frame--soft rounded-lg border p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-theme-text">Cluster nodes</h2>
              <p className="mt-1 text-sm text-theme-text-muted">Health reported by the configured cluster proxy.</p>
            </div>
            <Server size={20} className="text-theme-accent-light" />
          </div>
          <div className="mt-5 overflow-hidden rounded-lg border border-theme-border bg-theme-bg/25">
            {nodes.length > 0 ? nodes.map((node, index) => (
              <NodeRow key={node.id || node.name || index} node={node} />
            )) : (
              <p className="px-4 py-8 text-center text-sm text-theme-text-muted">No cluster nodes reported. Single-node ODS remains fully usable.</p>
            )}
          </div>
        </section>

        <section className="liquid-metal-frame liquid-metal-frame--soft rounded-lg border p-5">
          <div className="flex items-start gap-3">
            <Activity size={20} className="mt-0.5 text-theme-accent-light" />
            <div>
              <h2 className="text-lg font-semibold text-theme-text">Throughput history</h2>
              <p className="mt-1 text-sm text-theme-text-muted">Recent samples retained by dashboard-api.</p>
            </div>
          </div>
          <ThroughputBars history={throughput.history} />
          <p className="mt-4 flex items-center gap-2 border-t border-theme-border pt-4 text-xs text-theme-text-muted">
            <Clock3 size={14} /> Snapshot generated {formatTimestamp(metrics?.timestamp)}
          </p>
        </section>
      </div>
    </div>
  )
}

function MetricCard({ icon: Icon, label, value, detail }) {
  return (
    <section className="liquid-metal-frame liquid-metal-frame--soft rounded-lg border p-5">
      <div className="flex items-center gap-2 text-theme-text-muted">
        <Icon size={17} />
        <h2 className="text-xs font-semibold uppercase tracking-[0.16em]">{label}</h2>
      </div>
      <p className="mt-4 text-2xl font-semibold text-theme-text">{value}</p>
      <p className="mt-2 truncate text-xs text-theme-text-muted" title={detail}>{detail}</p>
    </section>
  )
}

function NodeRow({ node }) {
  const healthy = node.healthy === true
  const label = node.name || node.id || node.host || 'Unnamed node'
  const rawDetail = node.model?.name || node.gpu?.name || node.model || node.gpu || node.url
  const detail = ['string', 'number'].includes(typeof rawDetail) ? String(rawDetail) : 'No runtime details reported'
  return (
    <div className="flex items-center justify-between gap-4 border-b border-theme-border px-4 py-3 last:border-b-0">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-theme-text">{label}</p>
        <p className="truncate text-xs text-theme-text-muted">{detail}</p>
      </div>
      <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${healthy ? 'bg-emerald-400/10 text-emerald-300' : 'bg-amber-400/10 text-amber-200'}`}>
        {healthy ? 'Healthy' : 'Unavailable'}
      </span>
    </div>
  )
}

function ThroughputBars({ history }) {
  const samples = Array.isArray(history) ? history.slice(-30) : []
  const peak = Math.max(...samples.map(sample => Number(sample.tokens_per_sec) || 0), 0)
  if (samples.length === 0) return <p className="mt-8 text-center text-sm text-theme-text-muted">No throughput samples yet.</p>
  return (
    <div aria-label="Recent token throughput" className="mt-6 flex h-28 items-end gap-1">
      {samples.map((sample, index) => {
        const value = Number(sample.tokens_per_sec) || 0
        const height = peak > 0 ? Math.max((value / peak) * 100, 4) : 4
        return <span key={`${sample.timestamp || 'sample'}-${index}`} title={`${formatRate(value)} tokens/sec`} className="min-w-1 flex-1 rounded-t bg-theme-accent/70" style={{ height: `${height}%` }} />
      })}
    </div>
  )
}

function AgentMonitorSkeleton() {
  return (
    <div className="min-h-full animate-pulse px-5 py-7">
      <div className="h-10 w-64 rounded-lg bg-theme-card" />
      <div className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map(item => <div key={item} className="h-32 rounded-lg bg-theme-card" />)}
      </div>
    </div>
  )
}

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Cloud,
  KeyRound,
  Loader2,
  Play,
  RefreshCw,
  Route,
  Server,
  ShieldCheck,
} from 'lucide-react'

const REQUEST_TIMEOUT_MS = 12000
const PROBE_TIMEOUT_MS = 22000

const STATUS_META = {
  ready: { label: 'Ready', dot: 'bg-emerald-400', text: 'text-emerald-300' },
  disabled: { label: 'Disabled', dot: 'bg-zinc-500', text: 'text-zinc-400' },
  degraded: { label: 'Degraded', dot: 'bg-amber-400', text: 'text-amber-300' },
  invalid: { label: 'Invalid', dot: 'bg-red-400', text: 'text-red-300' },
  unknown: { label: 'Unknown', dot: 'bg-zinc-500', text: 'text-zinc-400' },
}

function titleize(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return 'Unknown'
  return text
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^./, char => char.toUpperCase())
}

function boolLabel(value) {
  return value ? 'Yes' : 'No'
}

function valueOrDash(value) {
  if (value === null || value === undefined || value === '') return 'None'
  return String(value)
}

async function responsePayload(response) {
  try {
    return await response.json()
  } catch {
    return {}
  }
}

function errorMessage(payload, fallback) {
  if (typeof payload?.detail === 'string' && payload.detail.trim()) return payload.detail
  if (payload?.detail && typeof payload.detail === 'object') {
    if (typeof payload.detail.message === 'string' && payload.detail.message.trim()) return payload.detail.message
    if (typeof payload.detail.error === 'string' && payload.detail.error.trim()) return payload.detail.error
  }
  if (typeof payload?.message === 'string' && payload.message.trim()) return payload.message
  if (typeof payload?.error === 'string' && payload.error.trim()) return payload.error
  return fallback
}

async function fetchJson(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    const payload = await responsePayload(response)
    if (!response.ok) throw new Error(errorMessage(payload, `Request failed (${response.status})`))
    return payload
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('Request timed out')
    throw err
  } finally {
    clearTimeout(timeout)
  }
}

function StatusPill({ status }) {
  const meta = STATUS_META[status] || STATUS_META.unknown
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border border-theme-border px-3 py-1 text-xs font-semibold ${meta.text}`}>
      <span className={`h-2 w-2 rounded-full ${meta.dot}`} />
      {meta.label}
    </span>
  )
}

function Panel({ icon: Icon, title, children, actions = null }) {
  return (
    <section className="rounded-lg border border-theme-border bg-theme-card p-4 shadow-sm">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Icon size={18} className="text-theme-accent" />
          <h2 className="text-sm font-semibold text-theme-text">{title}</h2>
        </div>
        {actions}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  )
}

function Field({ label, value, tone = 'text-theme-text' }) {
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <span className="text-theme-text-muted">{label}</span>
      <span className={`text-right font-medium ${tone}`}>{valueOrDash(value)}</span>
    </div>
  )
}

function ProbeReceipt({ receipt }) {
  if (!receipt) return <p className="text-sm text-theme-text-muted">No probe receipt</p>
  return (
    <div className="rounded-lg border border-theme-border/70 bg-black/10 p-3 text-xs">
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Endpoint" value={receipt.endpoint} />
        <Field label="HTTP" value={receipt.httpStatus} />
        <Field label="Models" value={receipt.modelCount ?? 'Unknown'} />
        <Field label="Verified" value={receipt.verifiedAt} />
      </div>
    </div>
  )
}

function LoadingState() {
  return (
    <div className="flex min-h-[360px] items-center justify-center p-8 text-theme-text-muted">
      <Loader2 className="mr-2 animate-spin" size={18} />
      Loading remote GPU status
    </div>
  )
}

export default function RemoteProvider() {
  const [statusData, setStatusData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [testError, setTestError] = useState(null)

  const loadStatus = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true)
    try {
      const payload = await fetchJson('/api/remote-provider/status')
      setStatusData(payload)
      setError(null)
      return payload
    } catch (err) {
      setError(err?.message || 'Failed to load remote GPU status')
      return null
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  const runProbe = async () => {
    setTesting(true)
    setTestError(null)
    try {
      const payload = await fetchJson('/api/remote-provider/probe', { method: 'POST' }, PROBE_TIMEOUT_MS)
      setTestResult(payload)
      await loadStatus({ quiet: true })
    } catch (err) {
      setTestError(err?.message || 'Remote GPU test failed')
    } finally {
      setTesting(false)
    }
  }

  const routeState = statusData?.routeState || {}
  const provider = routeState.provider || {}
  const routeStatus = routeState.status || {}
  const egress = statusData?.egress || {}
  const sshSupervisor = statusData?.sshSupervisor || {}
  const testEnabled = Boolean(statusData?.availableActions?.test)
  const statusMeta = STATUS_META[statusData?.status] || STATUS_META.unknown
  const proofReceipt = testResult?.probe || routeStatus.lastProbe
  const proofRecorded = testResult?.routeProof?.recorded
  const proofSummary = useMemo(() => {
    if (!testResult?.routeProof) return null
    if (proofRecorded) return 'Route proof recorded'
    return `Route proof not recorded: ${titleize(testResult.routeProof.reason)}`
  }, [proofRecorded, testResult])

  if (loading) return <LoadingState />

  return (
    <div className="p-3 sm:p-6 lg:p-8">
      <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-theme-text">Remote GPU</h1>
          <p className="mt-1 text-sm text-theme-text-muted">
            Switchboard route, egress health, and SSH tunnel proof.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {statusData && <StatusPill status={statusData.status} />}
          <button
            type="button"
            onClick={() => loadStatus()}
            className="inline-flex items-center gap-2 rounded-lg border border-theme-border px-3 py-2 text-sm text-theme-text transition-colors hover:bg-theme-card-hover"
          >
            <RefreshCw size={16} />
            Refresh
          </button>
          <button
            type="button"
            onClick={runProbe}
            disabled={!testEnabled || testing}
            className="inline-flex items-center gap-2 rounded-lg bg-theme-accent px-3 py-2 text-sm font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
          >
            {testing ? <Loader2 className="animate-spin" size={16} /> : <Play size={16} />}
            Test route
          </button>
        </div>
      </header>

      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          <AlertCircle size={16} />
          {error}
        </div>
      )}
      {testError && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          <AlertCircle size={16} />
          {testError}
        </div>
      )}
      {proofSummary && (
        <div className={`mb-4 flex items-center gap-2 rounded-lg border px-4 py-3 text-sm ${
          proofRecorded
            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100'
            : 'border-amber-500/30 bg-amber-500/10 text-amber-100'
        }`}>
          {proofRecorded ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
          {proofSummary}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel icon={Route} title="Route">
          <Field label="State" value={routeState.enabled ? 'Enabled' : 'Disabled'} tone={routeState.enabled ? 'text-emerald-300' : 'text-zinc-400'} />
          <Field label="Mode" value={routeState.mode} />
          <Field label="Transport" value={provider.transport} />
          <Field label="Model" value={provider.model} />
          <Field label="Proof" value={titleize(routeStatus.reason)} tone={routeStatus.proven ? 'text-emerald-300' : 'text-amber-300'} />
          <ProbeReceipt receipt={proofReceipt} />
          {Array.isArray(routeState.errors) && routeState.errors.length > 0 && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-200">
              {routeState.errors.join('; ')}
            </div>
          )}
        </Panel>

        <Panel icon={Cloud} title="Egress">
          <Field label="Status" value={titleize(egress.status)} tone={egress.ready ? 'text-emerald-300' : 'text-amber-300'} />
          <Field label="Ready" value={boolLabel(egress.ready)} />
          <Field label="Reachable" value={boolLabel(egress.reachable)} />
          <Field label="Secret" value={egress.secret?.configured ? 'Configured' : 'Missing'} tone={egress.secret?.configured ? 'text-emerald-300' : 'text-amber-300'} />
          <Field label="Resolved addresses" value={egress.resolution?.addressCount ?? 'Unknown'} />
          <Field label="Reason" value={titleize(egress.reason)} />
        </Panel>

        <Panel icon={Server} title="SSH Tunnel">
          <Field label="Status" value={titleize(sshSupervisor.status)} tone={sshSupervisor.ready ? 'text-emerald-300' : 'text-amber-300'} />
          <Field label="Ready" value={boolLabel(sshSupervisor.ready)} />
          <Field label="Ready to start" value={boolLabel(sshSupervisor.readyToStart)} />
          <Field label="Reachable" value={boolLabel(sshSupervisor.reachable)} />
          <Field label="Reason" value={titleize(sshSupervisor.reason)} />
          <Field label="Missing secrets" value={(sshSupervisor.missingSecrets || []).length} />
        </Panel>

        <Panel icon={ShieldCheck} title="Capabilities">
          <Field label="Inference" value={boolLabel(statusData?.capabilities?.inference)} tone={statusData?.capabilities?.inference ? 'text-emerald-300' : 'text-zinc-400'} />
          <Field label="ODS peer lifecycle" value={boolLabel(statusData?.capabilities?.odsPeerLifecycle)} />
          <Field label="Available test" value={boolLabel(testEnabled)} />
          <Field label="Configure" value={boolLabel(statusData?.availableActions?.configure)} />
          <div className={`mt-2 flex items-center gap-2 rounded-lg border border-theme-border px-3 py-2 text-xs ${statusMeta.text}`}>
            <KeyRound size={14} />
            {statusMeta.label}
          </div>
        </Panel>
      </div>
    </div>
  )
}

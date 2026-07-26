import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Cloud,
  ClipboardCheck,
  KeyRound,
  Loader2,
  Play,
  Power,
  RefreshCw,
  Route,
  Save,
  Server,
  ShieldCheck,
  Trash2,
} from 'lucide-react'

const REQUEST_TIMEOUT_MS = 12000
const PROBE_TIMEOUT_MS = 22000
const LIFECYCLE_TIMEOUT_MS = 30000
const INITIAL_FORM = {
  baseUrl: '',
  model: '',
  apiKey: '',
}

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

function jsonOptions(payload) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }
}

function configurePayload(form) {
  return {
    action: 'configure',
    provider: {
      transport: 'direct',
      baseUrl: form.baseUrl.trim(),
      model: form.model.trim(),
    },
    secrets: {
      apiKey: form.apiKey.trim(),
    },
  }
}

function writesSummary(writes) {
  const plan = writes && typeof writes === 'object' ? writes : {}
  const labels = []
  if (plan.routingState) labels.push('routing state')
  if (plan.providerSecret) labels.push('provider secret')
  if (plan.sshIdentity) labels.push('ssh identity')
  if (plan.sshKnownHosts) labels.push('ssh known hosts')
  if (plan.removesRoutingState) labels.push('routing state removal')
  if (plan.removesSecrets) labels.push('stored secret removal')
  return labels.length ? labels.join(', ') : 'None'
}

function routeSummary(result) {
  const provider = result?.route?.provider || {}
  if (provider.model) return `${provider.model} via ${provider.transport || 'direct'}`
  if (result?.route?.enabled === false) return 'Disabled route'
  return 'None'
}

function lifecycleTitle(result) {
  const action = titleize(result?.action)
  if (result?.applied) return `${action} applied`
  if (result?.ok) return `${action} plan ready`
  return `${action} completed`
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

function Panel({ icon: Icon, title, children, actions = null, className = '' }) {
  return (
    <section className={`rounded-lg border border-theme-border bg-theme-card p-4 shadow-sm ${className}`}>
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

function ActionButton({ icon: Icon, children, onClick, disabled = false, primary = false, danger = false, type = 'button' }) {
  const tone = primary
    ? 'bg-theme-accent text-white hover:opacity-90'
    : danger
      ? 'border-red-500/40 text-red-200 hover:bg-red-500/10'
      : 'border-theme-border text-theme-text hover:bg-theme-card-hover'
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${tone}`}
    >
      <Icon size={16} />
      {children}
    </button>
  )
}

function TextInput({ label, value, onChange, type = 'text', autoComplete = 'off', placeholder = '' }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs font-semibold uppercase text-theme-text-muted">{label}</span>
      <input
        type={type}
        value={value}
        onChange={event => onChange(event.target.value)}
        autoComplete={autoComplete}
        placeholder={placeholder}
        className="h-10 w-full rounded-lg border border-theme-border bg-theme-bg px-3 text-sm text-theme-text outline-none transition-colors placeholder:text-theme-text-muted/50 focus:border-theme-accent"
      />
    </label>
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

function LifecycleSummary({ result }) {
  if (!result) return null
  const secretRefs = Object.keys(result.secretRefs || {}).join(', ') || 'None'
  return (
    <div className="space-y-3 rounded-lg border border-theme-border/70 bg-black/10 p-3" role="status">
      <div className="flex items-center gap-2 text-sm font-semibold text-emerald-200">
        <CheckCircle2 size={16} />
        {lifecycleTitle(result)}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Route" value={routeSummary(result)} />
        <Field label="Writes" value={writesSummary(result.writes)} />
        <Field label="Secret refs" value={secretRefs} />
        <Field label="Mutated" value={result.mutated === undefined ? 'Pending' : boolLabel(result.mutated)} />
      </div>
      {result.probe && (
        <Field
          label="Probe"
          value={`HTTP ${result.probe.httpStatus ?? 'unknown'} at ${result.probe.endpoint || '/v1/models'}`}
          tone="text-emerald-300"
        />
      )}
      {result.rollback?.attempted && (
        <Field label="Rollback" value={result.rollback.ok ? 'Ok' : 'Failed'} tone={result.rollback.ok ? 'text-emerald-300' : 'text-red-300'} />
      )}
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
  const [form, setForm] = useState(INITIAL_FORM)
  const [formDirty, setFormDirty] = useState(false)
  const [planning, setPlanning] = useState(false)
  const [applyingAction, setApplyingAction] = useState(null)
  const [planResult, setPlanResult] = useState(null)
  const [lifecycleResult, setLifecycleResult] = useState(null)
  const [lifecycleError, setLifecycleError] = useState(null)

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

  useEffect(() => {
    const provider = statusData?.routeState?.provider
    if (formDirty || !provider) return
    setForm(current => ({
      ...current,
      baseUrl: provider.baseUrl || '',
      model: provider.model || '',
    }))
  }, [formDirty, statusData])

  const updateForm = (key, value) => {
    setFormDirty(true)
    setForm(current => ({ ...current, [key]: value }))
  }

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

  const planConfigure = async () => {
    setPlanning(true)
    setLifecycleError(null)
    setLifecycleResult(null)
    try {
      const payload = await fetchJson('/api/remote-provider/plan', jsonOptions(configurePayload(form)), LIFECYCLE_TIMEOUT_MS)
      setPlanResult(payload)
    } catch (err) {
      setLifecycleError(err?.message || 'Remote GPU plan failed')
    } finally {
      setPlanning(false)
    }
  }

  const applyLifecycle = async action => {
    if (action === 'remove' && typeof window !== 'undefined' && typeof window.confirm === 'function') {
      if (!window.confirm('Remove remote GPU route and stored secrets?')) return
    }
    setApplyingAction(action)
    setLifecycleError(null)
    setPlanResult(null)
    setTestResult(null)
    setTestError(null)
    try {
      const payload = action === 'configure' ? configurePayload(form) : { action }
      const result = await fetchJson('/api/remote-provider/apply', jsonOptions(payload), LIFECYCLE_TIMEOUT_MS)
      setLifecycleResult(result)
      if (action === 'configure') {
        setForm(current => ({ ...current, apiKey: '' }))
        setFormDirty(false)
      }
      await loadStatus({ quiet: true })
    } catch (err) {
      setLifecycleError(err?.message || `Remote GPU ${action} failed`)
    } finally {
      setApplyingAction(null)
    }
  }

  const routeState = statusData?.routeState || {}
  const provider = routeState.provider || {}
  const routeStatus = routeState.status || {}
  const egress = statusData?.egress || {}
  const sshSupervisor = statusData?.sshSupervisor || {}
  const testEnabled = Boolean(statusData?.availableActions?.test)
  const statusMeta = STATUS_META[statusData?.status] || STATUS_META.unknown
  const lifecycleBusy = planning || Boolean(applyingAction)
  const configureReady = Boolean(form.baseUrl.trim() && form.model.trim() && form.apiKey.trim()) && !lifecycleBusy
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
      {lifecycleError && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          <AlertCircle size={16} />
          {lifecycleError}
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

        <Panel icon={KeyRound} title="Configure" className="lg:col-span-2">
          <div className="grid gap-3 md:grid-cols-[1.2fr_1fr_1fr]">
            <TextInput
              label="Base URL"
              value={form.baseUrl}
              onChange={value => updateForm('baseUrl', value)}
              placeholder="https://gpu.example/v1"
            />
            <TextInput
              label="Model"
              value={form.model}
              onChange={value => updateForm('model', value)}
              placeholder="qwen/remote:latest"
            />
            <TextInput
              label="API key"
              value={form.apiKey}
              onChange={value => updateForm('apiKey', value)}
              type="password"
              autoComplete="new-password"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ActionButton icon={ClipboardCheck} onClick={planConfigure} disabled={!configureReady}>
              {planning ? 'Planning' : 'Plan'}
            </ActionButton>
            <ActionButton icon={Save} onClick={() => applyLifecycle('configure')} disabled={!configureReady} primary>
              {applyingAction === 'configure' ? 'Configuring' : 'Configure'}
            </ActionButton>
            <ActionButton icon={Power} onClick={() => applyLifecycle('disable')} disabled={!statusData?.availableActions?.disable || lifecycleBusy}>
              {applyingAction === 'disable' ? 'Disabling' : 'Disable'}
            </ActionButton>
            <ActionButton icon={Trash2} onClick={() => applyLifecycle('remove')} disabled={!statusData?.availableActions?.remove || lifecycleBusy} danger>
              {applyingAction === 'remove' ? 'Removing' : 'Remove'}
            </ActionButton>
          </div>
          <LifecycleSummary result={planResult} />
          <LifecycleSummary result={lifecycleResult} />
        </Panel>
      </div>
    </div>
  )
}

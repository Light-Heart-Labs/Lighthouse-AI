import { useState, useEffect, useRef } from 'react'

// Auth: nginx injects Authorization header for all /api/ requests (see nginx.conf).

const POLL_INTERVAL = 5000

export function useGPUDetailed() {
  const [detailed, setDetailed] = useState(null)
  const [history, setHistory] = useState(null)
  const [topology, setTopology] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const fetchInFlight = useRef(false)
  const hasFetched = useRef(false)

  useEffect(() => {
    const fetchAll = async () => {
      if (document.hidden && hasFetched.current) return
      if (fetchInFlight.current) return
      fetchInFlight.current = true
      try {
        const [detRes, histRes, topoRes] = await Promise.all([
          fetch('/api/gpu/detailed'),
          fetch('/api/gpu/history'),
          fetch('/api/gpu/topology'),
        ])
        const failures = []
        if (detRes.ok) setDetailed(await detRes.json())
        else failures.push(`details HTTP ${detRes.status}`)
        if (histRes.ok) setHistory(await histRes.json())
        else failures.push(`history HTTP ${histRes.status}`)
        if (topoRes.ok) setTopology(await topoRes.json())
        else failures.push(`topology HTTP ${topoRes.status}`)
        setError(failures.length > 0 ? `GPU status unavailable: ${failures.join(', ')}` : null)
      } catch (err) {
        setError(err.message)
      } finally {
        hasFetched.current = true
        fetchInFlight.current = false
        setLoading(false)
      }
    }

    fetchAll()
    const interval = setInterval(fetchAll, POLL_INTERVAL)
    const onVisibility = () => { if (!document.hidden) fetchAll() }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  return { detailed, history, topology, loading, error }
}

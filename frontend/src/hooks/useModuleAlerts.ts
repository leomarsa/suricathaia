import { useEffect, useRef, useState, useCallback } from 'react'

export interface ModuleAlert {
  type: string
  id: number
  camera?: string
  camera_id?: number
  message: string
  ts: string
  extra?: Record<string, unknown>
}

interface Prefs {
  sound: boolean
  visual: boolean
}

const API_BASE = import.meta.env.VITE_API_URL ?? ''

function prefsKey(moduleKey: string) {
  return `alert_prefs_${moduleKey}`
}

function loadPrefs(moduleKey: string): Prefs {
  try {
    const raw = localStorage.getItem(prefsKey(moduleKey))
    if (raw) return JSON.parse(raw)
  } catch {}
  return { sound: true, visual: true }
}

function savePrefs(moduleKey: string, prefs: Prefs) {
  localStorage.setItem(prefsKey(moduleKey), JSON.stringify(prefs))
}

// Shared AudioContext across calls to avoid browser limits
let _sirenCtx: AudioContext | null = null

export function playSiren(durationSec = 6) {
  try {
    if (_sirenCtx) { _sirenCtx.close().catch(() => {}); _sirenCtx = null }
    const ctx = new AudioContext()
    _sirenCtx = ctx

    const gainNode = ctx.createGain()
    gainNode.gain.setValueAtTime(0, ctx.currentTime)
    gainNode.gain.linearRampToValueAtTime(0.45, ctx.currentTime + 0.1)
    gainNode.gain.setValueAtTime(0.45, ctx.currentTime + durationSec - 0.2)
    gainNode.gain.linearRampToValueAtTime(0, ctx.currentTime + durationSec)
    gainNode.connect(ctx.destination)

    const osc1 = ctx.createOscillator()
    osc1.type = 'sawtooth'
    osc1.connect(gainNode)

    const osc2 = ctx.createOscillator()
    osc2.type = 'sine'
    const g2 = ctx.createGain()
    g2.gain.value = 0.3
    osc2.connect(g2)
    g2.connect(gainNode)

    const t = ctx.currentTime
    const cycle = 1.2
    for (let i = 0; i < durationSec / cycle; i++) {
      osc1.frequency.setValueAtTime(660, t + i * cycle)
      osc1.frequency.linearRampToValueAtTime(1080, t + i * cycle + cycle * 0.5)
      osc1.frequency.linearRampToValueAtTime(660, t + i * cycle + cycle)
      osc2.frequency.setValueAtTime(220, t + i * cycle)
      osc2.frequency.linearRampToValueAtTime(360, t + i * cycle + cycle * 0.5)
      osc2.frequency.linearRampToValueAtTime(220, t + i * cycle + cycle)
    }

    osc1.start(t); osc1.stop(t + durationSec)
    osc2.start(t); osc2.stop(t + durationSec)
    ctx.resume()
  } catch {}
}

export function stopSiren() {
  if (_sirenCtx) { _sirenCtx.close().catch(() => {}); _sirenCtx = null }
}

export function playBeep(freq = 880, dur = 0.15) {
  try {
    const ctx = new AudioContext()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq
    gain.gain.setValueAtTime(0.25, ctx.currentTime)
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + dur)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + dur)
    ctx.resume()
  } catch {}
}

export interface UseModuleAlertsOptions {
  moduleKey: string
  eventTypes: string[]
  buildMessage: (event: Record<string, unknown>) => string
  filterEvent?: (event: Record<string, unknown>) => boolean
  sirenDuration?: number
}

export function useModuleAlerts({
  moduleKey,
  eventTypes,
  buildMessage,
  filterEvent,
  sirenDuration = 6,
}: UseModuleAlertsOptions) {
  const [prefs, setPrefsState] = useState<Prefs>(() => loadPrefs(moduleKey))
  const [alert, setAlert] = useState<ModuleAlert | null>(null)
  const soundRef = useRef(prefs.sound)
  const visualRef = useRef(prefs.visual)
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => { soundRef.current = prefs.sound }, [prefs.sound])
  useEffect(() => { visualRef.current = prefs.visual }, [prefs.visual])

  const setPrefs = useCallback((p: Prefs) => {
    setPrefsState(p)
    savePrefs(moduleKey, p)
  }, [moduleKey])

  const toggleSound = useCallback(() => {
    setPrefs({ ...prefs, sound: !prefs.sound })
    if (prefs.sound) stopSiren()
    else playBeep()
  }, [prefs, setPrefs])

  const toggleVisual = useCallback(() => {
    setPrefs({ ...prefs, visual: !prefs.visual })
    if (prefs.visual) setAlert(null)
  }, [prefs, setPrefs])

  const dismiss = useCallback(() => {
    stopSiren()
    setAlert(null)
  }, [])

  useEffect(() => {
    const token = localStorage.getItem('api_key') || ''
    const url = `${API_BASE}/api/v1/stream?token=${encodeURIComponent(token)}`
    const es = new EventSource(url)
    esRef.current = es

    es.onmessage = (e) => {
      let data: Record<string, unknown>
      try { data = JSON.parse(e.data) } catch { return }
      if (!eventTypes.includes(data.type as string)) return
      if (filterEvent && !filterEvent(data)) return

      const msg = buildMessage(data)
      const newAlert: ModuleAlert = {
        type:      data.type as string,
        id:        data.id as number,
        camera:    data.camera as string | undefined,
        camera_id: data.camera_id as number | undefined,
        message:   msg,
        ts:        (data.criado_em as string) || new Date().toISOString(),
        extra:     data,
      }

      if (visualRef.current) setAlert(newAlert)
      if (soundRef.current) playSiren(sirenDuration)
    }

    return () => { es.close(); esRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleKey])

  return { alert, prefs, toggleSound, toggleVisual, dismiss }
}

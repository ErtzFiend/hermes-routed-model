/**
 * routed-model — Desktop status-bar chip: which model the route ACTUALLY served.
 *
 * With `openrouter/auto` (or any alias/fallback route) the model you picked is a
 * placeholder; the provider answers with the real one. A `post_api_request` shell
 * hook on the backend (agent-hooks/routed-model.py) records it, this plugin's
 * backend (dashboard/plugin_api.py) serves it at /api/plugins/routed-model/latest,
 * and this chip renders it:
 *
 *     ⇄ auto → deepseek/deepseek-v4.1-flash
 *     ⇄ auto → glm-4.5-flash
 *
 * The upstream inference HOST that served the call (OpenRouter's "BaseTen",
 * "Nvidia", …) stays in the tooltip/copy — inline it was pure noise, and most
 * FreeLLMAPI lanes don't report one anyway.
 *
 * States: own call (normal) / another session's last call (dim, `~`) / route
 * lookup failed (dim, `route ?` + the error in the tooltip) / nothing yet (hidden).
 * Click the chip to copy the full detail.
 */
import { Button, Input, ListRow, ToggleRow, host, useValue } from '@hermes/plugin-sdk'
import { jsx } from 'react/jsx-runtime'
import { useEffect, useState } from 'react'

const SETTINGS_KEY = 'settings'

const DEFAULTS = {
  enabled: true,
  pollBusyMs: 1500, // mid-turn: the routed model can change between calls
  pollIdleMs: 8000,
  staleSeconds: 1800
}

/** One plugin instance's runtime state. */
const store = {
  settings: { ...DEFAULTS },
  readout: null,
  readoutErr: null,
  watchers: new Set(),
  ctx: null
}

function notifyWatchers() {
  for (const watcher of [...store.watchers]) {
    try {
      watcher()
    } catch {
      // Ignore errors in watchers
    }
  }
}

function persistSettings() {
  if (!store.ctx || !store.ctx.storage) return
  try {
    store.ctx.storage.set(SETTINGS_KEY, store.settings)
  } catch {
    // Best-effort storage persistence
  }
}

function useStore() {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const watcher = () => setTick(value => value + 1)
    store.watchers.add(watcher)
    return () => {
      store.watchers.delete(watcher)
    }
  }, [])
  return tick
}

function update(patch) {
  store.settings = { ...store.settings, ...patch }
  persistSettings()
  notifyWatchers()
}

function resetDefaults() {
  store.settings = { ...DEFAULTS }
  persistSettings()
  notifyWatchers()
}

function numberFrom(raw, fallback, min, max) {
  const parsed = Number.parseInt(String(raw), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

async function loadReadout(ctx) {
  const activeCtx = ctx || store.ctx
  if (!activeCtx || typeof activeCtx.rest !== 'function') return
  try {
    const payload = await activeCtx.rest('/latest')
    if (payload && payload.ok === false) {
      store.readout = null
      store.readoutErr = payload.error || 'Backend returned error'
    } else {
      store.readout = payload
      store.readoutErr = null
    }
  } catch (e) {
    store.readout = null
    store.readoutErr = String((e && e.message) || e)
  }
  notifyWatchers()
}

/** `openrouter/auto` -> `auto`; keeps the chip narrow. */
function routeLabel(requested) {
  if (!requested) return ''
  const tail = String(requested).split('/').pop()
  return tail || String(requested)
}

function ageLabel(seconds) {
  if (typeof seconds !== 'number' || !isFinite(seconds)) return ''
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${Math.round(seconds)}s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  return `${Math.round(seconds / 3600)}h ago`
}

/** `auto` re-picks per call: a 6-model chat hides behind one model name unless we say so. */
function mixLine(data) {
  const mix = Array.isArray(data && data.model_mix) ? data.model_mix : []
  if (mix.length < 2) return ''
  const calls = data.calls_in_session != null ? data.calls_in_session : '?'
  return `models this chat (${calls} calls): ${mix.map(([m, n]) => `${m} ${n}×`).join(' · ')}`
}

function detailText(data, own) {
  const e = (data && data.entry) || {}
  return [
    `route: ${e.requested_model || 'unknown'}`,
    `served: ${e.served_model || 'unknown'}`,
    mixLine(data),
    `serving host: ${e.serving_provider || 'not reported by upstream'}`,
    `call #${e.api_call_count != null ? e.api_call_count : '?'} this turn · ${ageLabel(data.age_seconds)}`,
    `${own ? 'this' : 'other'} session: ${e.session_id || 'unknown'}`,
    e.profile ? `profile: ${e.profile}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

function Page({ ctx }) {
  useStore()
  const settings = store.settings
  const activeCtx = ctx || store.ctx

  useEffect(() => {
    void loadReadout(activeCtx)
    const offTimer =
      activeCtx && typeof activeCtx.setInterval === 'function'
        ? activeCtx.setInterval(() => void loadReadout(activeCtx), 5000)
        : () => {}
    const offEvent =
      activeCtx && typeof activeCtx.onEvent === 'function'
        ? activeCtx.onEvent('plugin.routed-model.changed', () => void loadReadout(activeCtx))
        : () => {}
    return () => {
      offTimer()
      offEvent()
    }
  }, [activeCtx])

  const readout = store.readout
  const readoutErr = store.readoutErr

  const entry = (readout && readout.entry) || {}
  const hasCall = Boolean(entry.served_model || entry.requested_model)
  const route = entry.requested_model || 'none'
  const served = entry.served_model || 'none'
  const hostProvider = entry.serving_provider || 'not reported'
  const calls =
    readout && readout.calls_in_session != null
      ? readout.calls_in_session
      : entry.api_call_count != null
        ? entry.api_call_count
        : 'none'
  const age =
    readout && typeof readout.age_seconds === 'number'
      ? ageLabel(readout.age_seconds)
      : 'unknown'

  return jsx('div', {
    style: { display: 'grid', gap: '0.5rem' },
    children: [
      jsx(ToggleRow, {
        key: 'enabled',
        checked: settings.enabled,
        label: 'Status-bar chip',
        description: 'Display the actually served model in the Desktop status bar.',
        onChange: on => update({ enabled: on })
      }),
      jsx(ListRow, {
        key: 'pollBusyMs',
        title: 'Busy poll interval',
        description: 'Milliseconds between checks while a turn is in flight.',
        action: jsx(Input, {
          type: 'number',
          min: 100,
          max: 60000,
          step: 100,
          value: String(settings.pollBusyMs),
          onChange: event =>
            update({ pollBusyMs: numberFrom(event.target.value, settings.pollBusyMs, 100, 60000) }),
          style: { width: '6rem' }
        })
      }),
      jsx(ListRow, {
        key: 'pollIdleMs',
        title: 'Idle poll interval',
        description: 'Milliseconds between checks when idle.',
        action: jsx(Input, {
          type: 'number',
          min: 500,
          max: 300000,
          step: 500,
          value: String(settings.pollIdleMs),
          onChange: event =>
            update({ pollIdleMs: numberFrom(event.target.value, settings.pollIdleMs, 500, 300000) }),
          style: { width: '6rem' }
        })
      }),
      jsx(ListRow, {
        key: 'staleSeconds',
        title: 'Staleness threshold',
        description: 'Seconds before a captured call is considered stale.',
        action: jsx(Input, {
          type: 'number',
          min: 10,
          max: 86400,
          step: 60,
          value: String(settings.staleSeconds),
          onChange: event =>
            update({
              staleSeconds: numberFrom(event.target.value, settings.staleSeconds, 10, 86400)
            }),
          style: { width: '6rem' }
        })
      }),
      jsx(ListRow, {
        key: 'reset',
        title: 'Reset to defaults',
        description:
          'Restore default intervals (1.5s busy, 8s idle, 1800s staleness) and enable chip.',
        action: jsx(Button, {
          variant: 'outline',
          size: 'sm',
          onClick: () => resetDefaults(),
          children: 'Reset to defaults'
        })
      }),
      readoutErr
        ? jsx(ListRow, {
            key: 'readout-error',
            title: 'Last captured call',
            description: `Backend unreachable: ${readoutErr}`,
            action: jsx(Button, {
              variant: 'outline',
              size: 'sm',
              onClick: () => void loadReadout(activeCtx),
              children: 'Retry'
            })
          })
        : jsx(ListRow, {
            key: 'last-captured-call',
            title: 'Last captured call',
            description: hasCall
              ? `Route: ${route} · Served: ${served} · Host: ${hostProvider} · Calls in session: ${calls} · Age: ${age}`
              : readout
                ? 'No captured calls yet.'
                : 'Fetching latest call...',
            action: jsx(Button, {
              variant: 'outline',
              size: 'sm',
              onClick: () => void loadReadout(activeCtx),
              children: 'Refresh'
            })
          }),
      ...(!readoutErr && hasCall
        ? [
            jsx(ListRow, {
              key: 'readout-route',
              title: 'Route',
              description: route
            }),
            jsx(ListRow, {
              key: 'readout-served',
              title: 'Served model',
              description: served
            }),
            jsx(ListRow, {
              key: 'readout-host',
              title: 'Serving host',
              description: hostProvider
            }),
            jsx(ListRow, {
              key: 'readout-calls',
              title: 'Calls in session',
              description: String(calls)
            }),
            jsx(ListRow, {
              key: 'readout-age',
              title: 'Age',
              description: age
            })
          ]
        : [])
    ]
  })
}

function Chip({ ctx }) {
  useStore()
  const settings = store.settings
  const storedId = useValue(host.state.focusedStoredSessionId)
  // A profile switch must read THAT profile's captures: every profile keeps its own
  // state dir, and `?profile=` is how a remote backend scopes the request.
  const profile = useValue(host.state.focusedSessionProfile)
  const busy = useValue(host.state.busy)
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)

  useEffect(() => {
    if (!settings.enabled) {
      setData(null)
      return
    }
    let alive = true
    const load = async () => {
      try {
        const params = []
        if (storedId) params.push(`session_id=${encodeURIComponent(storedId)}`)
        if (profile && profile !== 'default') params.push(`profile=${encodeURIComponent(profile)}`)
        const query = params.length ? `?${params.join('&')}` : ''
        const payload = await ctx.rest(`/latest${query}`)
        if (!alive) return
        const entry = payload && payload.entry
        const usable =
          entry &&
          entry.served_model &&
          (typeof payload.age_seconds !== 'number' || payload.age_seconds < settings.staleSeconds)
        setData(usable ? payload : null)
        setErr(null)
      } catch (e) {
        if (alive) setErr(String((e && e.message) || e))
      }
    }
    void load()
    const offTimer = ctx.setInterval(load, busy ? settings.pollBusyMs : settings.pollIdleMs)
    // Live nudge when a backend that can broadcast (plugin-enabled gateway) fires one.
    const offEvent = ctx.onEvent('plugin.routed-model.changed', () => void load())
    return () => {
      alive = false
      offTimer()
      offEvent()
    }
  }, [
    ctx,
    storedId,
    profile,
    busy,
    settings.enabled,
    settings.pollBusyMs,
    settings.pollIdleMs,
    settings.staleSeconds
  ])

  if (!settings.enabled) return null

  if (err) {
    return jsx('button', {
      type: 'button',
      title: `Routed Model: route lookup failed\n${err}`,
      className: 'px-1.5 text-[0.6875rem] text-(--ui-text-tertiary)',
      children: 'route ?'
    })
  }
  if (!data) return null

  const entry = data.entry || {}
  const own = data.source === 'session'
  const served = entry.served_model
  const provider = entry.serving_provider
  const routed = Boolean(entry.routed)
  const tooltip = `${detailText(data, own)}\nclick to copy`

  const onClick = async () => {
    const ok = await ctx.os.writeClipboard(detailText(data, own))
    host.notify({
      kind: ok ? 'info' : 'warning',
      message: ok ? `Copied: ${served}` : `Served by ${served}${provider ? ` (${provider})` : ''}`
    })
  }

  // Own recent call, a reroute is worth the arrow; otherwise stay quiet but present.
  const label = own
    ? routed
      ? `${routeLabel(entry.requested_model)} → ${served}`
      : served
    : `~ ${routed ? `${routeLabel(entry.requested_model)} → ` : ''}${served}`

  return jsx('button', {
    type: 'button',
    title: tooltip,
    onClick,
    className: [
      'flex items-center gap-1 px-1.5 text-[0.6875rem]',
      own && routed ? 'text-(--ui-text-secondary)' : 'text-(--ui-text-tertiary)',
      'hover:text-(--ui-text-primary)'
    ].join(' '),
    children: [
      jsx('span', { key: 'dot', 'aria-hidden': 'true', children: own && routed ? '⇄' : '•' }),
      jsx('span', {
        key: 'model',
        className: 'max-w-[22rem] truncate font-mono',
        children: label
      })
    ]
  })
}

export default {
  id: 'routed-model',
  name: 'Routed Model',
  description: 'Shows which model the active route (e.g. openrouter/auto) actually served.',
  defaultEnabled: true,
  register(ctx) {
    store.ctx = ctx
    try {
      const saved = ctx.storage.get(SETTINGS_KEY, null)
      if (saved && typeof saved === 'object') {
        store.settings = { ...DEFAULTS, ...saved }
      } else {
        persistSettings()
      }
    } catch {
      store.settings = { ...DEFAULTS }
    }

    void loadReadout(ctx)

    ctx.registerSettingsPage({
      id: 'main',
      title: 'Routed Model',
      icon: 'arrow-swap',
      order: 118,
      render: () => jsx(Page, { ctx })
    })

    ctx.register({
      id: 'chip',
      area: 'statusBar.right',
      order: 118,
      render: () => jsx(Chip, { ctx })
    })
  },
  store,
  update,
  resetDefaults,
  loadReadout
}

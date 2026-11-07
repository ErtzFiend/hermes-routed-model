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
import { host, useValue } from '@hermes/plugin-sdk'
import { jsx } from 'react/jsx-runtime'
import { useEffect, useState } from 'react'

const POLL_BUSY_MS = 1500 // mid-turn: the routed model can change between calls
const POLL_IDLE_MS = 8000
const STALE_SECONDS = 1800

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

function Chip({ ctx }) {
  const storedId = useValue(host.state.focusedStoredSessionId)
  // A profile switch must read THAT profile's captures: every profile keeps its own
  // state dir, and `?profile=` is how a remote backend scopes the request.
  const profile = useValue(host.state.focusedSessionProfile)
  const busy = useValue(host.state.busy)
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)

  useEffect(() => {
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
          (typeof payload.age_seconds !== 'number' || payload.age_seconds < STALE_SECONDS)
        setData(usable ? payload : null)
        setErr(null)
      } catch (e) {
        if (alive) setErr(String((e && e.message) || e))
      }
    }
    void load()
    const offTimer = ctx.setInterval(load, busy ? POLL_BUSY_MS : POLL_IDLE_MS)
    // Live nudge when a backend that can broadcast (plugin-enabled gateway) fires one.
    const offEvent = ctx.onEvent('plugin.routed-model.changed', () => void load())
    return () => {
      alive = false
      offTimer()
      offEvent()
    }
  }, [ctx, storedId, profile, busy])

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
      jsx('span', { key: 'model', className: 'max-w-[22rem] truncate font-mono', children: label })
    ]
  })
}

export default {
  id: 'routed-model',
  name: 'Routed Model',
  description: 'Shows which model the active route (e.g. openrouter/auto) actually served.',
  defaultEnabled: true,
  register(ctx) {
    ctx.register({
      id: 'chip',
      area: 'statusBar.right',
      order: 118,
      render: () => jsx(Chip, { ctx })
    })
  }
}

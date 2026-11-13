/**
 * Behavioral tests for `desktop/plugin.js`.
 *
 * Rewrites `@hermes/plugin-sdk`, `react`, and `react/jsx-runtime` to local stubs,
 * loads the real `desktop/plugin.js`, and verifies settings page registration,
 * controls persistence through ctx.storage, and live backend readout.
 *
 * Run: node --test tests/
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, it } from 'node:test'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const PLUGIN = path.join(HERE, '..', 'desktop', 'plugin.js')
const SDK_STUB = pathToFileURL(path.join(HERE, 'stubs', 'sdk.mjs')).href
const JSX_STUB = pathToFileURL(path.join(HERE, 'stubs', 'jsx-runtime.mjs')).href
const REACT_STUB = pathToFileURL(path.join(HERE, 'stubs', 'react.mjs')).href

function makeHarness() {
  return {
    focusedStoredSessionId: 'sess-test-1',
    focusedSessionProfile: 'default',
    busy: false,
    notifications: []
  }
}

function makeCtx() {
  const timers = []
  const intervals = []
  const listeners = new Map()
  const storageMap = new Map()
  const registered = []
  const pages = []

  let restHandler = async () => ({
    ok: true,
    source: 'session',
    session_id: 'sess-test-1',
    calls_in_session: 4,
    age_seconds: 25,
    entry: {
      requested_model: 'openrouter/auto',
      served_model: 'deepseek/deepseek-v4.1-flash',
      serving_provider: 'BaseTen',
      api_call_count: 2,
      routed: true
    }
  })

  const storage_api = {
    get: (key, fallback) => (storageMap.has(key) ? storageMap.get(key) : fallback),
    set: (key, value) => {
      storageMap.set(key, value)
    },
    remove: key => {
      storageMap.delete(key)
    }
  }

  return {
    pages,
    registered,
    storage: storage_api,
    storage_api,
    timers,
    intervals,
    onEvent: (type, listener) => {
      listeners.set(type, listener)
      return () => listeners.delete(type)
    },
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms })
      return () => {}
    },
    setInterval: (fn, ms) => {
      intervals.push({ fn, ms })
      return () => {}
    },
    register: contribution => {
      registered.push(contribution)
      return () => {}
    },
    registerSettingsPage: page => {
      pages.push(page)
      return () => {}
    },
    os: {
      writeClipboard: async () => true,
      openExternal: async () => true
    },
    rest: async path => restHandler(path),
    setRestHandler: fn => {
      restHandler = fn
    },
    emit: (type, event) => {
      const listener = listeners.get(type)
      if (listener) listener(event)
    }
  }
}

function renderComponent(vnode) {
  if (!vnode) return null
  if (typeof vnode.type === 'function') {
    return renderComponent(vnode.type(vnode.props || {}))
  }
  return vnode
}

let ctx
let plugin
let harness
let moduleCounter = 0

async function loadPlugin() {
  const source = await readFile(PLUGIN, 'utf8')
  const patched = source
    .replace(/['"]@hermes\/plugin-sdk['"]/, JSON.stringify(SDK_STUB))
    .replace(/['"]react\/jsx-runtime['"]/, JSON.stringify(JSX_STUB))
    .replace(/['"]react['"]/, JSON.stringify(REACT_STUB))
  if (patched === source) {
    throw new Error('no import specifiers were rewritten — test would fail')
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'routed-model-test-'))
  const file = path.join(dir, 'plugin.under-test.mjs')
  await writeFile(file, patched, 'utf8')
  moduleCounter += 1
  const mod = await import(`${pathToFileURL(file).href}?v=${moduleCounter}`)
  return mod.default
}

beforeEach(async () => {
  harness = makeHarness()
  globalThis.__ROUTED_MODEL_TEST__ = harness
  ctx = makeCtx()
  plugin = await loadPlugin()
  plugin.register(ctx)
})

afterEach(() => {
  delete globalThis.__ROUTED_MODEL_TEST__
})

describe('routed-model desktop plugin', () => {
  it('exposes the plugin id and enabled-by-default posture the loader expects', () => {
    assert.equal(plugin.id, 'routed-model')
    assert.equal(plugin.name, 'Routed Model')
    assert.equal(plugin.defaultEnabled, true)
    assert.equal(typeof plugin.register, 'function')
  })

  it('asserts ctx.registerSettingsPage was called once with id/title/render', () => {
    assert.equal(ctx.pages.length, 1, 'registerSettingsPage should be called exactly once')
    const page = ctx.pages[0]
    assert.equal(page.id, 'main')
    assert.equal(page.title, 'Routed Model')
    assert.equal(typeof page.render, 'function')
  })

  it('registers the status-bar chip alongside the settings page', () => {
    assert.equal(ctx.registered.length, 1)
    const chip = ctx.registered[0]
    assert.equal(chip.id, 'chip')
    assert.equal(chip.area, 'statusBar.right')
    assert.equal(typeof chip.render, 'function')
  })

  it('proves a settings change round-trips through ctx.storage', async () => {
    // 1. Initial settings match defaults
    const initial = ctx.storage.get('settings', null)
    assert.ok(initial, 'initial settings must be in ctx.storage')
    assert.equal(initial.enabled, true)
    assert.equal(initial.pollBusyMs, 1500)
    assert.equal(initial.pollIdleMs, 8000)
    assert.equal(initial.staleSeconds, 1800)

    // 2. Mutate settings via update
    plugin.update({
      enabled: false,
      pollBusyMs: 3000,
      pollIdleMs: 12000,
      staleSeconds: 3600
    })

    // 3. Stored settings reflected in ctx.storage immediately
    const saved = ctx.storage.get('settings', null)
    assert.ok(saved, 'settings should be persisted in ctx.storage')
    assert.equal(saved.enabled, false)
    assert.equal(saved.pollBusyMs, 3000)
    assert.equal(saved.pollIdleMs, 12000)
    assert.equal(saved.staleSeconds, 3600)

    // 4. Reload plugin into a fresh context with the persisted storage
    const newCtx = makeCtx()
    newCtx.storage.set('settings', saved)
    const freshPlugin = await loadPlugin()
    freshPlugin.register(newCtx)

    assert.equal(freshPlugin.store.settings.enabled, false)
    assert.equal(freshPlugin.store.settings.pollBusyMs, 3000)
    assert.equal(freshPlugin.store.settings.pollIdleMs, 12000)
    assert.equal(freshPlugin.store.settings.staleSeconds, 3600)
  })

  it('renders all required controls in the settings page and binds them', () => {
    const page = ctx.pages[0]
    const vnode = renderComponent(page.render())
    assert.equal(vnode.type, 'div')
    const children = vnode.props.children.flat()

    // Find controls
    const toggle = children.find(c => c && c.key === 'enabled')
    assert.ok(toggle, 'ToggleRow for chip on/off must be present')
    assert.equal(toggle.props.checked, true)

    // Test toggle onChange
    toggle.props.onChange(false)
    assert.equal(ctx.storage.get('settings').enabled, false)

    // Find poll intervals and staleness threshold inputs
    const busyRow = children.find(c => c && c.key === 'pollBusyMs')
    assert.ok(busyRow, 'Busy poll interval row must be present')
    assert.ok(busyRow.props.action, 'Busy row must have Input action')
    busyRow.props.action.props.onChange({ target: { value: '2500' } })
    assert.equal(ctx.storage.get('settings').pollBusyMs, 2500)

    const idleRow = children.find(c => c && c.key === 'pollIdleMs')
    assert.ok(idleRow, 'Idle poll interval row must be present')
    idleRow.props.action.props.onChange({ target: { value: '10000' } })
    assert.equal(ctx.storage.get('settings').pollIdleMs, 10000)

    const staleRow = children.find(c => c && c.key === 'staleSeconds')
    assert.ok(staleRow, 'Staleness threshold row must be present')
    staleRow.props.action.props.onChange({ target: { value: '900' } })
    assert.equal(ctx.storage.get('settings').staleSeconds, 900)

    // Reset to defaults
    const resetRow = children.find(c => c && c.key === 'reset')
    assert.ok(resetRow, 'Reset to defaults row must be present')
    resetRow.props.action.props.onClick()
    assert.equal(ctx.storage.get('settings').enabled, true)
    assert.equal(ctx.storage.get('settings').pollBusyMs, 1500)
    assert.equal(ctx.storage.get('settings').pollIdleMs, 8000)
    assert.equal(ctx.storage.get('settings').staleSeconds, 1800)
  })

  it('live readout shows route, served model, serving host, calls in session, and age when reachable', async () => {
    await plugin.loadReadout(ctx)
    const page = ctx.pages[0]
    const vnode = renderComponent(page.render())
    const children = vnode.props.children.flat()

    // Check main readout row
    const mainRow = children.find(c => c && c.key === 'last-captured-call')
    assert.ok(mainRow, 'last-captured-call row must be present')
    assert.match(mainRow.props.description, /openrouter\/auto/)
    assert.match(mainRow.props.description, /deepseek\/deepseek-v4\.1-flash/)
    assert.match(mainRow.props.description, /BaseTen/)
    assert.match(mainRow.props.description, /4/)
    assert.match(mainRow.props.description, /25s ago/)

    // Check individual detailed rows
    const routeRow = children.find(c => c && c.key === 'readout-route')
    assert.ok(routeRow)
    assert.equal(routeRow.props.description, 'openrouter/auto')

    const servedRow = children.find(c => c && c.key === 'readout-served')
    assert.ok(servedRow)
    assert.equal(servedRow.props.description, 'deepseek/deepseek-v4.1-flash')

    const hostRow = children.find(c => c && c.key === 'readout-host')
    assert.ok(hostRow)
    assert.equal(hostRow.props.description, 'BaseTen')

    const callsRow = children.find(c => c && c.key === 'readout-calls')
    assert.ok(callsRow)
    assert.equal(callsRow.props.description, '4')

    const ageRow = children.find(c => c && c.key === 'readout-age')
    assert.ok(ageRow)
    assert.equal(ageRow.props.description, '25s ago')
  })

  it('live readout shows a clear error row when backend is unreachable', async () => {
    ctx.setRestHandler(() => {
      throw new Error('503 Service Unavailable')
    })
    await plugin.loadReadout(ctx)

    const page = ctx.pages[0]
    const vnode = renderComponent(page.render())
    const children = vnode.props.children.flat()

    const errorRow = children.find(c => c && c.key === 'readout-error')
    assert.ok(errorRow, 'Error row must be present when backend is unreachable')
    assert.match(errorRow.props.description, /Backend unreachable: 503 Service Unavailable/)

    const callRow = children.find(c => c && c.key === 'last-captured-call')
    assert.equal(callRow, undefined, 'Normal readout row must not be shown on error')
  })

  it('status-bar chip returns null when disabled', () => {
    plugin.update({ enabled: false })
    const chipContribution = ctx.registered.find(c => c.id === 'chip')
    const vnode = renderComponent(chipContribution.render())
    assert.equal(vnode, null, 'Chip must return null when disabled')
  })
})

/**
 * Test double for `@hermes/plugin-sdk`.
 */
const state = () => {
  const current = globalThis.__ROUTED_MODEL_TEST__
  if (!current) throw new Error('test state is not installed')
  return current
}

export const host = {
  notify: input => {
    state().notifications.push(input)
    return 'notification-id'
  },
  state: {
    focusedStoredSessionId: {
      get: () => state().focusedStoredSessionId
    },
    focusedSessionProfile: {
      get: () => state().focusedSessionProfile
    },
    busy: {
      get: () => state().busy
    }
  }
}

/** SDK components the plugin imports. */
export const Button = props => ({ type: 'Button', props })
export const Input = props => ({ type: 'Input', props })
export const ListRow = props => ({ type: 'ListRow', props })
export const ToggleRow = props => ({ type: 'ToggleRow', props })
export const useValue = atom => (atom && typeof atom.get === 'function' ? atom.get() : undefined)

/** Test double for `react` — the plugin only needs hooks at register/render time. */
export const useState = initial => [typeof initial === 'function' ? initial() : initial, () => {}]
export const useEffect = () => {}
export const useMemo = fn => fn()
export const useRef = value => ({ current: value })

/** Test double for `react/jsx-runtime` — element-shaped, never mounted. */
export const jsx = (type, props, key) => ({ type, props, key: key || props?.key })
export const jsxs = (type, props, key) => ({ type, props, key: key || props?.key })
export const Fragment = Symbol.for('react.fragment')

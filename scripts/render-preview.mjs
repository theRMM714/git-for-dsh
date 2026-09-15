/**
 * Renders the settings page to a standalone HTML file so its LAYOUT can be
 * looked at without a browser session, a login, or a running dsh.
 *
 * Why this exists: three defects in this plugin were invisible to assertions
 * about activation — a cramped strategy card, an undefined `host`, and a
 * declaration mistake — and the last two only showed up on a real page. Any
 * question of the form "does this row read as a title over an explanation, or as
 * one run of text?" is a question about layout, and layout has to be looked at.
 *
 * The page's own component renders the markup, so this is the shipped DOM, not a
 * mock. Pending states that need a live Host are short-circuited through
 * `globalThis.host`, which is exactly the identifier whose absence used to break
 * the page.
 *
 *   node scripts/render-preview.mjs [outFile]
 *
 * @module git-for-dsh/scripts/render-preview
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const bundlePath = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const outPath = process.argv[2] ?? fileURLToPath(new URL('../.preview.html', import.meta.url))
const source = readFileSync(bundlePath, 'utf8')

/** Minimal React: enough to produce a real element tree from the page component. */
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  Component: class {
    constructor(props) {
      this.props = props ?? {}
    }
  },
}

const registry = new Map()
const window = { __ModuleLoader__: { load: (row) => registry.set(row.id, row.factory) } }
new Function('window', source)(window)

/** The module id the bundle registers, read from the manifest. */
const PACKAGE_NAME = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name

const mod = registry.get(PACKAGE_NAME)((name) => {
  if (name === 'react') return React
  if (name === 'react/jsx-runtime' || name === '@deepseek-ai/dsh-client-ui-settings') return {}
  throw new Error(`cannot resolve module "${name}"`)
})

// The catalog is embedded in the artifact, so the page renders with no Host at
// all. Nothing else has to be stubbed.
const calls = { component: null }
const ctx = new Proxy(
  {
    get: (name) =>
      name === 'slots'
        ? {
            inject: (key, callback) => callback(),
            register: (spec, component) => {
              calls.component = component
            },
          }
        : name === 'settingsScope'
          ? {
              bind: () => ({
                getSnapshot: () => ({
                  status: 'ready',
                  value: { enabled: ['status', 'diff', 'log', 'show'], approveMutating: true, dangerousKeyPolicy: 'refuse-repo' },
                  revision: 1,
                  writable: true,
                  mode: 'host',
                }),
                subscribe: () => () => {},
                set: () => Promise.resolve(),
                unset: () => Promise.resolve(),
                mutate: () => Promise.resolve(),
              }),
            }
          : undefined,
    effect: (callback) => {
      callback()
      return () => {}
    },
    on: () => () => {},
  },
  {
    get(target, prop) {
      if (typeof prop !== 'string' || prop in target) return Reflect.get(target, prop)
      throw new Error(`cannot get property "${prop}" without inject`)
    },
  },
)

const ReactElementToHtml = (element) => {
  if (element === null || element === undefined || element === false) return ''
  if (typeof element === 'string' || typeof element === 'number') return String(element)
  // React renders a function component by calling it, and a class component by
  // constructing it. Leaving both out serialized the element's SOURCE as a tag
  // name, which is how a chunk of the bundle ended up inside the preview.
  if (typeof element.type === 'function' && element.type.prototype?.render !== undefined) {
    // React hands a class component its element's children as `props.children`;
    // an error boundary renders exactly that, so omitting it renders nothing.
    const instance = new element.type({ ...element.props, children: (element.children ?? [])[0] ?? null })
    return ReactElementToHtml(instance.render())
  }
  if (typeof element.type === 'function') return ReactElementToHtml(element.type(element.props))
  const { type, props, children } = element
  // HTML attribute names, not React prop names: `className` would not match the
  // stylesheet at all, so the preview would show unstyled markup and defeat its
  // own purpose.
  const attributeName = (key) => (key === 'className' ? 'class' : key === 'htmlFor' ? 'for' : key)
  const attrs = Object.entries(props)
    .filter(([key]) => key !== 'children' && key !== 'ref' && key !== 'key')
    .map(([key, value]) => {
      if (typeof value === 'function' || value === undefined || value === null) return ''
      if (typeof value === 'boolean') return value ? ` ${attributeName(key)}="${attributeName(key)}"` : ''
      return ` ${attributeName(key)}="${String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"`
    })
    .join('')
  const body = (children ?? []).flat(Infinity).map(ReactElementToHtml).join('')
  return `<${type}${attrs}>${body}</${type}>`
}

// The shell's own stylesheet, when it is already on disk, so the preview shows
// the real token values instead of a guess. The page's rules are appended after
// it, which is the same order the live page uses.
const shellCssPath = process.env.DSH_SHELL_CSS
let shellCss = ''
if (shellCssPath !== undefined) {
  try {
    shellCss = readFileSync(shellCssPath, 'utf8')
  } catch {
    console.warn(`could not read DSH_SHELL_CSS=${shellCssPath}; rendering with the page rules only`)
  }
}

/**
 * The page's own rules, captured from the bundle's OWN insertion.
 *
 * The preview installs a document, activates the plugin, and reads the tag the
 * bundle appended — so a page whose stylesheet never reaches the document shows
 * up here as an unstyled preview instead of looking fine. Re-extracting the rules
 * from the source would hide exactly that bug.
 */
const appended = []
const fakeDocument = {
  head: { appendChild: (tag) => appended.push(tag) },
  querySelector: () => null,
  createElement: (tagName) => ({ tagName, dataset: {}, textContent: '', remove() {} }),
}
const previousDocument = globalThis.document
globalThis.document = fakeDocument

mod.apply(ctx)
const tree = calls.component({})

globalThis.document = previousDocument

if (appended.length !== 1) {
  throw new Error(`the bundle appended ${appended.length} style tag(s); the preview would be misleading`)
}
const rules = appended[0].textContent
if (rules.length < 500) throw new Error(`only ${rules.length} bytes of CSS were inserted`)

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Git 工具设置页 — 布局预览</title>
<style>${shellCss}</style>
<style>
  body { margin: 0; padding: 28px; background: var(--dsw-alias-bg-base, #101014); font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  .preview-frame { max-width: 860px; margin: 0 auto; }
  .preview-note { color: var(--dsw-alias-label-secondary, #9a9aa2); font-size: 12px; line-height: 18px; margin: 0 0 18px; }
  ${rules}
</style>
</head>
<body>
<div class="preview-frame">
  <p class="preview-note">这是插件设置页的真实 DOM 与样式。着色来自 shell 的样式表${shellCss === '' ? '（未提供 DSH_SHELL_CSS，部分颜色回退为深色默认值）' : ''}。</p>
  ${ReactElementToHtml(tree)}
</div>
</body>
</html>
`

writeFileSync(outPath, html)
console.log(`wrote ${outPath} (${html.length} bytes, ${rules.length} style bytes)`)

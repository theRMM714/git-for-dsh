/**
 * Loads the client bundle the WEB HOST actually served for this plugin and
 * activates it, so the artifact the page will execute is verified without a
 * browser.
 *
 * This exists because two earlier attempts shipped a client half that looked
 * fine in a hand-built harness and then failed in the page. It therefore checks
 * the properties that actually broke, against the SERVED bytes rather than the
 * repository copy:
 *
 *   1. the module id is the package name;
 *   2. it exports `apply` and NO `inject` — a declaration here either fails the
 *      Guard's service read or parks the package forever;
 *   3. no service is reached as a bare `ctx.<service>` property in shipped code;
 *   4. `apply` runs against a context that REFUSES property reads (the page's
 *      rule) and succeeds whenever the services exist, and degrades without
 *      throwing whenever they do not.
 *
 * Usage: node scripts/verify-served-bundle.mjs <bundle-file>
 */
import { readFileSync } from 'node:fs'

const file = process.argv[2] ?? '.boot-plugin.js'
const source = readFileSync(file, 'utf8')

const code0 = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const failures = []
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures.push(label)
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

// ── 1. The served source registers the module under the package name ────────
const registry = new Map()
const window = { __ModuleLoader__: { load: (row) => registry.set(row.id, row.factory) } }
// The scope is deliberately BARE — only the module loader is bound. A bundle
// relying on any other ambient identifier would be a ReferenceError in the page,
// which is how "host is not defined" reached a user.
new Function('window', `return (function () { ${source}\n })()`)(window)

const ids = [...registry.keys()]
console.log(`served bundle: ${file}`)
check('registers exactly one module', ids.length === 1, `registered: ${ids.join(', ')}`)
check('module id is the package name', ids[0] === 'dsh-plugin-git-tool', `got ${ids[0]}`)
if (!registry.has('dsh-plugin-git-tool')) process.exit(1)

const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  Component: class {
    constructor(props) {
      this.props = props ?? {}
    }
    render() {}
  },
}
const mod = registry.get('dsh-plugin-git-tool')((name) => {
  if (name === 'react') return React
  if (name === 'react/jsx-runtime' || name === '@deepseek-ai/dsh-client-ui-settings') return {}
  throw new Error(`the page cannot resolve module "${name}"`)
})

// ── 2. Shape of the exports ────────────────────────────────────────────────
check('exports apply', typeof mod.apply === 'function')
check(
  'declares slots and settingsScope',
  Array.isArray(mod.inject) && mod.inject.includes('slots') && mod.inject.includes('settingsScope'),
  `inject = ${JSON.stringify(mod.inject)}`,
)

// ── 3. No bare service property access in shipped code ─────────────────────
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
// A bare service read is legal ONLY for a declared service, so this checks for
// UNDECLARED reads rather than forbidding reads altogether.
const undeclared = ['slots', 'settingsScope', 'theme', 'locale', 'connection', 'remote', 'timer', 'sessions', 'layout', 'styles']
  .map((name) => `ctx.${name}`)
  .filter((form) => code.includes(form))
  .filter((form) => !(mod.inject ?? []).includes(form.slice(4)))
check('every bare service read is declared', undeclared.length === 0, undeclared.join(', '))

/**
 * Build a page-like context.
 * @param provided - service names this page exposes.
 * @returns the context plus what the plugin did through it.
 */
function pageContext(provided) {
  const calls = { slots: [], registered: null, binds: 0, appended: [] }
  const document = {
    head: { appendChild: (tag) => calls.appended.push(tag) },
    querySelector: () => null,
    createElement: (tagName) => ({ tagName, dataset: {}, textContent: '', remove() {} }),
  }
  const scope = {
    getSnapshot: () => ({ status: 'ready', value: { enabled: [] }, writable: true }),
    subscribe: () => () => {},
    set: () => Promise.resolve(),
    unset: () => Promise.resolve(),
    mutate: () => Promise.resolve(),
  }
  const services = {
    slots: {
      inject(key, callback) {
        calls.slots.push(key)
        callback()
      },
      register(spec, component) {
        calls.registered = { spec, component }
      },
    },
    settingsScope: {
      bind() {
        calls.binds += 1
        return scope
      },
    },
    styles: { insert: () => () => {} },
  }
  const ctx = new Proxy(
    {
      get: (name) => (provided.includes(name) ? services[name] : undefined),
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
  return { ctx, calls, document }
}

// ── 4. Activation, with and without the services ──────────────────────────
for (const provided of [['slots', 'settingsScope'], ['slots'], ['settingsScope'], []]) {
  const label = provided.length === 0 ? 'no services' : provided.join('+')
  const { ctx, calls, document } = pageContext(provided)
  let thrown
  const previousDocument = globalThis.document
  globalThis.document = document
  try {
    mod.apply(ctx)
  } catch (error) {
    thrown = error
  } finally {
    globalThis.document = previousDocument
  }
  check(`apply() with ${label} does not throw`, thrown === undefined, thrown === undefined ? '' : thrown.message)
  check(`apply() with ${label} inserts a stylesheet`, calls.appended.length === 1, `${calls.appended.length} tag(s)`)
  if (calls.appended.length === 1) {
    const css = calls.appended[0].textContent
    check(`apply() with ${label} ships the card rule`, css.includes('.git-tool-tier{'))
    check(`apply() with ${label} ships the two-line rule`, css.includes('.git-tool-itemBody{display:flex'))
  }
  if (provided.includes('slots') && provided.includes('settingsScope')) {
    check(`apply() with ${label} watches settings.section`, calls.slots.includes('settings.section'), JSON.stringify(calls.slots))
    check(`apply() with ${label} binds the git-tool namespace`, calls.binds === 1, `binds=${calls.binds}`)
  }
}

// ── 5. The page component renders ─────────────────────────────────────────
{
  const { ctx, calls } = pageContext(['slots', 'settingsScope'])
  mod.apply(ctx)
  const element = calls.registered === null ? undefined : calls.registered.component({})
  check('registers a component when the slot ledger answers', element !== undefined)
  if (element !== undefined) {
    const Page = element.children[0].type
    let tree
    let thrown
    try {
      // A component throwing here is what a render-time ReferenceError looks
      // like, and it is how "host is not defined" reached a user.
      tree = Page({})
    } catch (error) {
      thrown = error
    }
    check('the page renders without throwing', thrown === undefined, thrown === undefined ? '' : thrown.message)
    const text = JSON.stringify(tree ?? {})
    check('the page names the operations', text.includes('status') && text.includes('git'), 'rendered page carries no operation list')
  }
}

console.log(failures.length === 0 ? '\nRESULT: the served bundle passes every check' : `\nRESULT: ${failures.length} check(s) FAILED`)
process.exit(failures.length === 0 ? 0 : 1)

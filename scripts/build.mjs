/**
 * Build step: emit `lib/` from `src/`.
 *
 * There is deliberately no bundler and no TypeScript here. The Host half is
 * plain ESM; the client half is a client module bundle written by hand. Both are
 * copied into place, and the client copy has ONE substitution applied:
 *
 *   `__GIT_TOOL_CATALOG__` is replaced with the catalog serialized from
 *   `src/git-catalog.js`.
 *
 * That substitution is what lets the browser half draw the real operation list
 * with NO runtime channel to the Host. Two attempts at reaching the Host from the
 * page failed in the field:
 *
 *  - a package-private RPC through a builtin that is not in a client bundle's
 *    scope ("host is not defined"), and
 *  - a `ctx.remote.*` service read, which needs the same service declaration
 *    that had already broken this plugin's load.
 *
 * Embedding has no runtime dependency at all, and the list is still generated
 * FROM the enforced catalog rather than hand-copied, so the page cannot offer an
 * operation the Host would refuse. It is a build-time snapshot: after editing
 * `src/git-catalog.js`, run this script (or `npm run build`) and reload the page.
 *
 *   node scripts/build.mjs
 *
 * @module dsh-plugin-git-tool/scripts/build
 */
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_CONFIG_POLICY,
  DEFAULT_ENABLED,
  DEFAULT_GUARD_POLICY,
  DEFAULT_PROTECTED_PATHS,
  describeCatalog,
} from '../src/git-catalog.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const lib = fileURLToPath(new URL('../lib/', import.meta.url))
mkdirSync(lib, { recursive: true })

/** The token `src/client.js` carries where the embedded catalog belongs. */
const TOKEN = '__GIT_TOOL_CATALOG__'

/** The token `src/client.js` carries where the build stamp belongs. */
const BUILD_TOKEN = '__GIT_TOOL_BUILD__'

/**
 * Identify this build.
 *
 * A page can keep an older bundle in memory until it is reloaded, which makes a
 * fixed bug look present. The stamp is shown on the page so the two can be told
 * apart without guessing.
 *
 * @param clientSource - the client source being written.
 * @returns a short, human-readable build id.
 */
function buildStamp(clientSource) {
  const digest = createHash('sha256').update(clientSource).digest('hex').slice(0, 8)
  const at = new Date().toISOString().replace('T', ' ').slice(0, 16)
  return `${at}Z/${digest}`
}

// Host half: copied verbatim. Its relative import of `./git-catalog.js` resolves
// beside it in `lib/`.
// Every host module the entry point imports has to be here: a missing one makes
// `lib/index.js` fail to load at activation.
for (const file of ['index.js', 'git-catalog.js', 'proxy.js']) {
  copyFileSync(`${root}src/${file}`, `${lib}${file}`)
}

/**
 * Count the operations in a serialized catalog, for the build report.
 * @param text - the serialized JSON.
 * @returns the number of operations it carries.
 */
function operationCount(text) {
  const payload = JSON.parse(text)
  return payload.catalog.reduce((total, tier) => total + tier.groups.reduce((n, group) => n + group.operations.length, 0), 0)
}

/**
 * Serialize the catalog for the browser half.
 *
 * It carries exactly what the settings page renders — the risk tiers with their
 * titles and hints, the operations with their display labels, and the default
 * allowlist — so the page needs no other source to draw itself.
 *
 * @returns the JSON text to embed.
 */
function serializeCatalog() {
  const payload = {
    catalog: describeCatalog(),
    defaults: {
      enabled: [...DEFAULT_ENABLED],
      approveMutating: true,
      dangerousKeyPolicy: DEFAULT_CONFIG_POLICY,
      useHostCredentials: false,
      nativeGitPolicy: DEFAULT_GUARD_POLICY,
      pathGuardPolicy: DEFAULT_GUARD_POLICY,
      protectedPaths: [...DEFAULT_PROTECTED_PATHS],
      proxyPort: 0,
      proxyCommand: '',
    },
  }
  // Escaped for embedding in a JavaScript source file: `<` and `>` keep the text
  // safe if the bundle is ever inlined into HTML, and the line/paragraph
  // separators are legal-but-surprising characters inside string literals.
  return JSON.stringify(payload)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
}

const clientSource = readFileSync(`${root}src/client.js`, 'utf8')
if (!clientSource.includes(TOKEN)) {
  throw new Error(`src/client.js does not carry the ${TOKEN} token, so the catalog cannot be embedded`)
}
if (!clientSource.includes(BUILD_TOKEN)) {
  throw new Error(`src/client.js does not carry the ${BUILD_TOKEN} token, so the build cannot be identified`)
}
const serialized = serializeCatalog()
const stamp = buildStamp(clientSource)
const client = clientSource.replaceAll(TOKEN, serialized).replaceAll(BUILD_TOKEN, JSON.stringify(stamp))
writeFileSync(`${lib}client.js`, client)

console.log(`built lib/index.js, lib/git-catalog.js, lib/client.js (${operationCount(serialized)} operations embedded, build ${stamp})`)

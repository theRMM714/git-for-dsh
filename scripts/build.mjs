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
 * @module git-for-dsh/scripts/build
 */
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_CONFIG_POLICY,
  DEFAULT_ENABLED,
  DEFAULT_GUARD_POLICY,
  DEFAULT_NATIVE_GIT_POLICY,
  DEFAULT_SSH_COMMAND,
  DEFAULT_SCRIPT_CHECK_POLICY,
  DEFAULT_PROTECTED_PATHS,
  describeCatalog,
} from '../src/git-catalog.js'

const root = fileURLToPath(new URL('..', import.meta.url))

/**
 * Where the build writes.
 *
 * `--out <dir>` exists so a verifier can rebuild into a temp directory and compare
 * against the committed `lib/` without touching it.
 */
const outIndex = process.argv.indexOf('--out')
const lib = outIndex === -1
  ? fileURLToPath(new URL('../lib/', import.meta.url))
  : fileURLToPath(new URL(process.argv[outIndex + 1].replace(/\/?$/, '/'), `file://${process.cwd()}/`))
mkdirSync(lib, { recursive: true })

/** The token `src/client.js` carries where the embedded catalog belongs. */
const TOKEN = '__GIT_TOOL_CATALOG__'

/** The token `src/client.js` carries where the build stamp belongs. */
const BUILD_TOKEN = '__GIT_TOOL_BUILD__'

/**
 * The token `src/client.js` carries where the package name belongs.
 *
 * The bundle registers itself under the PACKAGE NAME, so that id and
 * `package.json` must not be two copies of one string. A test asserts they agree.
 */
const PACKAGE_TOKEN = '__GIT_TOOL_PACKAGE__'

/** The package name, read from the manifest rather than restated here. */
const PACKAGE_NAME = JSON.parse(readFileSync(`${root}package.json`, 'utf8')).name

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
  // Content, not time: `lib/` is committed, so a rebuild of unchanged sources must
  // produce byte-identical output. A timestamp would dirty the tree on every test run
  // and make "is the committed bundle current?" unanswerable.
  return createHash('sha256').update(clientSource).digest('hex').slice(0, 12)
}

// Host half: copied verbatim. Its relative import of `./git-catalog.js` resolves
// beside it in `lib/`.
// Every host module the entry point imports has to be here: a missing one makes
// `lib/index.js` fail to load at activation.
for (const file of ['index.js', 'git-catalog.js', 'proxy.js', 'log.js']) {
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
      nativeGitPolicy: DEFAULT_NATIVE_GIT_POLICY,
      pathGuardPolicy: DEFAULT_GUARD_POLICY,
      protectedPaths: [...DEFAULT_PROTECTED_PATHS],
      scriptCheckPolicy: DEFAULT_SCRIPT_CHECK_POLICY,
      scanScripts: true,
      heartbeat: false,
      sshCommand: DEFAULT_SSH_COMMAND,
      pluginEnabled: true,
      logEnabled: true,
      logPath: '',
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
if (!clientSource.includes(PACKAGE_TOKEN)) {
  throw new Error(`src/client.js does not carry the ${PACKAGE_TOKEN} token, so the bundle would register under a name of its own`)
}
if (!clientSource.includes(BUILD_TOKEN)) {
  throw new Error(`src/client.js does not carry the ${BUILD_TOKEN} token, so the build cannot be identified`)
}
const serialized = serializeCatalog()
const stamp = buildStamp(clientSource)
const client = clientSource
  .replaceAll(TOKEN, serialized)
  .replaceAll(BUILD_TOKEN, JSON.stringify(stamp))
  .replaceAll(PACKAGE_TOKEN, JSON.stringify(PACKAGE_NAME))
writeFileSync(`${lib}client.js`, client)

console.log(`built lib/index.js, lib/git-catalog.js, lib/client.js (${operationCount(serialized)} operations embedded, build ${stamp})`)

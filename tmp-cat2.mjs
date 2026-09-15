import { readFileSync, writeFileSync } from 'node:fs'
const file = 'src/git-catalog.js'
const s = readFileSync(file, 'utf8')
// Boundary: from the script-reader doc to the doc of the NEXT block in file order
// (`isGitWord`), which is what keeps `invokesGit` and its helpers intact.
const startLine = s.indexOf(' * How much of a script the guard is willing to read.')
const endLine = s.indexOf(' * Whether one word is a command word for git.')
if (startLine === -1 || endLine === -1) { console.error('marker missing'); process.exit(1) }
const start = s.lastIndexOf('/**', startLine)
const end = s.lastIndexOf('/**', endLine)
if (start <= 0 || end <= start) { console.error('bounds invalid'); process.exit(1) }
const removed = s.slice(start, end)
for (const required of ['SCRIPT_SCAN_LIMIT_BYTES', 'findScriptTargets', 'readScriptText']) {
  if (!removed.includes(required)) { console.error('span does not contain ' + required); process.exit(1) }
}
for (const forbidden of ['invokesGit', 'isGitWord', 'DEFAULT_PROTECTED_PATHS', 'COMMAND_PREFIXES']) {
  if (removed.includes(forbidden)) { console.error('span would delete ' + forbidden); process.exit(1) }
}
const block = `/** Extensions that name a shell script. */
const SHELL_SCRIPT_EXTENSIONS = Object.freeze(['.sh', '.bash', '.zsh', '.ksh', '.dash', '.ash'])

/**
 * Whether a file being written is a shell script.
 *
 * Judged from the path AND from the content the call already carries — never from disk.
 * The guard runs in the DSH process on every tool call, so a filesystem read there trades
 * a stall risk (entry 29) for a heuristic, while the content arrives for free in the
 * arguments.
 *
 * @param filePath - the target path, as the call wrote it.
 * @param content - the text being written, when the tool provides one.
 * @returns true when this looks like a shell script.
 */
export function isShellScriptTarget(filePath, content) {
  if (typeof filePath === 'string') {
    const lower = filePath.toLowerCase()
    if (SHELL_SCRIPT_EXTENSIONS.some((extension) => lower.endsWith(extension))) return true
  }
  if (typeof content === 'string') {
    // A shebang identifies a script whatever it is named.
    const firstLine = content.slice(0, 200).split('\\n')[0] ?? ''
    if (/^#!.*\\b(sh|bash|zsh|ksh|dash|ash)\\b/.test(firstLine)) return true
  }
  return false
}

`
writeFileSync(file, s.slice(0, start) + block + s.slice(end))
console.log('catalog: replaced ' + removed.split('\n').length + ' lines with the predicate')

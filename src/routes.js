/**
 * The same-origin routes this plugin serves.
 *
 * Declared once because the two halves cannot import each other: the Host registers these
 * paths, the page fetches them, and `scripts/build.mjs` embeds this object into the client
 * bundle so the page never writes a path of its own. A route named on one side and not the
 * other is a control that silently does nothing, and no test would notice.
 *
 * Every generator is scoped to THIS plugin, which is what makes the paths collision-free.
 *
 * @module git-for-dsh/routes
 */

/** The route paths, keyed by what they answer. */
export const ROUTES = Object.freeze({
  /** Probes one port and reports whether something answers there. */
  proxyCheck: '/tool-git/proxy-check',
  /** Reports the configuration health and resets the section on POST. */
  configCheck: '/tool-git/config-check',
  /** Probes the configured ssh program. */
  sshCheck: '/tool-git/ssh-check',
  /** Serves the tail of the diagnostic log. */
  log: '/tool-git/log',
})

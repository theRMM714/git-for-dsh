#!/bin/sh
#
# A watchdog for the DSH process, deliberately living OUTSIDE it.
#
# Why it must be outside. When the harness wedges, it cannot rescue itself:
#
#   * the settings page is served by the wedged process, so a "restart" button there is dead
#     along with it;
#   * no in-process timer can help either — while a synchronous loop spins, nothing else on
#     the event loop runs. That is exactly how the freeze looked from the log, where the
#     heartbeat stopped dead;
#   * `kill -9` is the one signal a blocked event loop cannot ignore, because the kernel
#     handles it rather than JavaScript.
#
# So a second process is the only thing that can act. This is that process.
#
# The liveness probe is an HTTP request to DSH's own web server: the answer comes from the
# event loop, so a timed-out request means the loop is not running. It needs nothing from
# any plugin, which is why it still works when a plugin is the thing that wedged.
#
# Usage:
#   tools/watchdog.sh              watch, and report a stall
#   tools/watchdog.sh --restart    also kill the process and relaunch it
#
# Environment:
#   DSH_WATCH_URL       default http://127.0.0.1:3080/
#   DSH_WATCH_INTERVAL  default 5        seconds between probes
#   DSH_WATCH_FAILS     default 3        consecutive failed probes before acting
#   DSH_WATCH_TIMEOUT   default 3        seconds per probe
#   DSH_PATTERN         default 'dsh'     pgrep pattern of the process to kill
#   DSH_RESTART_CMD     no default        e.g. 'dsh web'; required by --restart
#
# Exits 0 if it ever reports a stall, 1 if it is stopped before that.

set -u

URL="${DSH_WATCH_URL:-http://127.0.0.1:3080/}"
INTERVAL="${DSH_WATCH_INTERVAL:-5}"
FAILS="${DSH_WATCH_FAILS:-3}"
TIMEOUT="${DSH_WATCH_TIMEOUT:-3}"
PATTERN="${DSH_PATTERN:-dsh}"
RESTART=0

for argument in "$@"; do
  case "$argument" in
    --restart) RESTART=1 ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "watchdog: unknown option '$argument'" >&2; exit 2 ;;
  esac
done

if ! command -v curl >/dev/null 2>&1; then
  echo "watchdog: curl is required" >&2
  exit 2
fi

if [ "$RESTART" -eq 1 ] && [ -z "${DSH_RESTART_CMD:-}" ]; then
  echo "watchdog: --restart needs DSH_RESTART_CMD, e.g. DSH_RESTART_CMD='dsh web'" >&2
  exit 2
fi

stamp() { date '+%Y-%m-%dT%H:%M:%S'; }

echo "watchdog: probing $URL every ${INTERVAL}s; ${FAILS} consecutive failures count as a stall"
echo "watchdog: process pattern '$PATTERN'; restart $([ "$RESTART" -eq 1 ] && echo enabled || echo disabled)"

failed=0
while :; do
  # -s silent, -o discard the body, -f fail on an HTTP error, -m bound the wait. A timeout
  # is the signal we care about: it means the event loop did not answer in time.
  if curl -s -o /dev/null -f -m "$TIMEOUT" "$URL" >/dev/null 2>&1; then
    failed=0
  else
    failed=$((failed + 1))
    echo "$(stamp) watchdog: probe failed (${failed}/${FAILS})"
    if [ "$failed" -ge "$FAILS" ]; then
      echo "$(stamp) watchdog: STALLED — ${URL} has not answered in ${TIMEOUT}s x ${FAILS}"
      if [ "$RESTART" -eq 0 ]; then
        echo "$(stamp) watchdog: not restarting (pass --restart and set DSH_RESTART_CMD to do that)"
        exit 0
      fi
      pids="$(pgrep -f "$PATTERN" 2>/dev/null | tr '\n' ' ')"
      echo "$(stamp) watchdog: killing ${pids:-<no match>}"
      # SIGKILL, not SIGTERM: a blocked event loop never gets to run a JavaScript signal
      # handler, so only the kernel-handled signal lands.
      for pid in $pids; do kill -9 "$pid" 2>/dev/null || true; done
      sleep 2
      echo "$(stamp) watchdog: relaunching: $DSH_RESTART_CMD"
      # Detached, so this watchdog survives its own restart and keeps watching.
      sh -c "$DSH_RESTART_CMD" >/dev/null 2>&1 &
      failed=0
    fi
  fi
  sleep "$INTERVAL"
done

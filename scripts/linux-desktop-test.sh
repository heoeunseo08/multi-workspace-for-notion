#!/usr/bin/env bash
# Runs the Linux credential store and confirmation dialog against a real GNOME Keyring and zenity on a virtual
# display. Needs: gnome-keyring libsecret-tools dbus-x11 xvfb zenity xdotool, and `npm ci` already run.
# Used by CI (.github/workflows/ci.yml) and locally:
#   docker run --rm -v "$PWD":/src:ro node:22-bookworm bash -c 'cp -r /src /work && cd /work && rm -rf node_modules &&
#     apt-get update -qq && apt-get install -y -qq gnome-keyring libsecret-tools dbus-x11 xvfb zenity xdotool &&
#     npm ci && bash scripts/linux-desktop-test.sh'
set -euo pipefail

Xvfb :99 -screen 0 1024x768x24 >/dev/null 2>&1 &
export DISPLAY=:99
sleep 2

dbus-run-session -- bash -euo pipefail -c '
  eval "$(gnome-keyring-daemon --start --components=secrets 2>/dev/null)"

  # The first store creates the default collection and asks for its password on screen; type one.
  ( for _ in $(seq 1 30); do
      sleep 1
      if xdotool search --onlyvisible --class gcr-prompter >/dev/null 2>&1; then
        xdotool type --delay 50 test; xdotool key Tab; xdotool type --delay 50 test; xdotool key Return; exit 0
      fi
    done ) &
  printf probe | secret-tool store --label=probe service mwn-probe account probe
  secret-tool clear service mwn-probe account probe

  echo "== credential store (Secret Service): long Korean value, overwrite, delete"
  MWN_TEST_SECRET_SERVICE=1 node --import tsx --test src/keychain.test.ts
  left=$(secret-tool search --all service multi-workspace-for-notion 2>/dev/null | grep -c "^\[" || true)
  [ "$left" = 0 ] || { echo "FAIL: $left items left behind"; exit 1; }

  echo "== confirmation dialog (zenity), under a non-UTF-8 locale on purpose"
  expect() {
    local keys=$1 want=$2 got
    ( for _ in $(seq 1 20); do
        sleep 1
        if xdotool search --onlyvisible --name "Multi-Workspace for Notion" >/dev/null 2>&1; then xdotool key $keys; exit 0; fi
      done ) &
    got=$(env -u LANG -u LC_ALL -u LC_CTYPE npx tsx scripts/try-dialog.ts "[$keys]" 2>/dev/null | tail -1)
    echo "$got"
    [[ "$got" == *"-> $want" ]] || { echo "FAIL: expected $want"; exit 1; }
    sleep 1
  }
  expect Escape declined
  expect Return declined
  expect "Tab Return" accepted

  got=$(env -u DISPLAY npx tsx scripts/try-dialog.ts "[no display]" 2>/dev/null | tail -1)
  echo "$got"
  [[ "$got" == *"-> unsupported" ]] || { echo "FAIL: expected unsupported"; exit 1; }
'
echo "PASS"

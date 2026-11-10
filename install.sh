#!/bin/sh
# Installs or updates alkuscode from wherever the Alkus server currently is.
#
#   curl -fsSL https://raw.githubusercontent.com/mont127/Weblink/main/install.sh | sh
#
# Everything is inside main(), called on the last line, so a cut-off download runs nothing.
set -eu
main() {
  # The first source is fresher; the second is the same file from GitHub's file servers.
  for source in "https://api.github.com/repos/mont127/Weblink/contents/address.txt" "https://raw.githubusercontent.com/mont127/Weblink/main/address.txt"; do
    url="$(curl -fsSL -m 20 -H 'Accept: application/vnd.github.raw+json' "$source" 2>/dev/null | head -n 1 | tr -d '\r\n ')" || continue
    case "$url" in https://*) ;; *) continue ;; esac
    case "$url" in *[!A-Za-z0-9.:/-]*) continue ;; esac
    if curl -fsS -m 20 -o /dev/null "$url/status" 2>/dev/null; then
      curl -fsSL "$url/install.sh" | sh
      return
    fi
  done
  echo "alkuscode install: the Alkus server cannot be reached right now. Try again in a few minutes." >&2
  exit 1
}
main "$@"

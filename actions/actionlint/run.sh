#!/usr/bin/env bash
# Run a checksum-verified actionlint release without requiring root on ARC.
#
# Merged from three independently-patched copies, one per consumer repository:
# each carried a fix the others lacked, and none carried all three. Kept here
# so the next fix lands once.
#
#   - portable checksum: some runner images ship `shasum` but not `sha256sum`
#   - a readable mismatch message rather than a bare non-zero exit
#   - suppression of one stale-schema diagnostic (see the -ignore below)
set -euo pipefail

version="1.7.12"
case "$(uname -m)" in
  x86_64)
    arch="amd64"
    checksum="8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8"
    ;;
  aarch64 | arm64)
    arch="arm64"
    checksum="325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6"
    ;;
  *)
    echo "::error::Unsupported runner architecture: $(uname -m)"
    exit 1
    ;;
esac

: "${RUNNER_TEMP:?RUNNER_TEMP must be set by GitHub Actions}"

archive="actionlint_${version}_linux_${arch}.tar.gz"
download="${RUNNER_TEMP}/${archive}"
extract_dir="${RUNNER_TEMP}/actionlint-${version}"

curl --fail --silent --show-error --location --retry 3 \
  "https://github.com/rhysd/actionlint/releases/download/v${version}/${archive}" \
  --output "$download"

# Not `sha256sum --check`: it is missing from some runner images, and its
# failure output does not say what it actually got.
if command -v sha256sum >/dev/null 2>&1; then
  actual_checksum="$(sha256sum "$download" | awk '{print $1}')"
else
  actual_checksum="$(shasum -a 256 "$download" | awk '{print $1}')"
fi
if [ "$actual_checksum" != "$checksum" ]; then
  echo "::error::actionlint checksum mismatch"
  echo "expected: $checksum"
  echo "actual:   $actual_checksum"
  exit 1
fi

mkdir -p "$extract_dir"
tar -xzf "$download" -C "$extract_dir"

# actionlint 1.7.12 predates GitHub's May 2026 `concurrency.queue` schema and
# reports it as an unknown key. Suppressing exactly that message is safe: it is
# a stale-schema false positive, and the pattern is a no-op in a repository
# that does not use `queue:`. Drop this when the pin moves past 1.7.12.
"$extract_dir/actionlint" \
  -ignore 'unexpected key "queue" for "concurrency" section' \
  "$@"

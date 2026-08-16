#!/bin/sh
# shellcheck shell=sh
#
# Infinia Harness — one-command installer for fleetsmith (OSS) and
# fleetsmith-ee (Enterprise Edition, the Intelligence Grid).
#
#   curl -fsSL https://infinia-harness.adid.dev/install.sh | sh
#
# Every decision this script makes can be answered three ways, in this order:
#
#   1. An environment variable          FLEETSMITH_EDITION=ee sh install.sh
#   2. A command-line flag              sh install.sh --edition ee
#   3. A question, with a safe default  [press enter to accept]
#
# When there is no terminal to ask on — a pipeline, CI, a Dockerfile — every
# question silently takes its default and the run is fully non-interactive.
# The defaults are chosen so that the no-input path always produces a working
# OSS install and never touches anything outside $HOME.
#
# POSIX sh on purpose: this runs under bash on macOS, dash on Debian/Ubuntu,
# and busybox ash in containers. No bashisms, no arrays, no [[ ]].

set -eu

VERSION="1.0.0"
FS_REPO="subhransusekhar/fleetsmith"
FS_RELEASES="https://github.com/${FS_REPO}/releases"
SITE="https://infinia-harness.adid.dev"

# ─────────────────────────────────────────────────────────────────────────────
# output
# ─────────────────────────────────────────────────────────────────────────────

if [ -t 1 ] && [ "${NO_COLOR:-}" = "" ] && [ "${TERM:-dumb}" != "dumb" ]; then
  C_RESET=$(printf '\033[0m'); C_BOLD=$(printf '\033[1m'); C_DIM=$(printf '\033[2m')
  C_BLUE=$(printf '\033[38;5;33m'); C_GREEN=$(printf '\033[38;5;35m')
  C_YELLOW=$(printf '\033[38;5;178m'); C_RED=$(printf '\033[38;5;167m')
else
  C_RESET=''; C_BOLD=''; C_DIM=''; C_BLUE=''; C_GREEN=''; C_YELLOW=''; C_RED=''
fi

say()  { printf '%s\n' "$*"; }
step() { printf '\n%s==>%s %s%s%s\n' "$C_BLUE" "$C_RESET" "$C_BOLD" "$*" "$C_RESET"; }
ok()   { printf '  %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
info() { printf '  %s·%s %s\n' "$C_DIM" "$C_RESET" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()  { printf '\n%serror:%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

banner() {
  printf '\n'
  printf '  %s%sINFINIA%s\n' "$C_BOLD" "$C_BLUE" "$C_RESET"
  printf '  %sH a r n e s s%s   %sfleetsmith installer v%s%s\n' "$C_BOLD" "$C_RESET" "$C_DIM" "$VERSION" "$C_RESET"
  printf '\n'
}

# ─────────────────────────────────────────────────────────────────────────────
# asking
#
# Under `curl | sh` stdin is the script itself, so a prompt must be read from
# the controlling terminal directly. If there is no such terminal we are
# non-interactive by definition and every answer is its default.
# ─────────────────────────────────────────────────────────────────────────────

INTERACTIVE=no
if [ "${FLEETSMITH_NONINTERACTIVE:-}" = "" ] && [ -r /dev/tty ] && [ -w /dev/tty ]; then
  INTERACTIVE=yes
fi

# ask <var-name> <prompt> <default> [hint]
# Uses the value already in <var-name> if it is set and non-empty (env or flag
# wins), otherwise asks, otherwise falls back to <default>.
ask() {
  ask_var=$1; ask_prompt=$2; ask_default=$3; ask_hint=${4:-}
  eval "ask_cur=\${$ask_var:-}"
  if [ -n "$ask_cur" ]; then
    info "$ask_prompt: $ask_cur ${C_DIM}(preset)${C_RESET}"
    return 0
  fi
  if [ "$INTERACTIVE" = no ] || [ "$ASSUME_YES" = yes ]; then
    eval "$ask_var=\$ask_default"
    info "$ask_prompt: $ask_default ${C_DIM}(default)${C_RESET}"
    return 0
  fi
  if [ -n "$ask_hint" ]; then
    printf '  %s%s%s\n' "$C_DIM" "$ask_hint" "$C_RESET" > /dev/tty
  fi
  printf '  %s [%s]: ' "$ask_prompt" "$ask_default" > /dev/tty
  IFS= read -r ask_reply < /dev/tty || ask_reply=''
  [ -n "$ask_reply" ] || ask_reply=$ask_default
  eval "$ask_var=\$ask_reply"
}

# ask_yn <var-name> <prompt> <default: yes|no>
ask_yn() {
  ask "$1" "$2" "$3"
  eval "yn_val=\$$1"
  case $(lower "$yn_val") in
    y|yes|true|1) eval "$1=yes" ;;
    n|no|false|0) eval "$1=no" ;;
    *) die "answer '$yn_val' for $1 is not yes or no" ;;
  esac
}

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
have()  { command -v "$1" >/dev/null 2>&1; }

# ─────────────────────────────────────────────────────────────────────────────
# settings — every one of these is an environment variable
# ─────────────────────────────────────────────────────────────────────────────

EDITION=${FLEETSMITH_EDITION:-}                 # oss | ee
FS_VERSION=${FLEETSMITH_VERSION:-}              # latest | 0.7.0 | …
METHOD=${FLEETSMITH_METHOD:-}                   # auto | npm | binary
PREFIX=${FLEETSMITH_PREFIX:-}                   # where the standalone binary lands
CORTEX=${FLEETSMITH_CORTEX:-}                   # auto | docker | binary | existing | none
RELATA_IMAGE=${RELATA_IMAGE:-openworkbench/relata-db:v2.0.0}
RELATA_PORT=${RELATA_PORT:-9090}
RELATA_CONTAINER=${RELATA_CONTAINER:-relata}
RELATA_DATA=${RELATA_DATA:-$HOME/.relata}
RELATA_PROFILE=${RELATA_PROFILE:-free}
RELATA_URL=${RELATA_URL:-}
RELATA_TOKEN=${RELATA_TOKEN:-}
FLEETSMITH_ACTOR=${FLEETSMITH_ACTOR:-}
SCAFFOLD=${FLEETSMITH_SCAFFOLD:-}               # yes | no — copy the meta-fleet into a project
PROJECT_DIR=${FLEETSMITH_PROJECT_DIR:-$PWD}
ENV_FILE=${FLEETSMITH_ENV_FILE:-$HOME/.fleetsmith/env.sh}
SHELL_RC=${FLEETSMITH_SHELL_RC:-}               # yes | no — source the env file from your shell rc
ASSUME_YES=${FLEETSMITH_ASSUME_YES:-no}
DRY_RUN=${FLEETSMITH_DRY_RUN:-no}
UNINSTALL=no

# ─────────────────────────────────────────────────────────────────────────────
# flags
# ─────────────────────────────────────────────────────────────────────────────

usage() {
  cat <<USAGE
Infinia Harness installer v${VERSION}

  curl -fsSL ${SITE}/install.sh | sh
  curl -fsSL ${SITE}/install.sh | sh -s -- --edition ee --yes

Flags (each mirrors an environment variable):

  --edition oss|ee        FLEETSMITH_EDITION      which edition to install
  --version <v>           FLEETSMITH_VERSION      latest (default) or e.g. 0.7.0
  --method auto|npm|binary FLEETSMITH_METHOD      how to install the CLI
  --prefix <dir>          FLEETSMITH_PREFIX       binary install dir
  --cortex auto|docker|binary|existing|none
                          FLEETSMITH_CORTEX       RelataDB cortex for the ee grid
                                                  (binary = private release via gh)
  --relata-url <url>      RELATA_URL              an existing cortex to point at
  --relata-token <tok>    RELATA_TOKEN            bearer token for that cortex
  --relata-image <ref>    RELATA_IMAGE            default ${RELATA_IMAGE}
  --relata-port <n>       RELATA_PORT             default 9090
  --actor <name>          FLEETSMITH_ACTOR        your identity on the grid
  --scaffold / --no-scaffold
                          FLEETSMITH_SCAFFOLD     install the meta-fleet into a project
  --project-dir <dir>     FLEETSMITH_PROJECT_DIR  where to scaffold (default: cwd)
  --env-file <path>       FLEETSMITH_ENV_FILE     default ~/.fleetsmith/env.sh
  --yes, -y               FLEETSMITH_ASSUME_YES   accept every default, ask nothing
  --dry-run               FLEETSMITH_DRY_RUN      print what would happen, change nothing
  --uninstall             remove what this installer installed
  --help, -h              this text

Full reference: ${SITE}/quickstart#env
USAGE
}

while [ $# -gt 0 ]; do
  case $1 in
    --edition)       EDITION=${2:?--edition needs a value}; shift 2 ;;
    --version)       FS_VERSION=${2:?--version needs a value}; shift 2 ;;
    --method)        METHOD=${2:?--method needs a value}; shift 2 ;;
    --prefix)        PREFIX=${2:?--prefix needs a value}; shift 2 ;;
    --cortex)        CORTEX=${2:?--cortex needs a value}; shift 2 ;;
    --relata-url)    RELATA_URL=${2:?--relata-url needs a value}; shift 2 ;;
    --relata-token)  RELATA_TOKEN=${2:?--relata-token needs a value}; shift 2 ;;
    --relata-image)  RELATA_IMAGE=${2:?--relata-image needs a value}; shift 2 ;;
    --relata-port)   RELATA_PORT=${2:?--relata-port needs a value}; shift 2 ;;
    --actor)         FLEETSMITH_ACTOR=${2:?--actor needs a value}; shift 2 ;;
    --project-dir)   PROJECT_DIR=${2:?--project-dir needs a value}; shift 2 ;;
    --env-file)      ENV_FILE=${2:?--env-file needs a value}; shift 2 ;;
    --scaffold)      SCAFFOLD=yes; shift ;;
    --no-scaffold)   SCAFFOLD=no; shift ;;
    --no-cortex)     CORTEX=none; shift ;;
    -y|--yes)        ASSUME_YES=yes; shift ;;
    --dry-run)       DRY_RUN=yes; shift ;;
    --uninstall)     UNINSTALL=yes; shift ;;
    -h|--help)       usage; exit 0 ;;
    *)               die "unknown flag: $1 (try --help)" ;;
  esac
done

run() {
  if [ "$DRY_RUN" = yes ]; then
    printf '  %s$ %s%s\n' "$C_DIM" "$*" "$C_RESET"
    return 0
  fi
  "$@"
}

# ─────────────────────────────────────────────────────────────────────────────
# platform
# ─────────────────────────────────────────────────────────────────────────────

detect_platform() {
  OS=$(uname -s 2>/dev/null || echo unknown)
  ARCH=$(uname -m 2>/dev/null || echo unknown)
  case $OS in
    Darwin) PLATFORM=macos ;;
    Linux)  PLATFORM=linux ;;
    MINGW*|MSYS*|CYGWIN*)
      PLATFORM=windows
      warn "Windows detected. fleetsmith itself runs fine here, but RelataDB is"
      warn "macOS/Linux only — use Docker Desktop or WSL2 for the ee cortex."
      ;;
    *) die "unsupported operating system: $OS" ;;
  esac
  case $ARCH in
    x86_64|amd64) GOARCH=x64 ;;
    arm64|aarch64) GOARCH=arm64 ;;
    *) GOARCH=unknown ;;
  esac
}

node_major() {
  have node || { echo 0; return; }
  node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

npm_prefix_writable() {
  have npm || return 1
  np=$(npm prefix -g 2>/dev/null) || return 1
  [ -n "$np" ] || return 1
  # The bin dir is what actually gets written; it may not exist yet.
  [ -w "$np" ] || [ -w "$np/lib" ] || return 1
  return 0
}

docker_ready() {
  have docker || return 1
  docker info >/dev/null 2>&1 || return 1
  return 0
}

random_token() {
  if have openssl; then
    openssl rand -hex 24
  elif [ -r /dev/urandom ]; then
    LC_ALL=C tr -dc 'a-f0-9' < /dev/urandom 2>/dev/null | dd bs=48 count=1 2>/dev/null
  else
    # Last resort. Weak, and said so out loud rather than pretended otherwise.
    warn "no openssl and no /dev/urandom — generating a low-entropy token"
    printf 'fs%s%s' "$(date +%s)" "$$"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# uninstall
# ─────────────────────────────────────────────────────────────────────────────

do_uninstall() {
  banner
  step "Uninstalling"
  if have npm; then
    npm ls -g --depth 0 fleetsmith-ee >/dev/null 2>&1 && run npm uninstall -g fleetsmith-ee && ok "removed fleetsmith-ee (npm)" || true
    npm ls -g --depth 0 fleetsmith    >/dev/null 2>&1 && run npm uninstall -g fleetsmith    && ok "removed fleetsmith (npm)"    || true
  fi
  for d in "${PREFIX:-$HOME/.local/bin}" "$HOME/.local/bin" /usr/local/bin; do
    if [ -f "$d/fleetsmith" ]; then run rm -f "$d/fleetsmith" && ok "removed $d/fleetsmith"; fi
  done
  if docker_ready && docker ps -a --format '{{.Names}}' | grep -qx "$RELATA_CONTAINER"; then
    run docker rm -f "$RELATA_CONTAINER" >/dev/null && ok "removed container $RELATA_CONTAINER"
    info "your cortex data in $RELATA_DATA was left alone — delete it yourself if you want it gone"
  fi
  [ -f "$ENV_FILE" ] && run rm -f "$ENV_FILE" && ok "removed $ENV_FILE" || true
  say ""
  ok "Done. Any '. $ENV_FILE' line in your shell rc is now a no-op — remove it at your leisure."
  exit 0
}

# ─────────────────────────────────────────────────────────────────────────────
# install steps
# ─────────────────────────────────────────────────────────────────────────────

resolve_method() {
  NODE_MAJOR=$(node_major)
  case $(lower "$METHOD") in
    npm)
      [ "$NODE_MAJOR" -ge 18 ] 2>/dev/null || die "--method npm needs Node.js >= 18 (found: ${NODE_MAJOR:-none}). Try --method binary."
      METHOD=npm ;;
    binary)
      METHOD=binary ;;
    auto|'')
      if [ "$NODE_MAJOR" -ge 18 ] 2>/dev/null && have npm; then METHOD=npm; else METHOD=binary; fi ;;
    *) die "--method must be auto, npm or binary (got: $METHOD)" ;;
  esac

  # The ee package is a normal npm package that core discovers by module
  # resolution. There is no way to graft it onto the standalone binary, so an
  # ee install implies the npm method rather than silently installing an OSS
  # CLI that can never see it.
  if [ "$EDITION" = ee ] && [ "$METHOD" = binary ]; then
    if ! { [ "$NODE_MAJOR" -ge 18 ] 2>/dev/null && have npm; }; then
      die "the Enterprise Edition needs Node.js >= 18 and npm (found Node ${NODE_MAJOR:-none}).
       Install Node 18+ and re-run, or install the OSS edition with --edition oss."
    fi
    warn "ee requested — switching from the standalone binary to npm, which is the only way core can load it"
    METHOD=npm
  fi
}

install_npm() {
  spec="fleetsmith"
  [ "$FS_VERSION" = latest ] || spec="fleetsmith@$FS_VERSION"

  NPM_SUDO=''
  if ! npm_prefix_writable; then
    if have sudo && [ "$INTERACTIVE" = yes ]; then
      warn "the global npm prefix ($(npm prefix -g 2>/dev/null)) is not writable — using sudo"
      NPM_SUDO=sudo
    else
      # Never sudo silently in a pipeline. Redirect npm at a user-owned prefix
      # instead: no privileges needed and nothing outside $HOME is touched.
      NPM_USER_PREFIX=$HOME/.npm-global
      warn "global npm prefix is not writable — installing into $NPM_USER_PREFIX instead"
      run mkdir -p "$NPM_USER_PREFIX"
      NPM_CONFIG_PREFIX=$NPM_USER_PREFIX
      export NPM_CONFIG_PREFIX
      BIN_DIR=$NPM_USER_PREFIX/bin
    fi
  fi

  info "npm install -g $spec"
  run ${NPM_SUDO:+sudo} npm install -g "$spec" >/dev/null 2>&1 \
    || die "npm install -g $spec failed. Re-run with --method binary, or run the npm command yourself to see the error."
  ok "fleetsmith installed"

  if [ "$EDITION" = ee ]; then
    eespec="fleetsmith-ee"
    [ "$FS_VERSION" = latest ] || eespec="fleetsmith-ee@$FS_VERSION"
    info "npm install -g $eespec"
    run ${NPM_SUDO:+sudo} npm install -g "$eespec" >/dev/null 2>&1 \
      || die "npm install -g $eespec failed."
    ok "fleetsmith-ee installed (AGPL-3.0-only)"
  fi

  [ -n "${BIN_DIR:-}" ] || BIN_DIR=$(npm prefix -g 2>/dev/null)/bin
}

install_binary() {
  case $PLATFORM in
    macos)   asset="fleetsmith-macos-$GOARCH" ;;
    linux)   asset="fleetsmith-linux-x64" ;;
    windows) asset="fleetsmith-windows-x64.exe" ;;
    *) die "no standalone binary for $PLATFORM" ;;
  esac
  [ "$GOARCH" != unknown ] || die "unrecognised CPU architecture ($ARCH) — install with --method npm instead"
  if [ "$PLATFORM" = linux ] && [ "$GOARCH" != x64 ]; then
    die "the Linux release ships x64 only (this machine is $ARCH) — install with --method npm instead"
  fi

  if [ "$FS_VERSION" = latest ]; then
    url="$FS_RELEASES/latest/download/$asset"
  else
    url="$FS_RELEASES/download/v${FS_VERSION#v}/$asset"
  fi

  BIN_DIR=$PREFIX
  run mkdir -p "$BIN_DIR"
  info "downloading $asset"
  tmp="${TMPDIR:-/tmp}/fleetsmith.$$"
  if [ "$DRY_RUN" = yes ]; then
    printf '  %s$ curl -fsSL %s -o %s/fleetsmith%s\n' "$C_DIM" "$url" "$BIN_DIR" "$C_RESET"
  else
    curl -fsSL "$url" -o "$tmp" || die "download failed: $url"
    chmod +x "$tmp"
    mv "$tmp" "$BIN_DIR/fleetsmith"
  fi
  ok "fleetsmith installed to $BIN_DIR/fleetsmith"

  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) warn "$BIN_DIR is not on your PATH — the env file below adds it" ;;
  esac
}

start_cortex_docker() {
  docker_ready || die "Docker is not running. Start Docker and re-run, or use --cortex none."

  if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$RELATA_CONTAINER"; then
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$RELATA_CONTAINER"; then
      ok "container '$RELATA_CONTAINER' is already running — reusing it"
    else
      info "starting existing container '$RELATA_CONTAINER'"
      run docker start "$RELATA_CONTAINER" >/dev/null
      ok "container '$RELATA_CONTAINER' started"
    fi
    RELATA_URL="http://127.0.0.1:$RELATA_PORT"
    if [ -z "$RELATA_TOKEN" ]; then
      RELATA_TOKEN=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$RELATA_CONTAINER" 2>/dev/null \
        | sed -n 's/^RELATA_BEARER_TOKEN=//p' | head -n1 || true)
      if [ -n "$RELATA_TOKEN" ]; then
        info "recovered the bearer token from the running container"
      else
        warn "could not recover the container's bearer token — set RELATA_TOKEN yourself"
      fi
    fi
    return 0
  fi

  [ -n "$RELATA_TOKEN" ] || RELATA_TOKEN=$(random_token)

  info "pulling $RELATA_IMAGE"
  run docker pull "$RELATA_IMAGE" >/dev/null 2>&1 || die \
"could not pull $RELATA_IMAGE.
       Docker Hub's openworkbench/relata-db is the public image; ghcr.io/relatadb/relata is access-gated.
       Check connectivity, or re-run with --cortex none — the ee grid degrades to the file backend."
  run mkdir -p "$RELATA_DATA"
  info "starting the cortex on port $RELATA_PORT"
  run docker run -d \
    --name "$RELATA_CONTAINER" \
    --restart unless-stopped \
    -p "$RELATA_PORT:9090" \
    -v "$RELATA_DATA:/data" \
    -e "RELATA_PROFILE=$RELATA_PROFILE" \
    -e "RELATA_BEARER_TOKEN=$RELATA_TOKEN" \
    "$RELATA_IMAGE" >/dev/null || die "docker run failed — inspect with: docker logs $RELATA_CONTAINER"

  RELATA_URL="http://127.0.0.1:$RELATA_PORT"

  if [ "$DRY_RUN" = yes ]; then return 0; fi
  info "waiting for the cortex to answer /health"
  i=0
  while [ "$i" -lt 45 ]; do
    if curl -fsS -m 2 "$RELATA_URL/health" >/dev/null 2>&1; then
      ok "cortex healthy at $RELATA_URL"
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done
  warn "the cortex did not answer /health within 45s — it may still be starting"
  warn "check with: docker logs $RELATA_CONTAINER"
}

# The GitHub release path.
#
# `relatadb/RelataDB` is a PRIVATE repository (verified 2026-08-16): the v2.0.0
# release and its signed tarballs are real, but unauthenticated `curl` gets a
# 404, so there is no public download URL to offer. Anyone who has been granted
# access can still fetch it through an authenticated `gh`, which is exactly what
# this does — and if `gh` is missing or unauthorised it says so and points at
# Docker rather than retrying a URL that cannot work.
start_cortex_binary() {
  have gh || die \
"--cortex binary needs the GitHub CLI: relatadb/RelataDB is a private repository and
       has no public download URL. Install gh and \`gh auth login\` with an account that has
       access, or use --cortex docker (openworkbench/relata-db is public)."
  gh auth status >/dev/null 2>&1 || die "gh is installed but not authenticated — run: gh auth login"

  case "$PLATFORM/$GOARCH" in
    macos/arm64) triple=aarch64-apple-darwin ;;
    linux/x64)   triple=x86_64-unknown-linux-gnu ;;
    *) die "the v2.0.0 release ships macOS arm64 and Linux x64 only (this machine is $PLATFORM/$GOARCH). Use --cortex docker." ;;
  esac
  tarball="relata-2.0.0-$triple.tar.gz"

  BIN_DIR_RELATA=${PREFIX:-$HOME/.local/bin}
  run mkdir -p "$BIN_DIR_RELATA"
  work="${TMPDIR:-/tmp}/relata-dl.$$"
  run mkdir -p "$work"

  info "downloading $tarball from the private release"
  if [ "$DRY_RUN" = yes ]; then
    printf '  %s$ gh release download v2.0.0 -R relatadb/RelataDB -p %s%s\n' "$C_DIM" "$tarball" "$C_RESET"
  else
    gh release download v2.0.0 -R relatadb/RelataDB \
      -p "$tarball" -p "$tarball.sha256" -D "$work" --clobber >/dev/null 2>&1 \
      || { rm -rf "$work"; die "download failed — check that your GitHub account has access to relatadb/RelataDB"; }

    # The release publishes checksums; a downloaded server binary is exactly the
    # kind of thing to verify rather than trust.
    if [ -f "$work/$tarball.sha256" ] && have shasum; then
      expected=$(awk '{print $1}' "$work/$tarball.sha256")
      actual=$(shasum -a 256 "$work/$tarball" | awk '{print $1}')
      if [ "$expected" != "$actual" ]; then
        rm -rf "$work"
        die "SHA256 mismatch for $tarball — expected $expected, got $actual. Not installing."
      fi
      ok "SHA256 verified"
    else
      warn "could not verify the checksum (no .sha256 asset or no shasum command)"
    fi

    tar -xzf "$work/$tarball" -C "$work" || { rm -rf "$work"; die "could not extract $tarball"; }
    found=$(find "$work" -type f -name relata -perm -u+x 2>/dev/null | head -n1)
    [ -n "$found" ] || { rm -rf "$work"; die "no 'relata' executable inside $tarball"; }
    mv "$found" "$BIN_DIR_RELATA/relata"
    chmod +x "$BIN_DIR_RELATA/relata"
    rm -rf "$work"
  fi
  ok "relata 2.0.0 installed to $BIN_DIR_RELATA/relata"

  [ -n "$RELATA_TOKEN" ] || RELATA_TOKEN=$(random_token)
  RELATA_URL="http://127.0.0.1:$RELATA_PORT"
  relata_log=$HOME/.relata/serve.log
  run mkdir -p "$RELATA_DATA"

  info "starting relata serve (log: $relata_log)"
  if [ "$DRY_RUN" = yes ]; then
    printf '  %s$ RELATA_BEARER_TOKEN=… %s/relata serve%s\n' "$C_DIM" "$BIN_DIR_RELATA" "$C_RESET"
    return 0
  fi
  if curl -fsS -m 2 "$RELATA_URL/health" >/dev/null 2>&1; then
    ok "something is already serving $RELATA_URL — reusing it"
    return 0
  fi
  RELATA_BEARER_TOKEN=$RELATA_TOKEN nohup "$BIN_DIR_RELATA/relata" serve \
    >"$relata_log" 2>&1 &
  i=0
  while [ "$i" -lt 45 ]; do
    if curl -fsS -m 2 "$RELATA_URL/health" >/dev/null 2>&1; then
      ok "cortex healthy at $RELATA_URL"
      info "stop it with: pkill -f '$BIN_DIR_RELATA/relata serve'"
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done
  warn "the cortex did not answer /health within 45s — see $relata_log"
  warn "a fresh v2.0.0 node starts its own 30-day trial; an existing v1.x ~/.relata will NOT"
  warn "carry its license forward and the node may refuse to start against it"
}

verify_existing_cortex() {
  [ -n "$RELATA_URL" ] || die "--cortex existing needs RELATA_URL (and normally RELATA_TOKEN)"
  if curl -fsS -m 5 "$RELATA_URL/health" >/dev/null 2>&1; then
    ok "cortex reachable at $RELATA_URL"
  else
    warn "no /health response from $RELATA_URL — saving the config anyway"
    warn "fleetsmith degrades to the file backend when the cortex is unreachable, so this is not fatal"
  fi
}

write_env_file() {
  env_dir=$(dirname "$ENV_FILE")
  run mkdir -p "$env_dir"
  if [ "$DRY_RUN" = yes ]; then
    printf '  %s$ write %s%s\n' "$C_DIM" "$ENV_FILE" "$C_RESET"
    return 0
  fi
  umask 077
  {
    echo "# Infinia Harness — written by install.sh v$VERSION on $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "# Re-runnable: this file is rewritten by every install. Source it from your shell rc:"
    echo "#   . $ENV_FILE"
    echo ""
    if [ -n "${BIN_DIR:-}" ]; then
      echo "case \":\$PATH:\" in *\":$BIN_DIR:\"*) ;; *) PATH=\"$BIN_DIR:\$PATH\" ;; esac"
      echo "export PATH"
      echo ""
    fi
    echo "export FLEETSMITH_ACTOR='$FLEETSMITH_ACTOR'"
    if [ "$EDITION" = ee ] && [ -n "$RELATA_URL" ]; then
      echo ""
      echo "# The Intelligence Grid. Unset both and fleetsmith behaves exactly like OSS."
      echo "export RELATA_URL='$RELATA_URL'"
      echo "export RELATA_TOKEN='$RELATA_TOKEN'"
    fi
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ok "wrote $ENV_FILE (mode 600 — it holds your cortex token)"
}

maybe_wire_shell_rc() {
  [ "$SHELL_RC" = yes ] || return 0
  rc=''
  case $(basename "${SHELL:-/bin/sh}") in
    zsh)  rc=$HOME/.zshrc ;;
    bash) [ -f "$HOME/.bashrc" ] && rc=$HOME/.bashrc || rc=$HOME/.bash_profile ;;
    fish) warn "fish is not POSIX — add the exports from $ENV_FILE to config.fish yourself"; return 0 ;;
    *)    rc=$HOME/.profile ;;
  esac
  line=". $ENV_FILE"
  if [ -f "$rc" ] && grep -qF "$line" "$rc" 2>/dev/null; then
    ok "$rc already sources the env file"
    return 0
  fi
  if [ "$DRY_RUN" = yes ]; then
    printf '  %s$ append "%s" to %s%s\n' "$C_DIM" "$line" "$rc" "$C_RESET"
    return 0
  fi
  printf '\n# Infinia Harness\n%s\n' "$line" >> "$rc"
  ok "appended to $rc"
}

scaffold_project() {
  [ "$SCAFFOLD" = yes ] || return 0
  [ -d "$PROJECT_DIR" ] || die "--project-dir $PROJECT_DIR does not exist"
  if [ -e "$PROJECT_DIR/.claude" ]; then
    warn "$PROJECT_DIR/.claude already exists — leaving it untouched"
    warn "delete it first if you want the bundled meta-fleet instead"
    return 0
  fi
  have git || { warn "git not found — skipping the meta-fleet scaffold"; return 0; }
  info "installing the meta-fleet into $PROJECT_DIR/.claude"
  if [ "$DRY_RUN" = yes ]; then
    printf '  %s$ git clone --depth 1 https://github.com/%s → .claude%s\n' "$C_DIM" "$FS_REPO" "$C_RESET"
    return 0
  fi
  tmpc="${TMPDIR:-/tmp}/fleetsmith-src.$$"
  rm -rf "$tmpc"
  if git clone --depth 1 --quiet "https://github.com/$FS_REPO" "$tmpc" 2>/dev/null; then
    cp -R "$tmpc/.claude" "$PROJECT_DIR/.claude"
    rm -rf "$tmpc"
    ok "meta-fleet installed — restart Claude Code in $PROJECT_DIR to load it"
    warn "project hooks stay inert until you accept Claude Code's 'trust this folder' dialog;"
    warn "until then the handover gate is advisory only"
  else
    rm -rf "$tmpc"
    warn "clone failed — skipping the scaffold. You can do it by hand later; see $SITE/quickstart"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# main
# ─────────────────────────────────────────────────────────────────────────────

[ "$UNINSTALL" = yes ] && do_uninstall

banner
detect_platform
have curl || die "curl is required and was not found"

[ "$DRY_RUN" = yes ] && warn "dry run — nothing will be installed or changed"
[ "$INTERACTIVE" = yes ] || info "no terminal attached — every question takes its default"

step "1/5  What to install"
ask EDITION "Edition (oss or ee)" "oss" \
  "oss = fleetsmith, MIT, complete on its own.  ee = adds the Intelligence Grid (AGPL-3.0-only, needs a RelataDB cortex)."
EDITION=$(lower "$EDITION")
case $EDITION in oss|ee) ;; *) die "--edition must be oss or ee (got: $EDITION)" ;; esac

ask FS_VERSION "Version" "latest"
resolve_method
info "install method: $METHOD"
[ "$METHOD" = binary ] && ask PREFIX "Install directory" "$HOME/.local/bin"

step "2/5  Installing the CLI"
if [ "$METHOD" = npm ]; then install_npm; else install_binary; fi

step "3/5  Identity"
if [ -z "$FLEETSMITH_ACTOR" ]; then
  guess=$(git config --get user.email 2>/dev/null | cut -d@ -f1 || true)
  [ -n "$guess" ] || guess=${USER:-${LOGNAME:-developer}}
fi
ask FLEETSMITH_ACTOR "Your name on the grid" "${guess:-developer}" \
  "How your work is labelled for teammates. Local-only in the OSS edition."

step "4/5  The cortex (RelataDB)"
if [ "$EDITION" = oss ]; then
  CORTEX=none
  info "OSS edition — no cortex needed. Memory is files plus git, and that is the supported answer forever."
else
  # The derived value is the *default* offered, not an answer already given —
  # keeping it in a separate variable is what lets the question still be asked.
  if [ -n "$RELATA_URL" ]; then cortex_default=existing
  elif docker_ready;       then cortex_default=docker
  else                          cortex_default=none
  fi
  ask CORTEX "Cortex (docker, binary, existing, or none)" "$cortex_default" \
    "docker   = run $RELATA_IMAGE locally on port $RELATA_PORT
   binary   = the signed v2.0.0 release tarball (private repo — needs an authorised gh)
   existing = point at a cortex someone already runs (needs RELATA_URL)
   none     = install ee now, wire the grid later; it degrades to the file backend"
  case $(lower "$CORTEX") in
    docker)   CORTEX=docker;   start_cortex_docker ;;
    binary)   CORTEX=binary;   start_cortex_binary ;;
    existing) CORTEX=existing; verify_existing_cortex ;;
    none)     CORTEX=none;     info "skipping — ee will run on the file backend until RELATA_URL is set" ;;
    *) die "--cortex must be docker, binary, existing or none (got: $CORTEX)" ;;
  esac
fi

step "5/5  Wiring up"
ask_yn SCAFFOLD "Install the meta-fleet into $PROJECT_DIR" "no"
scaffold_project
write_env_file
ask_yn SHELL_RC "Source the env file from your shell rc" "no"
maybe_wire_shell_rc

# ── verify ──
say ""
if [ "$DRY_RUN" = yes ]; then
  ok "Dry run complete — nothing was changed."
  exit 0
fi
PATH="${BIN_DIR:-$PATH}:$PATH"; export PATH
if have fleetsmith; then
  installed=$(fleetsmith version 2>/dev/null | head -n1 || echo '?')
  ok "fleetsmith $installed"
else
  warn "fleetsmith is installed but not yet on this shell's PATH — run: . $ENV_FILE"
fi

cat <<NEXT

${C_BOLD}Next${C_RESET}

  . $ENV_FILE
  fleetsmith patterns                       ${C_DIM}# the five fleet shapes${C_RESET}
  fleetsmith init my-fleet --pattern pipeline --domain "what your team does"
  fleetsmith validate fleet.yaml
  fleetsmith build fleet.yaml --target all  ${C_DIM}# Claude Code + opencode + goose${C_RESET}
NEXT

if [ "$EDITION" = ee ] && [ "$CORTEX" != none ]; then
  cat <<NEXTEE
  fleetsmith grid init fleet.yaml           ${C_DIM}# once per checkout${C_RESET}
  fleetsmith grid sync fleet.yaml           ${C_DIM}# warnings on a brand-new cortex are normal${C_RESET}
NEXTEE
fi

cat <<DOCS

  Quick start   $SITE/quickstart
  User guide    $SITE/guide
  Architecture  $SITE/architecture

DOCS

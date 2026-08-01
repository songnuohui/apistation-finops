#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="${APP_ROOT:-/opt/apistation-finops}"
REPO_URL="${REPO_URL:-git@github.com:songnuohui/apistation-finops.git}"
BRANCH="${BRANCH:-main}"
REPO_DIR="$APP_ROOT/repo"
CURRENT_LINK="$APP_ROOT/current"
ENV_FILE="${ENV_FILE:-/etc/apistation-finops/finops.env}"
SERVICE_NAME="${SERVICE_NAME:-apistation-finops}"

if [ "$(id -u)" -ne 0 ]; then
  echo "run this script as root" >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "missing production environment file: $ENV_FILE" >&2
  exit 1
fi

mkdir -p "$APP_ROOT"

if [ ! -d "$REPO_DIR/.git" ]; then
  git clone --branch "$BRANCH" "$REPO_URL" "$REPO_DIR"
else
  git -C "$REPO_DIR" fetch --prune origin "$BRANCH"
  git -C "$REPO_DIR" checkout "$BRANCH"
  git -C "$REPO_DIR" reset --hard "origin/$BRANCH"
fi

git -C "$REPO_DIR" clean -fd
corepack pnpm --dir "$REPO_DIR" install --frozen-lockfile

set -a
. "$ENV_FILE"
set +a
corepack pnpm --dir "$REPO_DIR" migrate

ln -sfn "$REPO_DIR" "$CURRENT_LINK"
systemctl restart "$SERVICE_NAME"

for attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8090/health >/dev/null 2>&1 \
    && curl -fsS http://127.0.0.1:8090/ready >/dev/null 2>&1; then
    echo "deployed $(git -C "$REPO_DIR" rev-parse --short HEAD)"
    echo "current $(readlink -f "$CURRENT_LINK")"
    exit 0
  fi
  sleep 1
done

echo "service did not become ready" >&2
systemctl --no-pager --full status "$SERVICE_NAME" || true
exit 1

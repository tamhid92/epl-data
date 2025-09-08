#!/usr/bin/env bash
set -euo pipefail

# --- Config -------------------------------------------------------------------
# One of these must be provided:
#   REPO_URL="https://github.com/<owner>/<repo>"
#   ORG_URL="https://github.com/<org>"
# Preferred: GITHUB_ACCESS_TOKEN with admin rights on the repo/org to mint
# registration/removal tokens on start/stop.
# Fallback: RUNNER_TOKEN (short-lived); optional RUNNER_REMOVE_TOKEN.

: "${RUNNER_HOME:=/runner}"
: "${RUNNER_WORKDIR:=${RUNNER_HOME}/_work}"
: "${RUNNER_NAME:=k8s-runner}"
: "${RUNNER_LABELS:=self-hosted,k8s}"
: "${RUNNER_EPHEMERAL:=false}"

API="https://api.github.com"

cleanup() {
  echo "[entrypoint] Caught termination. Removing runner…"
  pushd "${RUNNER_HOME}" >/dev/null
  local remove_token="${RUNNER_REMOVE_TOKEN:-}"
  if [[ -z "$remove_token" && -n "${GITHUB_ACCESS_TOKEN:-}" ]]; then
    if [[ -n "${REPO_URL:-}" ]]; then
      # repo removal token
      owner_repo="${REPO_URL#https://github.com/}"
      remove_token="$(curl -fsSL -XPOST \
        -H "Authorization: Bearer ${GITHUB_ACCESS_TOKEN}" \
        -H "Accept: application/vnd.github+json" \
        "${API}/repos/${owner_repo}/actions/runners/remove-token" \
        | jq -r .token)"
    elif [[ -n "${ORG_URL:-}" ]]; then
      org="${ORG_URL#https://github.com/}"
      remove_token="$(curl -fsSL -XPOST \
        -H "Authorization: Bearer ${GITHUB_ACCESS_TOKEN}" \
        -H "Accept: application/vnd.github+json" \
        "${API}/orgs/${org}/actions/runners/remove-token" \
        | jq -r .token)"
    fi
  fi

  if [[ -n "$remove_token" && -x ./config.sh ]]; then
    ./config.sh remove --unattended --token "$remove_token" || true
  fi
  popd >/dev/null
}
trap cleanup TERM INT

echo "[entrypoint] Preparing runner workdir at ${RUNNER_WORKDIR}"
mkdir -p "${RUNNER_WORKDIR}"

cd "${RUNNER_HOME}"

# Get registration token
REG_TOKEN="${RUNNER_TOKEN:-}"
if [[ -z "${REG_TOKEN}" && -n "${GITHUB_ACCESS_TOKEN:-}" ]]; then
  if [[ -n "${REPO_URL:-}" ]]; then
    owner_repo="${REPO_URL#https://github.com/}"
    echo "[entrypoint] Requesting registration token (repo: ${owner_repo})"
    REG_TOKEN="$(curl -fsSL -XPOST \
      -H "Authorization: Bearer ${GITHUB_ACCESS_TOKEN}" \
      -H "Accept: application/vnd.github+json" \
      "${API}/repos/${owner_repo}/actions/runners/registration-token" \
      | jq -r .token)"
  elif [[ -n "${ORG_URL:-}" ]]; then
    org="${ORG_URL#https://github.com/}"
    echo "[entrypoint] Requesting registration token (org: ${org})"
    REG_TOKEN="$(curl -fsSL -XPOST \
      -H "Authorization: Bearer ${GITHUB_ACCESS_TOKEN}" \
      -H "Accept: application/vnd.github+json" \
      "${API}/orgs/${org}/actions/runners/registration-token" \
      | jq -r .token)"
  else
    echo "[entrypoint] ERROR: Provide REPO_URL or ORG_URL"
    exit 1
  fi
fi

if [[ -z "${REG_TOKEN}" ]]; then
  echo "[entrypoint] ERROR: Unable to acquire RUNNER_TOKEN (set GITHUB_ACCESS_TOKEN or RUNNER_TOKEN)"
  exit 1
fi

# Configure args
CFG_ARGS=(--unattended --disableupdate --name "${RUNNER_NAME}" --labels "${RUNNER_LABELS}" --work "${RUNNER_WORKDIR}")
[[ "${RUNNER_EPHEMERAL}" == "true" ]] && CFG_ARGS+=(--ephemeral)

if [[ -n "${REPO_URL:-}" ]]; then
  CFG_ARGS+=(--url "${REPO_URL}" --token "${REG_TOKEN}")
elif [[ -n "${ORG_URL:-}" ]]; then
  CFG_ARGS+=(--url "${ORG_URL}" --token "${REG_TOKEN}")
else
  echo "[entrypoint] ERROR: Provide REPO_URL or ORG_URL"
  exit 1
fi

echo "[entrypoint] Configuring runner (${RUNNER_NAME}) with labels: ${RUNNER_LABELS}"
./config.sh "${CFG_ARGS[@]}"

# Run
echo "[entrypoint] Starting runner…"
exec ./run.sh

#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
cluster_name="${CLUSTER_NAME:-shoptalk}"
kubeconfig_file="$PWD/.kubeconfig"
for executable in docker kind kubectl openssl; do
  command -v "$executable" >/dev/null || { echo "$executable が必要です。" >&2; exit 1; }
done
docker build -t shoptalk:local .
if kind get clusters | grep -Fxq "$cluster_name"; then
  kind export kubeconfig --name "$cluster_name" --kubeconfig "$kubeconfig_file"
else
  kind create cluster --name "$cluster_name" --kubeconfig "$kubeconfig_file" --wait 120s
fi
chmod 600 "$kubeconfig_file"
kind load docker-image shoptalk:local --name "$cluster_name"
kubectl --kubeconfig "$kubeconfig_file" apply -f k8s/namespace.yaml
if ! kubectl --kubeconfig "$kubeconfig_file" -n shoptalk get secret shoptalk-lab >/dev/null 2>&1; then
  token_file="$(mktemp)"
  trap 'rm -f "$token_file"' EXIT
  chmod 600 "$token_file"
  openssl rand -hex 24 | tr -d '\n' > "$token_file"
  kubectl --kubeconfig "$kubeconfig_file" -n shoptalk create secret generic shoptalk-lab --from-file="token=$token_file"
fi
kubectl --kubeconfig "$kubeconfig_file" apply -k k8s
kubectl --kubeconfig "$kubeconfig_file" -n shoptalk rollout restart deployment/shoptalk-api deployment/shoptalk-ai
kubectl --kubeconfig "$kubeconfig_file" -n shoptalk rollout status deployment/shoptalk-ai --timeout=120s
kubectl --kubeconfig "$kubeconfig_file" -n shoptalk rollout status deployment/shoptalk-api --timeout=120s
printf '\n起動しました。別ターミナルで次を実行してください。\n'
printf 'kubectl --kubeconfig .kubeconfig -n shoptalk port-forward svc/shoptalk-api 8080:8080\n'
printf '演習用トークンの表示: bash scripts/token.sh\n'

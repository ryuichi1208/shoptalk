#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
kubectl --kubeconfig .kubeconfig -n shoptalk get secret shoptalk-lab -o 'jsonpath={.data.token}' | openssl base64 -d -A
printf '\n'

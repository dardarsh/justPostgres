#!/usr/bin/env bash
# Build the project Postgres images.
#
#   ./build.sh            # build every supported major
#   ./build.sh 17         # build one
#
# Until these are published to a registry, the control plane can only provision
# majors that have been built locally.
set -euo pipefail

REGISTRY="${JP_IMAGE_REGISTRY:-justpostgres}"
MAJORS=("${@:-16 17 18}")
read -ra MAJORS <<< "${MAJORS[*]}"

cd "$(dirname "$0")"

for major in "${MAJORS[@]}"; do
  tag="${REGISTRY}/postgres:${major}"
  echo "==> building ${tag}"
  docker build --build-arg "PG_MAJOR=${major}" -t "${tag}" .
done

echo
echo "Built: ${MAJORS[*]}"
docker images "${REGISTRY}/postgres" --format '  {{.Repository}}:{{.Tag}}  {{.Size}}'

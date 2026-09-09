#!/usr/bin/env bash
# Build the project Postgres images.
#
#   ./build.sh            # build every supported major
#   ./build.sh 17         # build one
#
# These are published to Docker Hub, so building them is optional — the control
# plane pulls what it needs. Build locally when you are changing the image
# itself: provisioning resolves images local-first, so a locally built tag wins
# over the published one without any configuration.
set -euo pipefail

REGISTRY="${JP_IMAGE_REGISTRY:-hiteshchoudhary}"
MAJORS=("${@:-16 17 18}")
read -ra MAJORS <<< "${MAJORS[*]}"

cd "$(dirname "$0")"

for major in "${MAJORS[@]}"; do
  tag="${REGISTRY}/justpostgres-postgres:${major}"
  echo "==> building ${tag}"
  docker build --build-arg "PG_MAJOR=${major}" -t "${tag}" .
done

echo
echo "Built: ${MAJORS[*]}"
docker images "${REGISTRY}/justpostgres-postgres" --format '  {{.Repository}}:{{.Tag}}  {{.Size}}'

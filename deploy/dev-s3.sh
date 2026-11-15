#!/usr/bin/env bash
# Start a throwaway S3 server on :9000 and upload data/samples into bucket `recordings`.
# For backend/frontend development without the full compose stack.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
engine="$(command -v podman || command -v docker)"

[ -d "$root/data/samples/demo" ] || python3 "$root/scripts/gen_samples.py" "$root/data/samples"

"$engine" rm -f trfiq-dev-s3 >/dev/null 2>&1 || true
"$engine" run -d --name trfiq-dev-s3 -p 9000:9000 -p 9001:9001 \
  -e RUSTFS_ACCESS_KEY=trfiq -e RUSTFS_SECRET_KEY=trfiq-dev-secret \
  docker.io/rustfs/rustfs:1.0.5 >/dev/null

rc=(-e RCLONE_CONFIG_S3_TYPE=s3 -e RCLONE_CONFIG_S3_PROVIDER=Other
    -e RCLONE_CONFIG_S3_ENDPOINT=http://127.0.0.1:9000
    -e RCLONE_CONFIG_S3_ACCESS_KEY_ID=trfiq -e RCLONE_CONFIG_S3_SECRET_ACCESS_KEY=trfiq-dev-secret)
for _ in $(seq 30); do
  "$engine" run --rm --network=host "${rc[@]}" docker.io/rclone/rclone:1.76.0 lsd s3: >/dev/null 2>&1 && break
  sleep 1
done
"$engine" run --rm --network=host "${rc[@]}" -v "$root/data/samples:/samples:ro,Z" \
  docker.io/rclone/rclone:1.76.0 copy /samples s3:recordings
"$engine" run --rm --network=host "${rc[@]}" docker.io/rclone/rclone:1.76.0 ls s3:recordings
echo "S3 ready on http://127.0.0.1:9000 (console :9001, trfiq / trfiq-dev-secret)"

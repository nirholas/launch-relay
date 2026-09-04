# Deploying the relay

The relay is one always-on process holding a private key. Two things follow from
that, and everything here is downstream of them: the ledger has to survive a
restart (it is what enforces the daily spend cap), and there has to be a way to
stop the thing that does not involve destroying it.

Two deployment targets live in this directory.

| File | Target | Ledger | Halt lever |
| --- | --- | --- | --- |
| `launch-relay.cloudrun.yaml` | Cloud Run service `launch-relay` | GCS bucket `launch-relay-ledger`, gcsfuse-mounted at `/data` | `gs://launch-relay-ledger/HALT` |
| `gce-deploy.sh` | Compute Engine VM | Persistent disk at `/opt/launch-relay` | `/opt/launch-relay/HALT` on the VM |
| `launch-relay.service` | systemd unit used by the VM | as above | as above |

## Current state: stopped

The Cloud Run service was deleted on 2026-09-04. Nothing is running, nothing is
spending, and the relay wallet's nonce has been frozen since.

Everything needed to bring it back survives: the images in Artifact Registry
(`us-central1-docker.pkg.dev/aerial-vehicle-466722-p5/relay/launch-relay`, up to
`v10`), the key in Secret Manager (`launch-relay-evm-key`), and the ledger bucket
with its full launch history. `launch-relay.cloudrun.yaml` is a byte-faithful
copy of the spec that was live, so it restores the service exactly as it ran.

A `HALT` object is also sitting in the ledger bucket, so a restore that is not
deliberate stops at the budget check instead of spending. Remove it when you
actually mean to re-arm:

```bash
gcloud storage rm gs://launch-relay-ledger/HALT --project aerial-vehicle-466722-p5
```

## Stopping a running relay

Write the halt file. The budget check runs before every launch is priced and
signed, so the next launch attempt refuses with `kill switch present at
/data/HALT` and the process keeps running, keeps its ledger, and explains itself
in the log.

```bash
printf 'halted\n' | gcloud storage cp - gs://launch-relay-ledger/HALT \
  --project aerial-vehicle-466722-p5
```

Two things that are **not** a stop, both learned the expensive way:

- **`--min-instances=0` does not stop it.** The service pins
  `autoscaling.knative.dev/minScale: '1'`, and even without that the relay holds
  an open WebSocket to the feed, so it never idles into scale-to-zero.
- **A relative `killSwitchFile` does not stop it.** The config that shipped in
  `v10` used `./HALT`, which resolves against the image's WORKDIR (`/app`) on an
  ephemeral filesystem nobody can write to from outside. The lever existed and
  was not connected to anything, which is why deleting the service was the only
  halt available on 2026-09-04. `config/launch-relay.config.json` now points at
  `/data/HALT`, on the mounted bucket, and `test/deployed-config.test.js` fails
  if it ever drifts back off the persistent mount.

The consequence for a restore: **rebuild the image before redeploying.** The
config is baked in by the Dockerfile (`COPY config ./config`), so redeploying
`v10` as-is brings the disconnected kill switch back with it.

## Restoring the Cloud Run service

```bash
cd /path/to/launch-relay

# 1. Build an image that contains the fixed config.
gcloud builds submit \
  --tag us-central1-docker.pkg.dev/aerial-vehicle-466722-p5/relay/launch-relay:v11 \
  --project aerial-vehicle-466722-p5

# 2. Point the spec at it.
sed -i 's#launch-relay:v10#launch-relay:v11#' deploy/launch-relay.cloudrun.yaml

# 3. Recreate the service.
gcloud run services replace deploy/launch-relay.cloudrun.yaml \
  --region us-central1 --project aerial-vehicle-466722-p5

# 4. Re-arm only when you mean it.
gcloud storage rm gs://launch-relay-ledger/HALT --project aerial-vehicle-466722-p5
```

What the spec asserts, and why each line matters:

- `args: run --config /app/config/launch-relay.config.json --live --yes` plus
  `LAUNCH_RELAY_ARMED=1`. Live mode needs both keys turned at once; neither one
  alone spends.
- `LAUNCH_RELAY_EVM_KEYS` (plural) from `secretKeyRef` on `launch-relay-evm-key`.
  The singular name is a different variable and the relay will not see the key.
- `minScale: 1`, `maxScale: 1`. Exactly one instance. Two relays against one
  wallet race on nonces and on the daily cap.
- `cpu-throttling: 'false'`. The relay works between requests; a throttled
  instance stops consuming the feed.
- `serviceAccountName: three-ws@...`. It needs read on the secret and write on
  the bucket.
- The gcsfuse volume at `/data`. Without it the ledger is ephemeral, and a
  container replacement silently resets the daily spend cap.

## Checking what it did

The ledger is append-only JSON Lines, one record per signal considered:

```bash
gcloud storage cat gs://launch-relay-ledger/launches.jsonl \
  --project aerial-vehicle-466722-p5 | tail -5
```

#!/usr/bin/env bash
# Provision a Compute Engine VM that runs the relay until the wallet is empty.
#
# Why a VM and not Cloud Run: the ledger is what enforces the daily spend cap
# across restarts. Cloud Run's filesystem is ephemeral, so a container
# replacement would silently reset those caps unless you mount a bucket. A
# persistent disk gets that right by default, and this workload is one small
# always-on process, which is exactly what a VM is for.
#
# Usage:
#   PROJECT=my-project ZONE=us-central1-a ./deploy/gce-deploy.sh
#
# Requires: gcloud authenticated, and a private key in Secret Manager. It never
# takes a key on the command line, because that would put it in your shell
# history and in the VM's serial console output.

set -euo pipefail

PROJECT="${PROJECT:?set PROJECT}"
ZONE="${ZONE:-us-central1-a}"
NAME="${NAME:-launch-relay}"
MACHINE="${MACHINE:-e2-micro}"
SECRET="${SECRET:-launch-relay-evm-key}"
CONFIG="${CONFIG:-launch-relay.config.json}"
REPO="${REPO:-https://github.com/nirholas/launch-relay.git}"

echo "project  $PROJECT"
echo "zone     $ZONE"
echo "machine  $MACHINE"
echo "secret   $SECRET"
echo "config   $CONFIG"
echo

if ! gcloud secrets describe "$SECRET" --project "$PROJECT" >/dev/null 2>&1; then
	cat >&2 <<-MSG
	Secret "$SECRET" does not exist. Create it first, without putting the key in
	your shell history:

	  read -rs KEY && printf '%s' "\$KEY" | \\
	    gcloud secrets create $SECRET --project $PROJECT --data-file=-

	MSG
	exit 1
fi

SA="${NAME}-sa@${PROJECT}.iam.gserviceaccount.com"
if ! gcloud iam service-accounts describe "$SA" --project "$PROJECT" >/dev/null 2>&1; then
	echo "creating service account ${NAME}-sa"
	gcloud iam service-accounts create "${NAME}-sa" \
		--project "$PROJECT" --display-name "launch-relay runtime"
fi

# The VM may read exactly one secret and write logs. Nothing else.
gcloud secrets add-iam-policy-binding "$SECRET" --project "$PROJECT" \
	--member "serviceAccount:${SA}" --role roles/secretmanager.secretAccessor >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT" \
	--member "serviceAccount:${SA}" --role roles/logging.logWriter >/dev/null

STARTUP=$(mktemp)
cat > "$STARTUP" <<STARTUP_SCRIPT
#!/usr/bin/env bash
set -euo pipefail

curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs git

id -u relay >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/relay relay
install -d -o relay -g relay /opt/launch-relay /var/log/launch-relay
install -d -m 0750 -o root -g relay /etc/launch-relay

git clone --depth 1 "$REPO" /opt/launch-relay
cd /opt/launch-relay
npm ci --omit=dev --no-audit --no-fund
chown -R relay:relay /opt/launch-relay

# Config travels with the repo; the key comes from Secret Manager at boot and
# lands in a file only root can write and only the relay group can read.
cp /opt/launch-relay/$CONFIG /etc/launch-relay/config.json
KEY=\$(gcloud secrets versions access latest --secret=$SECRET)
umask 027
cat > /etc/launch-relay/env <<ENVFILE
LAUNCH_RELAY_EVM_KEYS=\${KEY}
LAUNCH_RELAY_ARMED=1
ENVFILE
chown root:relay /etc/launch-relay/env
chmod 0640 /etc/launch-relay/env

install -m 0644 /opt/launch-relay/deploy/launch-relay.service /etc/systemd/system/launch-relay.service
systemctl daemon-reload
systemctl enable --now launch-relay
STARTUP_SCRIPT

echo "creating instance $NAME"
gcloud compute instances create "$NAME" \
	--project "$PROJECT" \
	--zone "$ZONE" \
	--machine-type "$MACHINE" \
	--image-family debian-12 \
	--image-project debian-cloud \
	--boot-disk-size 20GB \
	--boot-disk-type pd-standard \
	--service-account "$SA" \
	--scopes cloud-platform \
	--metadata-from-file startup-script="$STARTUP" \
	--tags launch-relay

rm -f "$STARTUP"

cat <<DONE

deployed.

  logs      gcloud compute ssh $NAME --zone $ZONE --project $PROJECT --command 'sudo tail -f /var/log/launch-relay/relay.log'
  status    gcloud compute ssh $NAME --zone $ZONE --project $PROJECT --command 'systemctl status launch-relay'
  ledger    gcloud compute ssh $NAME --zone $ZONE --project $PROJECT --command 'sudo -u relay node /opt/launch-relay/bin/launch-relay.js ledger --config /etc/launch-relay/config.json'

  STOP IT   gcloud compute ssh $NAME --zone $ZONE --project $PROJECT --command 'sudo -u relay touch /opt/launch-relay/HALT'
            The kill switch halts every further launch at the budget check
            without killing the process, so the ledger and feed stay intact.

  DESTROY   gcloud compute instances delete $NAME --zone $ZONE --project $PROJECT

DONE

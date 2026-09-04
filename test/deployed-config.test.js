// The deployed relay's stop lever must be reachable from outside the container.
//
// This is a regression test for a real outage. The Cloud Run deployment ran with
// `killSwitchFile: "./HALT"`, which resolves against the image's WORKDIR (/app)
// on an ephemeral filesystem nobody can write to while the service is running.
// The kill switch was therefore decorative: the only way to stop a relay that was
// spending real ETH every 30 seconds was to delete the Cloud Run service.
//
// The halt file has to live on the one writable surface that outlives the
// container and can be touched from outside it, which is the persistent store
// mount. These assertions tie the three artifacts that have to agree (the config
// baked into the image, the Dockerfile's copy of it, and the service spec's
// volume mount) so the lever cannot silently come unplugged again.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(`${root}/${rel}`, 'utf8');

const CONFIG_PATH = 'config/launch-relay.config.json';
const config = JSON.parse(read(CONFIG_PATH));
const service = read('deploy/launch-relay.cloudrun.yaml');

describe('the deployed launch-relay config', () => {
	it('keeps the kill switch on the persistent store mount', () => {
		const halt = config.budget.killSwitchFile;
		expect(halt, 'the deployed config must declare a kill switch').toBeTruthy();
		expect(isAbsolute(halt), `${halt} is relative, so it lands on the ephemeral container disk`).toBe(true);
		expect(halt.startsWith(`${config.store.dir}/`), `${halt} is not inside the persistent store dir ${config.store.dir}`).toBe(true);
	});

	it('mounts that store dir as a volume in the service spec', () => {
		expect(service).toContain(`mountPath: ${config.store.dir}`);
		expect(service).toContain('driver: gcsfuse.run.googleapis.com');
	});

	it('runs the config these assertions cover', () => {
		expect(service).toContain(`/app/${CONFIG_PATH}`);
		expect(read('Dockerfile')).toMatch(/^COPY config \.\/config$/m);
	});
});

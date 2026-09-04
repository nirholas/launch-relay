// Where a launched token's descriptor lives.
//
// Most launchpads store one string on chain and expect it to resolve to a JSON
// document with the name, description, logo and links. Producing that document
// is easy; hosting it is the part that quietly turns into a dependency, and a
// launcher that silently pins to somebody's gateway has handed that gateway
// the ability to blank every token it ever launched.
//
// So hosting is an adapter with two shipped implementations and room for
// yours. `inline` needs nothing and outlives everything; `pair` uses a
// launchpad's own store when launching on that launchpad. Both return the same
// shape, and a target does not care which it got.

import { keccak256, stringToBytes, toBytes } from 'viem';

/**
 * Base64 that works in a browser and in Node without either one's helper.
 *
 * `Buffer` does not exist in a browser and `btoa` does not exist in older
 * Node, and this file is bundled into both: the website builds the same launch
 * plan the CLI does, from the same module. Encoding the UTF-8 bytes by hand is
 * a dozen lines and removes the question entirely.
 */
export function toBase64(text) {
	const bytes = new TextEncoder().encode(text);
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
	let out = '';
	for (let i = 0; i < bytes.length; i += 3) {
		const chunk = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
		out += alphabet[(chunk >> 18) & 63] + alphabet[(chunk >> 12) & 63]
			+ (i + 1 < bytes.length ? alphabet[(chunk >> 6) & 63] : '=')
			+ (i + 2 < bytes.length ? alphabet[chunk & 63] : '=');
	}
	return out;
}

/**
 * The canonical descriptor document. Field names follow the shape every
 * launchpad on this chain already reads, so a token launched through here
 * renders correctly on venue frontends that were never told about it.
 *
 * @param {import('../../types.js').LaunchSpec} spec
 */
export function buildDescriptorDocument(spec) {
	const doc = {
		name: spec.name,
		symbol: spec.symbol,
		description: spec.description || '',
	};
	if (spec.imageUrl) doc.image = spec.imageUrl;
	const links = spec.links || {};
	if (links.twitter) doc.twitter = links.twitter;
	if (links.telegram) doc.telegram = links.telegram;
	if (links.website) doc.website = links.website;
	if (links.discord) doc.discord = links.discord;
	return doc;
}

/**
 * Host the descriptor inside the URI itself.
 *
 * A data URI has no host to go down, no pin to expire, and no account to
 * cancel: the document is the link. The cost is size, so this is the right
 * default for a small descriptor and the wrong one for a venue that caps the
 * string, which is why `maxBytes` refuses rather than truncates. A truncated
 * data URI is a token whose metadata does not parse, forever.
 *
 * @param {{maxBytes?: number}} [opts]
 */
export function inlineMetadataHost({ maxBytes = 4_096 } = {}) {
	return {
		id: 'inline',
		async publish(spec) {
			const doc = buildDescriptorDocument(spec);
			const json = JSON.stringify(doc);
			const uri = `data:application/json;base64,${toBase64(json)}`;
			if (uri.length > maxBytes) {
				throw new Error(`inline metadata is ${uri.length} bytes, over the ${maxBytes} byte limit; shorten the description or use a hosted metadata adapter`);
			}
			return { metadataURI: uri, metadataHash: keccak256(stringToBytes(json)), imageUrl: spec.imageUrl || null, hosted: false };
		},
	};
}

/**
 * Store the descriptor on a launchpad's own metadata service.
 *
 * Only correct when launching on that launchpad: its indexer is what reads the
 * URI back, and pointing one venue's token at another venue's store produces a
 * listing that renders nowhere.
 *
 * @param {{api: {uploadMetadata: Function, mirrorImage?: Function}, mirrorImage?: boolean}} opts
 */
export function launchpadMetadataHost({ api, mirrorImage = true }) {
	if (!api?.uploadMetadata) throw new Error('launchpadMetadataHost needs an api client with uploadMetadata');
	return {
		id: 'launchpad',
		async publish(spec) {
			let imageUrl = spec.imageUrl || null;
			if (mirrorImage && imageUrl && api.mirrorImage) imageUrl = (await api.mirrorImage(imageUrl)) || null;
			const uploaded = await api.uploadMetadata({
				name: spec.name,
				symbol: spec.symbol,
				description: spec.description,
				image: imageUrl || undefined,
				twitter: spec.links?.twitter || undefined,
				telegram: spec.links?.telegram || undefined,
				website: spec.links?.website || undefined,
			});
			return { ...uploaded, imageUrl, hosted: true };
		},
	};
}

/**
 * Use a URI the caller already has. The escape hatch for anyone with their own
 * pinning setup, and the only honest option when a venue's document format is
 * not the one above.
 *
 * @param {string} uri
 */
export function fixedMetadataHost(uri) {
	if (!uri) throw new Error('fixedMetadataHost needs a URI');
	return {
		id: 'fixed',
		async publish(spec) {
			return { metadataURI: uri, metadataHash: keccak256(toBytes(uri)), imageUrl: spec.imageUrl || null, hosted: true };
		},
	};
}

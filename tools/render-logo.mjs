// Renders the TEST logo: a cratered crescent moon cradling a glossy purple
// sphere on black. Pure Node, no image library: raw RGB pixels, zlib for the
// IDAT stream, and the PNG chunk framing by hand.

import { deflateSync, crc32 as nodeCrc32 } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const SIZE = 1024;

// ── geometry, in pixels ──────────────────────────────────────────────────────
const MOON = { x: 620, y: 512, r: 330 };
// The bite taken out of the moon. Placing its centre well to the right and
// sizing it just under the moon leaves a thick crescent that opens right and
// tapers to sharp tips, rather than the thin fingernail a small offset gives.
const BITE = { x: 760, y: 512, r: 252 };
const ORB = { x: 700, y: 512, r: 118 };

const LIGHT = norm([-0.5, -0.66, 0.56]);
// Without ambient the lower third of the crescent falls to black and the shape
// stops reading. Real lunar photography has earthshine doing this job.
const AMBIENT = 0.22;

// ── deterministic noise ──────────────────────────────────────────────────────
let seed = 0x9e3779b9;
function rnd() {
	seed ^= seed << 13; seed >>>= 0;
	seed ^= seed >> 17;
	seed ^= seed << 5; seed >>>= 0;
	return seed / 0xffffffff;
}

// Craters are generated once and shaded per pixel, so a crater that straddles
// the crescent edge is clipped by the same mask as the surface it sits on.
const craters = [];
for (let i = 0; i < 340; i++) {
	const a = rnd() * Math.PI * 2;
	const d = Math.sqrt(rnd()) * MOON.r * 0.99;
	craters.push({
		x: MOON.x + Math.cos(a) * d,
		y: MOON.y + Math.sin(a) * d,
		// Cubed so the distribution is mostly small pockmarks with a few large
		// basins. A uniform radius reads as bubbles, not a surface.
		r: 3 + rnd() ** 3 * 44,
		depth: 0.1 + rnd() ** 1.6 * 0.34,
	});
}

const pixels = Buffer.alloc(SIZE * SIZE * 3);

// Called at the bottom of the file, not here: the shading helpers below are
// const arrows, and running the loop at this point would hit their temporal
// dead zone.
function renderPixels() {
	for (let py = 0; py < SIZE; py++) {
		for (let px = 0; px < SIZE; px++) {
			// Supersample 2x2, enough to keep the crescent tips and the orb's
			// terminator from crawling.
			let r = 0; let g = 0; let b = 0;
			for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
				const c = shade(px + ox, py + oy);
				r += c[0]; g += c[1]; b += c[2];
			}
			const i = (py * SIZE + px) * 3;
			pixels[i] = clamp255(r / 4);
			pixels[i + 1] = clamp255(g / 4);
			pixels[i + 2] = clamp255(b / 4);
		}
	}
}

function shade(x, y) {
	const orb = shadeOrb(x, y);
	if (orb) return orb;
	const moon = shadeMoon(x, y);
	if (moon) return moon;
	return [0, 0, 0];
}

function shadeMoon(x, y) {
	const dOuter = Math.hypot(x - MOON.x, y - MOON.y);
	const dBite = Math.hypot(x - BITE.x, y - BITE.y);
	if (dOuter > MOON.r || dBite < BITE.r) return null;

	// Treat the crescent as the lit face of a sphere so the shading has real
	// curvature rather than a flat fill with texture on top.
	const nx = (x - MOON.x) / MOON.r;
	const ny = (y - MOON.y) / MOON.r;
	const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
	let n = [nx, ny, nz];

	let relief = 0;
	for (const c of craters) {
		const d = Math.hypot(x - c.x, y - c.y);
		if (d > c.r) continue;
		const t = d / c.r;
		// Bowl interior with a raised rim, the shape that reads as a crater at
		// a glance: dip through most of the radius, lip at the edge.
		const bowl = t < 0.86 ? -(1 - (t / 0.86) ** 2) : ((t - 0.86) / 0.14) ** 0.8 * 0.22;
		relief += bowl * c.depth;
		const k = c.depth * 0.55;
		n = [n[0] + ((x - c.x) / c.r) * bowl * k, n[1] + ((y - c.y) / c.r) * bowl * k, n[2]];
	}
	n = norm(n);

	const diffuse = Math.max(0, dot(n, LIGHT));
	const limb = Math.pow(Math.max(0, nz), 0.4);
	const base = (AMBIENT + (1 - AMBIENT) * diffuse) * limb;
	const grain = (rnd2(x * 0.7, y * 0.7) - 0.5) * 0.03;
	let v = 0.04 + 0.96 * base + relief * 0.09 + grain;

	// Soften the cut edge so the inner curve is not a jagged stair.
	const edge = Math.min(MOON.r - dOuter, dBite - BITE.r);
	if (edge < 1.6) v *= Math.max(0, edge / 1.6);

	const lum = clamp01(v);
	// Cool grey, slightly blue in shadow, warm in the highlights.
	return [
		lum * 232 + lum * lum * 20,
		lum * 233 + lum * lum * 18,
		lum * 238 + lum * lum * 12,
	];
}

function shadeOrb(x, y) {
	const d = Math.hypot(x - ORB.x, y - ORB.y);
	if (d > ORB.r) return null;
	const nx = (x - ORB.x) / ORB.r;
	const ny = (y - ORB.y) / ORB.r;
	const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
	const n = [nx, ny, nz];

	const diffuse = Math.max(0, dot(n, LIGHT));

	// A broad soft highlight rather than a pinprick: the reference orb is
	// polished plastic, not chrome, so the sheen term carries most of it.
	const h = norm([LIGHT[0], LIGHT[1], LIGHT[2] + 1]);
	const align = Math.max(0, dot(n, h));
	const spec = Math.pow(align, 70) * 0.62;
	const sheen = Math.pow(align, 9) * 0.16;

	// Light bouncing back up into the shadowed lower edge. Without it the
	// bottom of the sphere merges into the black background.
	const bounce = Math.pow(Math.max(0, dot(n, [0.35, 0.85, 0.4])), 3) * 0.3;

	const shade = 0.2 + 0.8 * diffuse;
	let r = 138 * shade + bounce * 84;
	let g = 40 * shade + bounce * 30;
	let b = 226 * shade + bounce * 152;

	const hot = (spec + sheen) * 255;
	r += hot; g += hot * 0.82; b += hot;

	const edge = ORB.r - d;
	if (edge < 1.6) { const f = Math.max(0, edge / 1.6); r *= f; g *= f; b *= f; }
	return [r, g, b];
}

// ── vector helpers ───────────────────────────────────────────────────────────
function norm(v) {
	const l = Math.hypot(v[0], v[1], v[2]) || 1;
	return [v[0] / l, v[1] / l, v[2] / l];
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
function rnd2(x, y) {
	const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
	return s - Math.floor(s);
}

// ── PNG encoding ─────────────────────────────────────────────────────────────
renderPixels();

const raw = Buffer.alloc(SIZE * (SIZE * 3 + 1));
for (let y = 0; y < SIZE; y++) {
	raw[y * (SIZE * 3 + 1)] = 0; // filter: none
	pixels.copy(raw, y * (SIZE * 3 + 1) + 1, y * SIZE * 3, (y + 1) * SIZE * 3);
}

const crc32 = typeof nodeCrc32 === 'function'
	? (buf) => nodeCrc32(buf) >>> 0
	: (() => {
		const table = Array.from({ length: 256 }, (_, n) => {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			return c >>> 0;
		});
		return (buf) => {
			let c = 0xffffffff;
			for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
			return (c ^ 0xffffffff) >>> 0;
		};
	})();

function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 2;  // truecolour
const png = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	chunk('IHDR', ihdr),
	chunk('IDAT', deflateSync(raw, { level: 9 })),
	chunk('IEND', Buffer.alloc(0)),
]);

writeFileSync(process.argv[2] || 'test-logo.png', png);
console.log(`wrote ${process.argv[2] || 'test-logo.png'} ${SIZE}x${SIZE} ${(png.length / 1024).toFixed(1)}KB`);

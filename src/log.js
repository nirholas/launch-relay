// Structured-enough logging: one line per event, prefixed by scope, with a
// debug level that stays silent unless LAUNCH_RELAY_DEBUG is set. The engine
// passes a logger into every adapter so a host app can capture the whole run
// by supplying its own.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * @param {string} scope
 * @param {{level?: 'debug'|'info'|'warn'|'error', sink?: (line: string) => void}} [opts]
 * @returns {import('./types.js').Logger}
 */
export function createLogger(scope, opts = {}) {
	const level = LEVELS[opts.level || (process.env.LAUNCH_RELAY_DEBUG ? 'debug' : 'info')] ?? 20;
	const sink = opts.sink || ((line) => process.stdout.write(`${line}\n`));
	const emit = (lvl, args) => {
		if (LEVELS[lvl] < level) return;
		const body = args
			.map((a) => (typeof a === 'string' ? a : safeJson(a)))
			.join(' ');
		sink(`[${scope}] ${lvl === 'info' ? '' : `${lvl}: `}${body}`.replace(/\s+$/, ''));
	};
	return {
		debug: (...a) => emit('debug', a),
		info: (...a) => emit('info', a),
		warn: (...a) => emit('warn', a),
		error: (...a) => emit('error', a),
		child: (sub) => createLogger(`${scope}:${sub}`, opts),
	};
}

function safeJson(value) {
	try {
		return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}` : v));
	} catch {
		return String(value);
	}
}

export const nullLogger = {
	debug() {}, info() {}, warn() {}, error() {}, child() { return nullLogger; },
};

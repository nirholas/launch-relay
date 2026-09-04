// Robinhood Chain, the EVM network PAIR runs on.
//
// The definition moved to src/chains/robinhood/chain.js when the toolkit grew
// past a single launchpad. It is re-exported here because the PAIR adapter and
// everything that imports it were written against this path, and a rename that
// breaks an import is not an improvement.

export {
	NATIVE,
	ROBINHOOD_CHAIN_ID,
	ROBINHOOD_EXPLORER,
	ROBINHOOD_RPC_URL,
	addressUrl,
	robinhoodChain,
	tokenUrl,
	txUrl,
} from '../../chains/robinhood/chain.js';

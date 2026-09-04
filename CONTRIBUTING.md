# Contributing

The useful contributions to this project are mostly not code.

## Add a venue

Robinhood Chain gains launchpads faster than anyone can write adapters for
them, which is why this toolkit learns them instead of hard-coding them. Adding
one is usually a single line in a JSON file.

Full instructions: [docs/robinhood-chain.md](docs/robinhood-chain.md#adding-or-refreshing-a-venue).
The short version:

```bash
# already launching? widen the window and rescan
npm run rhc:discover -- --blocks 400000

# launched a while ago? pin it with one of its real launch transactions
# in src/chains/robinhood/venues/seeds.json, then rescan

npx launch-relay venue <id>   # check what it learned
npm test                       # every venue must reproduce its anchor
npm run docs:venues            # regenerate the table
```

## Name a selector

A venue shows as `unusable (selector 0x… matches no known function signature)`
when nothing can name its launch function. The best fix is to get the contract
verified on a block explorer, because then the Openchain database picks it up
and everyone benefits rather than just this repository.

If you know the signature and cannot get the contract verified, pass it through
`lookupSignatures`' `overrides` argument in a pull request, with the source.

## Bind a field

If a venue replays a value that should be yours to set, add an entry to
[`src/chains/robinhood/venues/overrides.js`](src/chains/robinhood/venues/overrides.js).

The bar is a decoded transaction or a published interface, not a plausible
guess, and the entry has to say which. An override binds a field that a launch
will then change, which is exactly the kind of field that costs real money when
it is wrong. An override that stops a descriptor reproducing its own anchor is
rejected automatically.

## Add a chain

Nothing in `src/engine.js`, `src/rules.js`, `src/budget.js` or `src/mapping.js`
knows what a chain is. The Robinhood Chain support lives entirely under
`src/chains/robinhood/`, and a second chain would sit beside it with the same
shape: a `contracts.js` it can verify, a `discover.js` that learns its venues,
and a target that drives them.

## House rules

- **No mocks in shipped code.** Real contracts, real RPCs, real transactions.
  Tests may stub a `fetch`; a launch path may not.
- **Nothing spends money without a simulation first.** That includes anything
  built from a learned descriptor, where simulation is the only proof the
  replayed arguments are still valid.
- **Every claim about the chain is checkable.** If you add an address, add its
  check to `tools/verify-addresses.mjs`. If you add a venue, its descriptor has
  to reproduce a real transaction.
- **Dry run stays the default** and live mode keeps needing `LAUNCH_RELAY_ARMED=1`.

## Running it

```bash
npm install
npm test
npm run rhc:verify        # address book against the live chain
npm run build:contracts   # only after touching contracts/
```

Node 20 or newer. `viem` is the only runtime dependency and it should stay that
way; `solc` is a dev dependency used to rebuild the committed token artifact.

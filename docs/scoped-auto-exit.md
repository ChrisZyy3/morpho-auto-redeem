# Phase 2: scoped Morpho automatic exit (Draft, not deployed)

## Behavior and authority

The existing read-only monitor remains a separate entrypoint. The new worker defaults
to dry run and only plans exits for the fixed Ethereum USDC/dCOMP market.

```text
position owner --Morpho authorization--> ScopedMorphoWithdraw
bot EOA --withdraw(assets, shares)------> ScopedMorphoWithdraw
                                         -> fixed Morpho market
                                         -> USDC to position owner
```

The non-upgradeable contract fixes Morpho, market ID and token pair in source, and
owner/operator in constructor immutables. Receiver is always owner. It exposes no
arbitrary call, approval, borrow, collateral withdrawal, receiver change or upgrade.
Only owner can pause/resume; owner can revoke the adapter's Morpho authorization.
The bot EOA must never receive broad Morpho authorization. Its key compromise can
consume its gas and trigger withdrawals to owner, but cannot change the recipient.

Morpho authorizes the adapter at account level, not market level; restriction is
provided by this contract's code. An implementation bug could therefore endanger
other Morpho positions. Independent contract/security review and bytecode verification
are required before authorizing it. Tests are not an audit.

## Worker execution

`engine.mjs` serializes each tick, and a journal lock prevents concurrent processes
using the same journal. Live mode checks chain, market tokens, adapter code hash,
immutable getters, adapter authorization and absence of broad bot EOA authorization.
It checks a locally configured operator against the signing key.

Before signing it simulates the exact withdrawal, estimates gas with a 20% margin,
checks gas/fee/per-transaction/daily budgets and bot balance, and checks latest/pending
nonce. A pending transaction prevents a fresh withdrawal. Signed bytes and the local
hash are fsynced before broadcasting. On broadcast uncertainty it retries identical
bytes after 30 seconds; it does not create a replacement or increment nonce.

Receipts need CONFIRMATIONS blocks (default 3). Reverts consume gas budget and are
reported as reverts. Success also requires a USDC Transfer event from Morpho to
the fixed owner; the confirmed log includes the received raw USDC units. Cost is charged to the UTC day on which the transaction was
reserved, even if confirmation crosses midnight. Nonce rollback stops execution.
Non-broadcast RPC errors, simulation errors and journal errors stop the worker with
sanitized logs for manual inspection; allowlisted exit error codes identify
configuration, deployment hash, authorization, journal and nonce stops without
echoing provider messages or secrets; there is no automatic live LaunchAgent yet.

Pending transactions are not automatically replaced or cancelled. Inspect them
before manual action. Never delete a journal, initialized marker or lock to resolve
an unknown pending transaction. After a crash, confirm the old process is dead before
removing only its stale lock. State is 0600, including signed bytes; do not publish it.
Use a dedicated bot account and one state path; changing/deleting paths or state
invalidates budget and concurrency guarantees. Three confirmations do not eliminate
reorg risk; accounting is not a finality oracle.

Liquidity plans use stored same-block state with virtual shares and always request
exact assets to enforce the per-withdrawal cap after interest accrual. This can leave
rounding dust; amounts below MIN_WITHDRAW_USDC need a separately reviewed final exit.
Plans are estimates;
simulation may reject them after accrual, rounding or racing withdrawals. No guaranteed
capture, mempool strategy, allocator or intra-transaction liquidity capture is provided.

## Local dry run (no key or authorization)

Node 22 recommended. The phase 1 `.env` can supply public owner/RPC settings:

```bash
EXIT_ENV_FILE=.env node src/modes/safe-exit/script.mjs --once
```

This mode never constructs a signing account, simulates on behalf of a bot, or sends
a transaction. It reports a plan or `no_liquidity`. It uses the journal namespace
for dry mode; use a different journal path for live mode.

## Before any mainnet activation

1. Review the source and tests independently, including the account-wide Morpho
   authorization implications and incident/revocation procedure.
2. Create a new bot EOA in a trusted wallet. Keep owner keys out of this project.
3. Prepare a mainnet deployment with constructor `(positionOwner, botOperator)`;
   compare these public addresses to the intended owner and bot. Review exact
   deployment bytecode and gas estimate before approving a deployment transaction.
4. Verify deployed source/immutables/runtime bytecode. Obtain runtime hash with
   `keccak256(eth_getCode(executor))`; the configured hash must come from this verified
   deployment, not an untrusted contract claiming matching getters.
5. Owner authorizes ONLY this reviewed adapter on the fixed Morpho contract. Confirm
   bot EOA is not authorized. Review the exact authorization transaction before signing.
6. Copy `.env.exit.example` to `.env.exit.local`, chmod 600, configure local bot key,
   verified adapter/code hash and explicit gas budgets. Choose a distinct live journal.
7. Only after explicit review/approval, set `MIN_WITHDRAW_USDC` and
   `MAX_WITHDRAW_USDC` to a deliberately small approved amount, then use `--live --once`
   for bounded first acceptance. Review confirmation and actual owner balance
   before changing limits or running continuously. No deployment, authorization
   or live activation is performed by this PR.

Current defaults: minimum useful exit 100 USDC, maximum per withdrawal 1,000 USDC, max gas 200,000, max fee 5 gwei,
priority fee 0.5 gwei, max transaction budget 0.001 ETH, daily budget 0.003 ETH.
These are conservative configuration examples, not estimates of current fees.

## Verification

```bash
forge test -vv
forge build
node --test src/modes/auto-withdraw/safe-math.test.mjs src/modes/auto-withdraw/safe-monitor.test.mjs src/modes/safe-exit/engine.test.mjs
ANVIL_BIN=anvil node --test src/modes/safe-exit/runtime.evm.test.mjs
```

The Anvil integration test uses a local EVM with mock Morpho/USDC, ephemeral test
keys and synthetic balances. It verifies real signing, broadcast, confirmations,
journal state and USDC delivery to owner rather than bot. It is not a mainnet fork,
backend acceptance, deployed-contract audit, or evidence of real withdrawals.

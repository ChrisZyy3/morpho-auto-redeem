# Phase 2 code review and validation

Base: ccc36d6. Initial implementation: eab4e92. Review is a source/diff review by
AI agents plus local execution tests, not an independent smart-contract audit.
No mainnet deployment, authorization or signed transaction was performed.

## Standards

No documented hard-standard violations were found. Two P2 maintainability findings
were reported as judgement calls, both addressed:

1. Preserve safe reasons for deliberate stops. Added allowlisted exit error codes
   for configuration, deployment hash, authorization, journal and nonce recovery;
   arbitrary provider details remain suppressed. Covered by a dedicated error test.
2. Centralize simulation/signing call shape. One request builder supplies executor
   target and encoded calldata to simulation, gas estimation and signing. The
   real local-EVM signed withdrawal integration passes with this common builder.

The standards reviewer identified the initial issues. Its follow-up re-review
request failed at the agent service; fixes were inspected and tested locally.

## Spec

Three P2 correctness findings were identified and fixed. The independent spec
reviewer rechecked all three and found no unresolved issue within these fixes
or directly introduced regressions:

1. UTC rollover across asynchronous preflight/signing could charge the wrong day.
   The actual reservation day/budget is rechecked after signing immediately before
   durable save; regression tests cover both simulation and signing rollover.
2. Share redemption could exceed the asset cap after accrued interest. Worker
   plans now always request exact assets with zero shares; the adapter still
   supports explicit owner/operator share calls, which are outside worker caps.
3. Pending recovery previously skipped nonce rollback detection. Latest nonce is
   now checked before receipt lookup or identical-byte rebroadcast, with a dedicated
   recovery regression test.

## Execution evidence

- 33 Node unit/integration tests (15 existing monitor/math, 18 execution tests).
- 13 Solidity tests, including 256 fuzz cases for owner-only destination.
- One separate Anvil integration test performs real local simulation, signing,
  durable journaling, broadcasting, confirmations and USDC delivery to owner.
- Mainnet dry run using public owner/RPC completed with `no_liquidity`, no signer.
- Solidity compiler emits conservative reentrancy/event lint warnings around the
  external Morpho call. The explicit entered guard is set before that call; the
  reentrant-call test and owner/operator gate tests pass. This is not an audit waiver.

Local EVM tests use synthetic balances and mock Morpho/USDC, not a mainnet fork.
Daily budgets depend on preserving a single dedicated bot/journal. Live operation
can still spend bot ETH, race liquidity or halt pending manual recovery. A deployed
bytecode verification, independent security review and explicitly approved bounded
mainnet acceptance remain outstanding.

Summary: Standards 2 findings addressed (worst: safe recovery diagnostics); Spec 3
findings fixed and rechecked (worst: withdrawal cap/daily budget correctness).

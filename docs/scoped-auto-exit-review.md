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


## Independent security review follow-up (2026-11-03)

Two fresh reviewers independently examined contract authority and client transaction
recovery at 43c94c0. No bot wallet/key, mainnet deployment or mainnet authorization
was needed. The production contract source was unchanged by this follow-up.

### Contract lane

No confirmed exploitable contract vulnerability was found within the reviewed scope.
The reviewer traced fixed market/owner/recipient, account-wide permission containment,
constructor, pause/revoke and reachable calls. The runtime has no arbitrary call,
borrow/collateral path, upgrade, delegatecall or selfdestruct.

The reviewer correctly found that the old reentry test hit Unauthorized rather than
Reentrant. A new authorized contract-operator callback now checks the exact guard
error and guard recovery. Added zero-operator, wrong-token, missing-code and
canonical forbidden-selector tests. There are now 20 isolated Solidity tests, including correct-loan/wrong-collateral
and malformed-response checks.

The optional real-mainnet fork suite additionally validates canonical Morpho ABI,
USDC delivery to the actual position owner, absence/revocation of authorization,
and liquidity-failure rollback using real protocol/token code. The 5 fork tests
use locally injected test liquidity; they are not mainnet transactions.

### Client lane

One additional P2 issue was reproduced: an orphan receipt from an inconsistent RPC
backend could falsely confirm a withdrawal and clear its signed pending record.
The new regression was observed failing before the fix (withdraw_confirmed instead
of receipt_inconsistent). The fix checks canonical block hash in the runtime and
rechecks latest account nonce after receipt retrieval before finalization. Pending
state is preserved on disagreement. The client reviewer independently rechecked
the fix and both targeted regression paths; no unresolved finding remained in
that scoped recheck.

The Anvil integration reproduces a real local reorg with evm_snapshot/evm_revert,
then proxies the orphan receipt alongside canonical chain state; the runtime rejects
it. This is separate from the documented risk of later reorgs after genuine confirmation.

### Limits

These are independent AI reviews and execution tests, not a third-party institutional
audit or a guarantee against an adversarial RPC fabricating all chain data. Share
calls made manually/by a compromised operator can bypass off-chain asset caps but
always return funds to the owner. Supply price/bad-debt risk belongs to the protocol
position. Constructor addresses and deployed runtime must still be verified before
any owner authorization; no deployed production adapter exists yet.


### Final follow-up verification

- 34 Node tests, 20 isolated Solidity tests (including 256 fuzz cases), one Anvil
  signing/reorg integration and 5 canonical-mainnet fork tests passed: 60 test cases.
- Fork tests were rerun successfully at block 26333079 with exact unauthorized /
  insufficient-liquidity revert reasons. The final run used a temporary localhost
  read-only relay to work around Foundry's TLS handshake failures. It forwarded
  only read RPC methods to the same public mainnet providers, was then stopped,
  and was never an on-chain transaction endpoint.
- Some direct Foundry reruns failed in fork setup before any test ran due to TLS
  connection errors. Those failures are recorded as infrastructure failures, not
  passed contract tests. Offline CI explicitly skips the 5 network fork tests.
- Reviewed production contract SHA-256:
  `fa1c9d8a4f1dfb2b5d291c5c64e3f1d56c31eaed9265caffe3433fa7dcf2c4e5`.

- One CI Anvil test initially raced automining and captured a null receipt. The
  fixture now waits for mining before capturing the receipt used in its reorg
  scenario; this was a test synchronization defect, not a skipped security check.

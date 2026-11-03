# Mac mini: safe Morpho USDC/dCOMP liquidity monitor (phase 1)

> **READ-ONLY ONLY.** This implementation does not authorize wallets, hold signing keys,
> simulate withdrawals, or submit any transaction. It is **not an automatic exit bot yet**.

This monitor watches only Ethereum mainnet's Morpho Blue USDC/dCOMP market
`0x24852d8d7464402ddcd717415e009d42bf7427d6a8893487f83c75ee0f4a0ea6`.

## Setup

Requirements: macOS (including M1 Mac mini), Node.js 20+ (22 recommended),
pnpm per package.json, stable Ethereum mainnet RPC URL.

```bash
git clone https://github.com/ChrisZyy3/morpho-auto-redeem.git
cd morpho-auto-redeem
git switch feat/safe-morpho-auto-exit
corepack enable
pnpm install --frozen-lockfile
cp .env.safe.example .env
chmod 600 .env
```

Edit **only** these public/read-only settings in `.env`:
- `RPC_URL`: private RPC endpoint (may include an API key)
- `OWNER_ADDRESS`: public address of the existing direct Lend position
- `POLL_MS`: HTTP check interval (1000 by default)
- `MIN_ALERT_USDC`: minimum approximate liquidity amount to log (1000 by default)

Do **not** put any `PRIVATE_KEY` in the monitor's environment. Do not call
Morpho `setAuthorization` for this phase.

```bash
node --test src/modes/auto-withdraw/safe-math.test.mjs
node src/modes/auto-withdraw/safe-monitor.mjs
```

Expect JSON lines such as `started`, `liquidity_detected`, `liquidity_drained`,
`rpc_error`, `position_empty`. A missing liquidity alert is **not** proof of
full market coverage.

## macOS launchd after interactive validation

1. Confirm `which node` and substitute it if not `/opt/homebrew/bin/node`.
2. Edit all `REPLACE_USERNAME` placeholders in
   `scripts/launchd/com.morpho.safe-monitor.plist.example`.
3. `mkdir -p logs ~/Library/LaunchAgents`.
4. Copy the edited plist to
   `~/Library/LaunchAgents/com.morpho.safe-monitor.plist`.
5. Run:
   `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.morpho.safe-monitor.plist`.
6. Check the process with
   `launchctl print gui/$(id -u)/com.morpho.safe-monitor`.
7. To stop:
   `launchctl bootout gui/$(id -u)/com.morpho.safe-monitor`.

Keep the Mac mini awake and connected. Logs go to `logs/` (ignored by Git).
A per-user LaunchAgent requires a logged-in user session; for headless operation
before login use a carefully configured LaunchDaemon instead.

## What is measured?

At each detected new **Ethereum block** the watcher reads `market()` and
`position()` from the same pinned block, then estimates:
- owner's supply assets from Morpho shares (virtual shares included),
- `marketLiquidity = max(totalSupplyAssets - totalBorrowAssets, 0)`,
- `possibleWithdraw = min(ownerSupplyAssets, marketLiquidity)`.

The displayed liquidity is an **estimate** based on stored balances and can
differ from an immediately executable Morpho withdrawal because of accrued interest,
real loan-token balance, competing transactions, reorgs, latency, or RPC issues.

It only detects **post-block** idle liquidity. If someone supplies and
withdraws atomically within one transaction, there is no intervening liquidity to
capture. It does not use Public Allocator or reallocatable liquidity.

The monitor has no transaction or signing capability whatsoever. Its log entries
are local events, not push notifications.

## Next phase (NOT included)

For unattended withdrawal, use a thoroughly reviewed minimal executor smart
contract authorized by the position owner, pinned to the exact market and recipient.
Avoid broad authorization to the bot EOA. Add simulation, gas budget, nonce /
pending transaction persistence, transaction tests, and contract security review.
Only then introduce an explicit opt-in live mode, leaving dry-run as the default.

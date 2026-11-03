#!/usr/bin/env node
/**
 * Ethereum mainnet USDC/dCOMP Morpho Blue read-only liquidity monitor.
 * No private key, signing, wallet authorization, or transaction submission.
 */
import 'dotenv/config';
import {
  createPublicClient, http, parseAbi, getAddress, formatUnits, parseUnits,
} from 'viem';
import {
  estimateAssetsFromShares, estimateMarketLiquidity, estimateWithdrawable,
} from './safe-math.mjs';

const MARKET_ID = '0x24852d8d7464402ddcd717415e009d42bf7427d6a8893487f83c75ee0f4a0ea6';
const MORPHO_BLUE = getAddress('0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb');
const LOAN_TOKEN = getAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
const COLLATERAL_TOKEN = getAddress('0x91d14789071e5E195FFC9F745348736677De3292');
const ABI = parseAbi([
  'function market(bytes32) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)',
  'function position(bytes32,address) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)',
  'function idToMarketParams(bytes32) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)',
]);

function requiredEnv(name) {
  const value = (process.env[name] ?? '').trim();
  if (!value) throw Error('Missing ' + name + ' (see .env.safe.example)');
  return value;
}
function parseSettings() {
  const rpcUrl = requiredEnv('RPC_URL');
  if (!/^https?:\/\//i.test(rpcUrl)) throw Error('RPC_URL must be HTTP(S)');
  const owner = getAddress(requiredEnv('OWNER_ADDRESS'));
  const pollMs = Number(process.env.POLL_MS || '1000');
  if (!Number.isSafeInteger(pollMs) || pollMs < 250 || pollMs > 60_000) {
    throw Error('POLL_MS must be an integer between 250 and 60000');
  }
  const minAlert = parseUnits(process.env.MIN_ALERT_USDC || '1000', 6);
  if (minAlert <= 0n) throw Error('MIN_ALERT_USDC must be positive');
  return { rpcUrl, owner, pollMs, minAlert };
}

const log = (event, data = {}) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
};
const fmt = (value) => formatUnits(value, 6);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const { rpcUrl, owner, pollMs, minAlert } = parseSettings();
  const publicClient = createPublicClient({
    transport: http(rpcUrl, { timeout: 8_000, retryCount: 0 }),
  });
  const chainId = await publicClient.getChainId();
  if (chainId !== 1) throw Error('Ethereum mainnet only; RPC chain ID was ' + chainId);

  const params = await publicClient.readContract({
    address: MORPHO_BLUE, abi: ABI, functionName: 'idToMarketParams', args: [MARKET_ID],
  });
  if (getAddress(params[0]) !== LOAN_TOKEN || getAddress(params[1]) !== COLLATERAL_TOKEN) {
    throw Error('Loan/collateral token mismatch; not monitoring an unverified market');
  }

  log('started', {
    mode: 'READ_ONLY', marketId: MARKET_ID, owner, pollMs, minAlertUsdc: fmt(minAlert),
  });

  let running = true;
  let lastBlock;
  let previousActionable = false;
  let previousReported = 0n;
  let previousError = '';
  process.once('SIGTERM', () => { running = false; });
  process.once('SIGINT', () => { running = false; });

  // Serialized loop: never overlap RPC requests, even when a request exceeds pollMs.
  while (running) {
    try {
      const blockNumber = await publicClient.getBlockNumber();
      if (blockNumber !== lastBlock) {
        const [market, position] = await Promise.all([
          publicClient.readContract({
            address: MORPHO_BLUE, abi: ABI, functionName: 'market',
            args: [MARKET_ID], blockNumber,
          }),
          publicClient.readContract({
            address: MORPHO_BLUE, abi: ABI, functionName: 'position',
            args: [MARKET_ID, owner], blockNumber,
          }),
        ]);
        const [supplyAssets, supplyShares, borrowAssets] = market;
        const [ownerShares] = position;
        const ownerAssets = estimateAssetsFromShares(ownerShares, supplyAssets, supplyShares);
        const liquidity = estimateMarketLiquidity(supplyAssets, borrowAssets);
        const possibleWithdraw = estimateWithdrawable(ownerAssets, liquidity);
        const actionable = possibleWithdraw >= minAlert;
        const increased = possibleWithdraw >= previousReported + minAlert;

        if (actionable && (!previousActionable || increased)) {
          log('liquidity_detected', {
            block: String(blockNumber),
            marketLiquidityUsdcApprox: fmt(liquidity),
            ownerSupplyUsdcApprox: fmt(ownerAssets),
            possibleWithdrawUsdcApprox: fmt(possibleWithdraw),
            note: 'No transaction sent; estimates are not executable quotes',
          });
          previousReported = possibleWithdraw;
        } else if (previousActionable && !actionable) {
          log('liquidity_drained', { block: String(blockNumber) });
          previousReported = 0n;
        }
        if (ownerShares === 0n) {
          log('position_empty', { block: String(blockNumber) });
          break;
        }
        previousActionable = actionable;
        lastBlock = blockNumber;
      }
      previousError = '';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== previousError) log('rpc_error', { message });
      previousError = message;
    }
    if (running) await sleep(pollMs);
  }
  log('stopped');
}

main().catch((error) => {
  console.error('[safe-monitor] fatal:', error);
  process.exitCode = 1;
});

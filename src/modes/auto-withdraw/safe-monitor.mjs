#!/usr/bin/env node
/** Read-only Ethereum mainnet monitor. No wallet, signing or transaction submission. */
import { config as loadEnv } from 'dotenv';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createPublicClient, http, parseAbi, getAddress, formatUnits, parseUnits } from 'viem';
import {
  estimateAssetsFromShares, estimateMarketLiquidity, estimateWithdrawable,
} from './safe-math.mjs';

export const MARKET_ID = '0x24852d8d7464402ddcd717415e009d42bf7427d6a8893487f83c75ee0f4a0ea6';
export const MORPHO_BLUE = getAddress('0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb');
export const LOAN_TOKEN = getAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
export const COLLATERAL_TOKEN = getAddress('0x91d14789071e5E195FFC9F745348736677De3292');
export const ABI = parseAbi([
  'function market(bytes32) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)',
  'function position(bytes32,address) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)',
  'function idToMarketParams(bytes32) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)',
]);

class MonitorConfigError extends Error {}

function requiredEnv(env, name) {
  const value = (env[name] ?? '').trim();
  if (!value) throw new MonitorConfigError('Missing ' + name + ' (see .env.safe.example)');
  return value;
}
function intervalSetting(env, name, fallback, min, max) {
  const value = Number(env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new MonitorConfigError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}
export function parseSettings(env = process.env) {
  const rpcUrl = requiredEnv(env, 'RPC_URL');
  try {
    if (!['http:', 'https:'].includes(new URL(rpcUrl).protocol)) throw Error();
  } catch {
    throw new MonitorConfigError('RPC_URL must be a valid HTTP(S) URL');
  }
  let owner;
  try { owner = getAddress(requiredEnv(env, 'OWNER_ADDRESS')); }
  catch { throw new MonitorConfigError('OWNER_ADDRESS must be a valid public wallet address'); }
  const pollMs = intervalSetting(env, 'POLL_MS', 1000, 250, 60_000);
  const heartbeatMs = intervalSetting(env, 'HEARTBEAT_MS', 30_000, 1000, 3_600_000);
  const staleMs = intervalSetting(env, 'STALE_MS', 120_000, 1000, 3_600_000);
  let minAlert;
  try {
    const text = env.MIN_ALERT_USDC || '1000';
    // Reject rounding: alerts use exact USDC units, up to six decimal places.
    if (!/^\d+(\.\d{1,6})?$/.test(text)) throw Error();
    minAlert = parseUnits(text, 6);
    if (minAlert <= 0n) throw Error();
  } catch { throw new MonitorConfigError('MIN_ALERT_USDC must be positive with at most 6 decimal places'); }
  return { rpcUrl, owner, pollMs, minAlert, heartbeatMs, staleMs };
}

// Never log arbitrary provider messages, URL, request body, cause or stack.
// viem errors can contain RPC credentials in *any* of these fields.
export function safeErrorDetails(error) {
  if (error instanceof MonitorConfigError) return { errorType: 'ConfigurationError', message: error.message };
  const knownTypes = new Set([
    'HttpRequestError', 'TimeoutError', 'RpcRequestError', 'ContractFunctionExecutionError',
    'ContractFunctionRevertedError', 'InvalidAddressError', 'TypeError', 'SyntaxError', 'Error',
  ]);
  return {
    errorType: knownTypes.has(error?.name) ? error.name : 'Error',
    message: 'Request failed; check RPC connectivity, credentials, limits and response format.',
  };
}
export const log = (event, data = {}) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
};
const fmt = (value) => formatUnits(value, 6);
const sleep = async (ms, signal) => {
  try { await delay(ms, undefined, { signal }); }
  catch (error) { if (error.name !== 'AbortError') throw error; }
};

export async function runMonitor(settings, {
  client = createPublicClient({
    cacheTime: 0,
    transport: http(settings.rpcUrl, { timeout: 8_000, retryCount: 0 }),
  }),
  emit = log, now = Date.now, wait = sleep, signal,
} = {}) {
  const { owner, pollMs, minAlert, heartbeatMs, staleMs } = settings;
  const chainId = await client.getChainId();
  if (chainId !== 1) throw new MonitorConfigError('Ethereum mainnet RPC required');
  const params = await client.readContract({
    address: MORPHO_BLUE, abi: ABI, functionName: 'idToMarketParams', args: [MARKET_ID],
  });
  if (getAddress(params[0]) !== LOAN_TOKEN || getAddress(params[1]) !== COLLATERAL_TOKEN) {
    throw new MonitorConfigError('Loan/collateral token mismatch; refusing unverified market');
  }
  emit('started', {
    mode: 'READ_ONLY', marketId: MARKET_ID, owner, pollMs, heartbeatMs, staleMs,
    minAlertUsdc: fmt(minAlert),
  });

  let lastBlock;
  let lastBlockChangeAt = now();
  let lastReadAt;
  let lastHeartbeatAt = now();
  let previousActionable = false;
  let previousReported = 0n;
  let errorType;
  let consecutiveErrors = 0;
  let stale = false;
  let snapshot;
  let reason = 'signal';

  // Await each complete tick before sleeping; never overlap ticks.
  while (!signal?.aborted) {
    try {
      const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
      if (blockNumber !== lastBlock) {
        const [market, position] = await Promise.all([
          client.readContract({
            address: MORPHO_BLUE, abi: ABI, functionName: 'market', args: [MARKET_ID], blockNumber,
          }),
          client.readContract({
            address: MORPHO_BLUE, abi: ABI, functionName: 'position', args: [MARKET_ID, owner], blockNumber,
          }),
        ]);
        const [supplyAssets, supplyShares, borrowAssets] = market;
        const [ownerShares] = position;
        const ownerAssets = estimateAssetsFromShares(ownerShares, supplyAssets, supplyShares);
        const liquidity = estimateMarketLiquidity(supplyAssets, borrowAssets);
        const possibleWithdraw = estimateWithdrawable(ownerAssets, liquidity);
        snapshot = {
          block: String(blockNumber), ownerSupplyShares: String(ownerShares),
          marketLiquidityUsdcApprox: fmt(liquidity), ownerSupplyUsdcApprox: fmt(ownerAssets),
          possibleWithdrawUsdcApprox: fmt(possibleWithdraw),
        };
        if (lastBlock === undefined) emit('snapshot', snapshot);
        const actionable = possibleWithdraw >= minAlert;
        if (actionable && (!previousActionable || possibleWithdraw >= previousReported + minAlert)) {
          emit('liquidity_detected', { ...snapshot, note: 'No transaction sent; estimates are not executable quotes' });
          previousReported = possibleWithdraw;
        } else if (previousActionable && !actionable) {
          emit('liquidity_drained', { ...snapshot, note: 'Below alert threshold; liquidity may still be nonzero' });
          previousReported = 0n;
        }
        previousActionable = actionable;
        lastBlock = blockNumber;
        lastBlockChangeAt = now();
        if (stale) emit('head_recovered', { block: String(lastBlock) });
        stale = false;
        if (ownerShares === 0n) {
          emit('position_empty', snapshot);
          reason = 'position_empty';
        }
      }
      lastReadAt = now();
      if (consecutiveErrors) emit('rpc_recovered', { block: String(lastBlock) });
      errorType = undefined;
      consecutiveErrors = 0;
    } catch (error) {
      const details = safeErrorDetails(error);
      consecutiveErrors++;
      if (details.errorType !== errorType) emit('rpc_error', details);
      errorType = details.errorType;
    }
    const blockAgeMs = now() - lastBlockChangeAt;
    if (!stale && blockAgeMs >= staleMs) {
      emit('head_stale', { block: lastBlock === undefined ? null : String(lastBlock), blockAgeMs });
      stale = true;
    }
    if (now() - lastHeartbeatAt >= heartbeatMs) {
      emit('status', {
        health: consecutiveErrors ? 'rpc_error' : stale ? 'stale' : 'healthy',
        lastSuccessfulReadAt: lastReadAt === undefined ? null : new Date(lastReadAt).toISOString(),
        blockAgeMs, consecutiveErrors, snapshot: snapshot ?? null,
      });
      lastHeartbeatAt = now();
    }
    if (reason === 'position_empty' || signal?.aborted) break;
    await wait(pollMs, signal);
  }
  emit('stopped', { reason });
}

export async function main(env = process.env) {
  loadEnv({ quiet: true });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try { await runMonitor(parseSettings(env), { signal: controller.signal }); }
  finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    log('fatal', safeErrorDetails(error));
    process.exitCode = 1;
  });
}

import { ExitError } from './errors.mjs';
/** Execution state machine. Dependencies are injected; this module has no signer. */
import { estimateAssetsFromShares, estimateMarketLiquidity } from '../auto-withdraw/safe-math.mjs';

export function planWithdrawal(position, market, minAssets, maxAssets) {
  const shares = position[0];
  const owned = estimateAssetsFromShares(shares, market[0], market[1]);
  const liquid = estimateMarketLiquidity(market[0], market[2]);
  let amount = owned < liquid ? owned : liquid;
  if (maxAssets !== undefined && amount > maxAssets) amount = maxAssets;
  if (amount < minAssets || shares === 0n) return null;
  // Exact assets enforce the cap even when interest accrues between planning and execution.
  return { assets: amount, shares: 0n, estimatedAssets: amount };
}

export async function exitTick(io, config) {
  // Journal is durable and exclusive. Never silently reset an unreadable journal.
  const state = io.load();
  if (state.pending) {
    const latest = await io.nonce('latest');
    if (latest < state.pending.nonce || (state.lastConfirmedNonce !== undefined && latest <= state.lastConfirmedNonce)) throw new ExitError('NONCE_ROLLBACK');
    const receipt = await io.receipt(state.pending.hash);
    if (!receipt) {
      if (io.time() - (state.pending.lastBroadcastAt || 0) >= config.retryMs) {
        state.pending.lastBroadcastAt = io.time();
        io.save(state);
        try { await io.broadcast(state.pending.raw); }
        catch { return { event: 'broadcast_uncertain', hash: state.pending.hash }; } // exact same bytes/hash/nonce
      }
      return { event: 'pending', hash: state.pending.hash };
    }
    if (receipt.confirmations < config.confirmations) return { event: 'confirming', hash: state.pending.hash };
    if (receipt.transactionHash.toLowerCase() !== state.pending.hash.toLowerCase()) throw new ExitError('RECEIPT_MISMATCH');
    // Use the original reservation day. Never reset old pending cost into today's budget.
    state.spent[state.pending.day] = BigInt(state.spent[state.pending.day] || '0')
      + receipt.gasUsed * receipt.effectiveGasPrice;
    state.spent[state.pending.day] = String(state.spent[state.pending.day]);
    state.lastConfirmedNonce = state.pending.nonce;
    state.pending = null;
    io.save(state);
    return { event: receipt.status === 'success' ? 'withdraw_confirmed' : 'withdraw_reverted', hash: receipt.transactionHash, assetsReceived: receipt.assetsReceived ?? null };
  }
  const plan = await io.plan();
  if (!plan) return { event: 'no_liquidity' };
  if (!config.live) return { event: 'dry_run', ...plan };
  const fee = await io.fees();
  if (fee.maxFeePerGas > config.maxFeePerGas || fee.maxPriorityFeePerGas > config.maxPriorityFeePerGas) return { event: 'fee_limit' };
  const gas = await io.simulateAndEstimate(plan, fee);
  if (gas > config.maxGas) return { event: 'gas_limit' };
  const reservation = gas * fee.maxFeePerGas;
  if (reservation > config.maxTxCost || BigInt(state.spent[io.day()] || '0') + reservation > config.dailyBudget) return { event: 'budget_limit' };
  if (await io.balance() < reservation) return { event: 'insufficient_gas' };
  const latestNonce = await io.nonce('latest');
  const pendingNonce = await io.nonce('pending');
  if (state.lastConfirmedNonce !== undefined && latestNonce <= state.lastConfirmedNonce) throw new ExitError('NONCE_ROLLBACK');
  if (latestNonce !== pendingNonce) return { event: 'external_pending_transaction' };
  // Persist signed bytes BEFORE broadcast. Hash is computed locally, including on RPC timeout.
  // The signer is only available in live mode. Raw bytes are never logged.
  const signed = await io.sign(plan, fee, gas, pendingNonce);
  // No asynchronous gap between selecting the reservation day, checking its budget and saving.
  const day = io.day();
  if (BigInt(state.spent[day] || '0') + reservation > config.dailyBudget) return { event: 'budget_limit' };
  state.pending = { hash: signed.hash, raw: signed.raw, day, reserved: String(reservation), nonce: pendingNonce, lastBroadcastAt: io.time() };
  io.save(state);
  try { await io.broadcast(signed.raw); }
  catch { return { event: 'broadcast_uncertain', hash: signed.hash }; }
  return { event: 'withdraw_submitted', hash: signed.hash };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VIRTUAL_SHARES,
  estimateAssetsFromShares,
  estimateMarketLiquidity,
  estimateWithdrawable,
} from './safe-math.mjs';

test('Morpho virtual-share math uses floor division, not floating point', () => {
  assert.equal(VIRTUAL_SHARES, 1_000_000n);
  assert.equal(estimateAssetsFromShares(1_000_000n, 1000n, 1_000_000n), 500n);
  assert.equal(estimateAssetsFromShares(0n, 1000n, 1_000_000n), 0n);
  assert.equal(estimateAssetsFromShares(10n, 0n, 0n), 0n);
});

test('idle liquidity is supply assets minus borrow assets, floored at zero', () => {
  assert.equal(estimateMarketLiquidity(14_000_000n, 14_000_000n), 0n);
  assert.equal(estimateMarketLiquidity(14_000_000n, 13_900_000n), 100_000n);
  assert.equal(estimateMarketLiquidity(2n, 3n), 0n);
});

test('possible withdrawal never exceeds position or market idle liquidity', () => {
  assert.equal(estimateWithdrawable(70_164_400_000n, 12_000_000_000n), 12_000_000_000n);
  assert.equal(estimateWithdrawable(70_164_400_000n, 90_000_000_000n), 70_164_400_000n);
  assert.equal(estimateWithdrawable(70_164_400_000n, 0n), 0n);
});

test('invalid negative values fail closed', () => {
  assert.throws(() => estimateMarketLiquidity(-1n, 0n), RangeError);
  assert.throws(() => estimateAssetsFromShares(-1n, 1n, 1n), RangeError);
  assert.throws(() => estimateWithdrawable(1n, -1n), RangeError);
});

/**
 * Pure BigInt math for read-only Morpho Blue liquidity monitoring.
 * Reference: Morpho virtualAssets = 1 and virtualShares = 1_000_000.
 * This is an estimate; it does not simulate execution or guarantee liquidity.
 */
export const VIRTUAL_SHARES = 1_000_000n;

export function estimateAssetsFromShares(shares, totalSupplyAssets, totalSupplyShares) {
  if ([shares, totalSupplyAssets, totalSupplyShares].some((n) => n < 0n)) {
    throw new RangeError('Amounts must be non-negative');
  }
  if (shares === 0n || totalSupplyShares === 0n) return 0n;
  return (shares * (totalSupplyAssets + 1n)) / (totalSupplyShares + VIRTUAL_SHARES);
}

export function estimateMarketLiquidity(totalSupplyAssets, totalBorrowAssets) {
  if (totalSupplyAssets < 0n || totalBorrowAssets < 0n) {
    throw new RangeError('Amounts must be non-negative');
  }
  // Based on stored state at a pinned block; not an executable order or a guarantee.
  return totalSupplyAssets > totalBorrowAssets
    ? totalSupplyAssets - totalBorrowAssets : 0n;
}

export function estimateWithdrawable(ownerSupplyAssets, marketLiquidity) {
  if (ownerSupplyAssets < 0n || marketLiquidity < 0n) {
    throw new RangeError('Amounts must be non-negative');
  }
  return ownerSupplyAssets < marketLiquidity ? ownerSupplyAssets : marketLiquidity;
}

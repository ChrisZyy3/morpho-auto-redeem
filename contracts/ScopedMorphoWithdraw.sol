// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

struct MarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}
interface IMorphoWithdraw {
    function idToMarketParams(bytes32 id) external view returns (MarketParams memory);
    function withdraw(MarketParams memory params, uint256 assets, uint256 shares, address onBehalf, address receiver)
        external returns (uint256, uint256);
}

/// @notice Non-upgradeable withdraw-only adapter. Owner authorizes this contract, never the bot EOA.
/// @dev Only the fixed mainnet market can be withdrawn, always back to the position owner.
contract ScopedMorphoWithdraw {
    address public constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    bytes32 public constant MARKET_ID = 0x24852d8d7464402ddcd717415e009d42bf7427d6a8893487f83c75ee0f4a0ea6;
    address public constant LOAN_TOKEN = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address public constant COLLATERAL_TOKEN = 0x91d14789071e5E195FFC9F745348736677De3292;
    address public immutable owner;
    address public immutable operator;
    bool public paused;
    bool private entered;

    error Unauthorized();
    error InvalidConfiguration();
    error Paused();
    error Reentrant();
    error InvalidAmount();
    event PauseChanged(bool paused);
    event Withdrawn(uint256 assets, uint256 shares);

    constructor(address positionOwner, address botOperator) {
        if (block.chainid != 1 || positionOwner == address(0) || botOperator == address(0) || positionOwner == botOperator) {
            revert InvalidConfiguration();
        }
        owner = positionOwner;
        operator = botOperator;
        _marketParams();
    }

    function setPaused(bool value) external {
        if (msg.sender != owner) revert Unauthorized();
        paused = value;
        emit PauseChanged(value);
    }

    function withdraw(uint256 assets, uint256 shares) external returns (uint256 actualAssets, uint256 actualShares) {
        if (msg.sender != operator && msg.sender != owner) revert Unauthorized();
        if (paused) revert Paused();
        if (entered) revert Reentrant();
        if ((assets == 0) == (shares == 0)) revert InvalidAmount();
        entered = true;
        (actualAssets, actualShares) = IMorphoWithdraw(MORPHO).withdraw(_marketParams(), assets, shares, owner, owner);
        entered = false;
        emit Withdrawn(actualAssets, actualShares);
    }

    function _marketParams() private view returns (MarketParams memory params) {
        params = IMorphoWithdraw(MORPHO).idToMarketParams(MARKET_ID);
        if (params.loanToken != LOAN_TOKEN || params.collateralToken != COLLATERAL_TOKEN) revert InvalidConfiguration();
    }
    // No arbitrary call, borrow, collateral withdrawal, token approval, delegatecall, upgrade or receive path.
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {ScopedMorphoWithdraw, MarketParams, IMorphoWithdraw} from "../ScopedMorphoWithdraw.sol";
interface Vm {
    function chainId(uint256) external;
    function etch(address, bytes calldata) external;
    function prank(address) external;
    function expectRevert(bytes4) external;
    function expectRevert() external;
}
contract MockMorpho is IMorphoWithdraw {
    address public lastOwner;
    address public lastReceiver;
    address public lastCaller;
    bool public authorized = true;
    bool public reenter;
    address public callback;
    function setCallback(address target) external { callback=target; }
    uint256 public available = 1000e6;
    function configure(bool auth, uint256 amount, bool recursive) external { authorized=auth; available=amount; reenter=recursive; }
    function idToMarketParams(bytes32 id) external pure returns (MarketParams memory) {
        require(id == 0x24852d8d7464402ddcd717415e009d42bf7427d6a8893487f83c75ee0f4a0ea6);
        return MarketParams(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48, 0x91d14789071e5E195FFC9F745348736677De3292, address(1), address(2), 0.8e18);
    }
    function withdraw(MarketParams memory p, uint256 assets, uint256 shares, address holder, address receiver) external returns(uint256,uint256) {
        require(authorized, "NOT_AUTHORIZED");
        require(p.loanToken == 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48);
        if (reenter) {
            if(callback==address(0)) ScopedMorphoWithdraw(msg.sender).withdraw(1,0);
            else {
                (bool ok,bytes memory data)=callback.call(abi.encodeWithSignature("reenter()"));
                if(!ok) assembly {revert(add(data,32),mload(data))}
            }
        }
        uint256 amount = assets == 0 ? shares : assets;
        require(amount <= available, "NO_LIQUIDITY");
        available -= amount;
        lastCaller=msg.sender; lastOwner=holder; lastReceiver=receiver;
        return (amount, shares == 0 ? assets : shares);
    }
}
contract ReenteringOperator {
    ScopedMorphoWithdraw public executor;
    function bind(ScopedMorphoWithdraw value) external { executor=value; }
    function begin() external { executor.withdraw(1,0); }
    function reenter() external { executor.withdraw(1,0); }
}
contract WrongTokenMorpho {
    function idToMarketParams(bytes32) external pure returns(MarketParams memory) {
        return MarketParams(address(0),address(0),address(0),address(0),0);
    }
}
contract WrongCollateralMorpho {
    function idToMarketParams(bytes32) external pure returns(MarketParams memory) {
        return MarketParams(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48,address(0),address(0),address(0),0);
    }
}
contract ScopedMorphoWithdrawTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address constant OWNER = address(0xA11CE);
    address constant BOT = address(0xB07);
    ScopedMorphoWithdraw executor;
    function setUp() public {
        vm.chainId(1);
        MockMorpho mock = new MockMorpho();
        vm.etch(MORPHO, address(mock).code);
        MockMorpho(MORPHO).configure(true, 1000e6, false);
        executor = new ScopedMorphoWithdraw(OWNER, BOT);
    }
    function testOnlyOwnerReceiverAndExecutorCaller() public {
        vm.prank(BOT);
        (uint256 a,) = executor.withdraw(50e6, 0);
        require(a == 50e6);
        require(MockMorpho(MORPHO).lastOwner() == OWNER);
        require(MockMorpho(MORPHO).lastReceiver() == OWNER);
        require(MockMorpho(MORPHO).lastCaller() == address(executor));
    }
    function testOwnerCanWithdrawShares() public { vm.prank(OWNER); (uint256 a,) = executor.withdraw(0, 5e6); require(a == 5e6); }
    function testUnauthorizedCannotWithdraw() public { vm.expectRevert(ScopedMorphoWithdraw.Unauthorized.selector); executor.withdraw(1,0); }
    function testOnlyOwnerCanPause() public { vm.prank(BOT); vm.expectRevert(ScopedMorphoWithdraw.Unauthorized.selector); executor.setPaused(true); }
    function testPauseAndResume() public {
        vm.prank(OWNER); executor.setPaused(true);
        vm.prank(BOT); vm.expectRevert(ScopedMorphoWithdraw.Paused.selector); executor.withdraw(1,0);
        vm.prank(OWNER); executor.setPaused(false);
        vm.prank(BOT); executor.withdraw(1,0);
    }
    function testZeroAndAmbiguousAmountsRejected() public {
        vm.prank(BOT); vm.expectRevert(ScopedMorphoWithdraw.InvalidAmount.selector); executor.withdraw(0,0);
        vm.prank(BOT); vm.expectRevert(ScopedMorphoWithdraw.InvalidAmount.selector); executor.withdraw(1,1);
    }
    function testWrongChainRejected() public {
        vm.chainId(10); vm.expectRevert(ScopedMorphoWithdraw.InvalidConfiguration.selector); new ScopedMorphoWithdraw(OWNER,BOT);
    }
    function testZeroOrMainWalletBotRejected() public {
        vm.expectRevert(ScopedMorphoWithdraw.InvalidConfiguration.selector); new ScopedMorphoWithdraw(address(0),BOT);
        vm.expectRevert(ScopedMorphoWithdraw.InvalidConfiguration.selector); new ScopedMorphoWithdraw(OWNER,OWNER);
    }
    function testAuthorizationRevocationBlocksWithdraw() public {
        MockMorpho(MORPHO).configure(false,1000e6,false);
        vm.prank(BOT); (bool ok,) = address(executor).call(abi.encodeCall(executor.withdraw,(1,0))); require(!ok);
    }
    function testLiquidityRaceRevertsAtomically() public {
        MockMorpho(MORPHO).configure(true,0,false);
        vm.prank(BOT); (bool ok,) = address(executor).call(abi.encodeCall(executor.withdraw,(1,0))); require(!ok);
        MockMorpho(MORPHO).configure(true,1000e6,false);
        vm.prank(BOT); executor.withdraw(1,0); // guard rolls back with failed call
    }
    function testNoArbitraryCallsOrBorrowSelector() public {
        vm.prank(BOT); (bool ok,) = address(executor).call(abi.encodeWithSignature("borrow(uint256)",1)); require(!ok);
    }
    function testReentrantExternalCallCannotBypassOperatorGate() public {
        MockMorpho(MORPHO).configure(true,1000e6,true);
        vm.prank(BOT); (bool ok,) = address(executor).call(abi.encodeCall(executor.withdraw,(1,0))); require(!ok);
    }
    function testFuzzWithdrawAlwaysReturnsToOwner(uint96 requested) public {
        uint256 assets=uint256(requested)%1000e6+1;
        MockMorpho(MORPHO).configure(true,assets,false);
        vm.prank(BOT); executor.withdraw(assets,0);
        require(MockMorpho(MORPHO).lastReceiver() == OWNER);
    }
    function testAuthorizedOperatorReentryHitsGuardAndRollsBack() public {
        ReenteringOperator actor=new ReenteringOperator();
        ScopedMorphoWithdraw target=new ScopedMorphoWithdraw(OWNER,address(actor));
        actor.bind(target);
        MockMorpho(MORPHO).setCallback(address(actor));
        MockMorpho(MORPHO).configure(true,1000e6,true);
        vm.expectRevert(ScopedMorphoWithdraw.Reentrant.selector);
        actor.begin();
        MockMorpho(MORPHO).configure(true,1000e6,false);
        actor.begin(); // proves entered guard recovery; canonical accounting rollback is tested on the fork
    }
    function testZeroOperatorRejected() public {
        vm.expectRevert(ScopedMorphoWithdraw.InvalidConfiguration.selector);
        new ScopedMorphoWithdraw(OWNER,address(0));
    }
    function testWrongTokensRejectedAtDeployment() public {
        WrongTokenMorpho bad=new WrongTokenMorpho();
        vm.etch(MORPHO,address(bad).code);
        vm.expectRevert(ScopedMorphoWithdraw.InvalidConfiguration.selector);
        new ScopedMorphoWithdraw(OWNER,BOT);
    }
    function testMissingMorphoCodeRejectedAtDeployment() public {
        vm.etch(MORPHO,hex"");
        vm.expectRevert();new ScopedMorphoWithdraw(OWNER,BOT);
    }
    function testCanonicalBorrowCollateralAndArbitrarySelectorsRejected() public {
        MarketParams memory p=MockMorpho(MORPHO).idToMarketParams(executor.MARKET_ID());
        vm.prank(BOT);
        (bool borrowOk,)=address(executor).call(abi.encodeWithSignature(
            "borrow((address,address,address,address,uint256),uint256,uint256,address,address)",p,1,0,OWNER,BOT));
        vm.prank(BOT);
        (bool collateralOk,)=address(executor).call(abi.encodeWithSignature(
            "withdrawCollateral((address,address,address,address,uint256),uint256,address,address)",p,1,OWNER,BOT));
        vm.prank(BOT);(bool arbitraryOk,)=address(executor).call(hex"ffffffff");
        require(!borrowOk && !collateralOk && !arbitraryOk);
    }

    function testCorrectLoanWrongCollateralRejectedAtDeployment() public {
        WrongCollateralMorpho bad=new WrongCollateralMorpho();
        vm.etch(MORPHO,address(bad).code);
        vm.expectRevert(ScopedMorphoWithdraw.InvalidConfiguration.selector);
        new ScopedMorphoWithdraw(OWNER,BOT);
    }
    function testMalformedMorphoResponseRejectedAtDeployment() public {
        vm.etch(MORPHO,hex"60016000f3");
        vm.expectRevert();new ScopedMorphoWithdraw(OWNER,BOT);
    }

}

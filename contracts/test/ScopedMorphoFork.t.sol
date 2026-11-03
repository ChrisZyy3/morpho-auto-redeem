// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {ScopedMorphoWithdraw, MarketParams, IMorphoWithdraw} from "../ScopedMorphoWithdraw.sol";
interface ForkVm {
    function envOr(string calldata,string calldata) external returns(string memory);
    function envOr(string calldata,address) external returns(address);
    function envOr(string calldata,uint256) external returns(uint256);
    function createSelectFork(string calldata) external returns(uint256);
    function createSelectFork(string calldata,uint256) external returns(uint256);
    function skip(bool) external;
    function prank(address) external;
    function record() external;
    function accesses(address) external returns(bytes32[] memory,bytes32[] memory);
    function load(address,bytes32) external view returns(bytes32);
    function store(address,bytes32,bytes32) external;
}
interface IForkMorpho is IMorphoWithdraw {
    function setAuthorization(address,bool) external;
    function isAuthorized(address,address) external view returns(bool);
    function supply(MarketParams memory,uint256,uint256,address,bytes memory) external returns(uint256,uint256);
    function position(bytes32,address) external view returns(uint256,uint128,uint128);
}
interface IForkToken {
    function balanceOf(address) external view returns(uint256);
    function approve(address,uint256) external returns(bool);
}
/// @dev All impersonation/storage changes are local fork-only; never broadcast a transaction.
contract ScopedMorphoForkTest {
    ForkVm constant vm=ForkVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    IForkMorpho constant morpho=IForkMorpho(0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb);
    IForkToken constant usdc=IForkToken(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48);
    address constant BOT=address(0xB07);
    address constant DONOR=address(0xF00D);
    address owner;
    ScopedMorphoWithdraw executor;
    function setUp() public {
        string memory url=vm.envOr("FORK_RPC_URL",string(""));
        owner=vm.envOr("FORK_OWNER",address(0));
        if(bytes(url).length==0 || owner==address(0)) {vm.skip(true);return;}
        uint256 forkBlock=vm.envOr("FORK_BLOCK",uint256(0));
        if(forkBlock==0) vm.createSelectFork(url);else vm.createSelectFork(url,forkBlock);
        executor=new ScopedMorphoWithdraw(owner,BOT);
    }
    function _fundLocalDonor(uint256 amount) internal {
        vm.record();uint256 beforeBalance=usdc.balanceOf(DONOR);
        (bytes32[] memory reads,)=vm.accesses(address(usdc));
        for(uint256 i;i<reads.length;i++) {
            bytes32 old=vm.load(address(usdc),reads[i]);
            if(uint256(old)!=beforeBalance) continue;
            vm.store(address(usdc),reads[i],bytes32(amount));
            (bool ok,bytes memory result)=address(usdc).staticcall(abi.encodeCall(usdc.balanceOf,(DONOR)));
            if(ok && result.length==32 && abi.decode(result,(uint256))==amount) return;
            vm.store(address(usdc),reads[i],old);
        }
        revert("USDC_LOCAL_BALANCE_SLOT_NOT_FOUND");
    }
    function _addLiquidity() internal {
        _fundLocalDonor(1000e6);
        vm.prank(DONOR);require(usdc.approve(address(morpho),1000e6));
        MarketParams memory params=morpho.idToMarketParams(executor.MARKET_ID());
        vm.prank(DONOR);morpho.supply(params,1000e6,0,DONOR,"");
    }
    function testRealMorphoAuthorizationAndUSDCExit() public {
        _addLiquidity();
        vm.prank(owner);morpho.setAuthorization(address(executor),true);
        require(!morpho.isAuthorized(owner,BOT));
        uint256 balance=usdc.balanceOf(owner);
        (uint256 beforeShares,,)=morpho.position(executor.MARKET_ID(),owner);
        vm.prank(BOT);(uint256 actual,)=executor.withdraw(100e6,0);
        require(actual==100e6 && usdc.balanceOf(owner)==balance+100e6);
        (uint256 afterShares,,)=morpho.position(executor.MARKET_ID(),owner);
        require(afterShares<beforeShares);
        require(usdc.balanceOf(BOT)==0);
    }
    function testRealMorphoRejectsWithoutAuthorization() public {
        _addLiquidity();
        vm.prank(BOT);(bool ok,bytes memory reason)=address(executor).call(abi.encodeCall(executor.withdraw,(100e6,0)));
        require(!ok && keccak256(reason)==keccak256(abi.encodeWithSignature("Error(string)","unauthorized")));
    }
    function testRealMorphoRevocationStopsAdapter() public {
        _addLiquidity();
        vm.prank(owner);morpho.setAuthorization(address(executor),true);
        vm.prank(owner);morpho.setAuthorization(address(executor),false);
        vm.prank(BOT);(bool ok,bytes memory reason)=address(executor).call(abi.encodeCall(executor.withdraw,(100e6,0)));
        require(!ok && keccak256(reason)==keccak256(abi.encodeWithSignature("Error(string)","unauthorized")));
    }
    function testRealMorphoFixedMarketParameters() public view {
        MarketParams memory p=morpho.idToMarketParams(executor.MARKET_ID());
        require(p.loanToken==executor.LOAN_TOKEN() && p.collateralToken==executor.COLLATERAL_TOKEN());
        require(block.chainid==1 && executor.owner()==owner && executor.operator()==BOT);
    }
    function testRealLiquidityFailureRollsBackOwnerAccountingAndGuard() public {
        _addLiquidity();
        MarketParams memory params=morpho.idToMarketParams(executor.MARKET_ID());
        (uint256 donorShares,,)=morpho.position(executor.MARKET_ID(),DONOR);
        vm.prank(DONOR);morpho.withdraw(params,0,donorShares,DONOR,DONOR);
        vm.prank(owner);morpho.setAuthorization(address(executor),true);
        uint256 balance=usdc.balanceOf(owner);
        (uint256 shares,,)=morpho.position(executor.MARKET_ID(),owner);
        vm.prank(BOT);(bool ok,bytes memory reason)=address(executor).call(abi.encodeCall(executor.withdraw,(100e6,0)));
        require(!ok && keccak256(reason)==keccak256(abi.encodeWithSignature("Error(string)","insufficient liquidity")));
        require(usdc.balanceOf(owner)==balance);
        (uint256 afterShares,,)=morpho.position(executor.MARKET_ID(),owner);
        require(afterShares==shares);
        _addLiquidity();
        vm.prank(BOT);executor.withdraw(100e6,0);
        require(usdc.balanceOf(owner)==balance+100e6);
    }

}

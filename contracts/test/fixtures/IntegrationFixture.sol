// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {MarketParams} from "../../ScopedMorphoWithdraw.sol";
contract FixtureUSDC {
    event Transfer(address indexed from,address indexed to,uint256 value);
    mapping(address=>uint256) public balanceOf;
    function mint(address account,uint256 value) external {balanceOf[account]+=value;}
    function transfer(address to,uint256 value) external returns(bool) {balanceOf[msg.sender]-=value;balanceOf[to]+=value;emit Transfer(msg.sender,to,value);return true;}
}
contract IntegrationMorpho {
    address constant USDC=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    mapping(address=>mapping(address=>bool)) public isAuthorized;
    mapping(address=>uint256) public supplied;
    uint128 public supplyAssets;
    uint128 public supplyShares;
    function seed(address owner,uint128 assets) external {
        supplied[owner]=uint256(assets)*1e6; supplyAssets+=assets;supplyShares+=assets*1e6;
        FixtureUSDC(USDC).mint(address(this),assets);
    }
    function setAuthorization(address authorized,bool value) external {isAuthorized[msg.sender][authorized]=value;}
    function idToMarketParams(bytes32) external pure returns(MarketParams memory) {
        return MarketParams(USDC,0x91d14789071e5E195FFC9F745348736677De3292,address(1),address(2),0.8e18);
    }
    function position(bytes32,address owner) external view returns(uint256,uint128,uint128) {return(supplied[owner],0,0);}
    function market(bytes32) external view returns(uint128,uint128,uint128,uint128,uint128,uint128) {
        return(supplyAssets,supplyShares,0,0,uint128(block.timestamp),0);
    }
    function withdraw(MarketParams memory p,uint256 assets,uint256 shares,address onBehalf,address receiver) external returns(uint256,uint256) {
        require(msg.sender==onBehalf || isAuthorized[onBehalf][msg.sender],"UNAUTHORIZED");
        require((assets==0)!=(shares==0),"AMOUNT");
        if(assets>0) shares=(assets*(uint256(supplyShares)+1e6)+supplyAssets)/(uint256(supplyAssets)+1);
        else assets=shares*(uint256(supplyAssets)+1)/(uint256(supplyShares)+1e6);
        supplied[onBehalf]-=shares;supplyShares-=uint128(shares);supplyAssets-=uint128(assets);
        require(p.loanToken==USDC,"TOKEN");FixtureUSDC(USDC).transfer(receiver,assets);return(assets,shares);
    }
}

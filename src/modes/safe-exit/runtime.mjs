import { createPublicClient, http, parseAbi, getAddress, parseEther, parseGwei, parseUnits, encodeFunctionData, decodeEventLog, keccak256 } from 'viem';
import { ABI as MARKET_ABI, MARKET_ID, MORPHO_BLUE, LOAN_TOKEN, COLLATERAL_TOKEN } from '../auto-withdraw/safe-monitor.mjs';
import { planWithdrawal } from './engine.mjs';
export const EXECUTOR_ABI = parseAbi([
  'function owner() view returns (address)', 'function operator() view returns (address)',
  'function MORPHO() view returns (address)', 'function MARKET_ID() view returns (bytes32)',
  'function LOAN_TOKEN() view returns (address)', 'function COLLATERAL_TOKEN() view returns (address)',
  'function paused() view returns (bool)',
  'function withdraw(uint256 assets,uint256 shares) returns (uint256,uint256)',
]);
const AUTH_ABI = parseAbi(['function isAuthorized(address,address) view returns(bool)']);
function required(env, key) { if (!env[key]) throw Error('Missing configuration'); return env[key]; }
function integer(env, key, fallback, min) {
  const n=Number(env[key] || fallback);
  if (!Number.isSafeInteger(n) || n<min || n>1_000_000) throw Error('Invalid numeric configuration');
  return n;
}
export function exitConfig(env, live = false) {
  const owner=getAddress(required(env,'OWNER_ADDRESS'));
  const config={ live, owner, rpcUrl:required(env,'RPC_URL'), minAssets:parseUnits(env.MIN_WITHDRAW_USDC || '100',6),
    maxAssets:parseUnits(env.MAX_WITHDRAW_USDC || '1000',6),
    pollMs:integer(env,'POLL_MS',5000,1000), retryMs:30000, confirmations:integer(env,'CONFIRMATIONS',3,2),
    maxGas:BigInt(env.MAX_GAS || '200000'), maxFeePerGas:parseGwei(env.MAX_FEE_GWEI || '5'),
    maxPriorityFeePerGas:parseGwei(env.MAX_PRIORITY_GWEI || '0.5'), maxTxCost:parseEther(env.MAX_TX_ETH || '0.001'),
    dailyBudget:parseEther(env.DAILY_GAS_ETH || '0.003'), journalPath:env.JOURNAL_PATH || 'state/safe-exit.json',
  };
  if (config.maxAssets < config.minAssets) throw Error('Maximum withdrawal is below minimum');
  if (Object.values(config).some((n)=>typeof n==='bigint' && n<=0n)) throw Error('Limits must be positive');
  const url=new URL(config.rpcUrl);
  if (!['https:','http:'].includes(url.protocol)) throw Error('Invalid RPC URL');
  if (live) {
    config.operator=getAddress(required(env,'OPERATOR_ADDRESS'));
    config.executor=getAddress(required(env,'EXECUTOR_ADDRESS'));
    config.codeHash=required(env,'EXECUTOR_CODE_HASH');
    if (!/^0x[0-9a-fA-F]{64}$/.test(config.codeHash) || config.operator===owner || config.executor===owner || config.executor===config.operator) throw Error('Invalid executor configuration');
    if (env.LIVE_CONFIRMATION !== 'WITHDRAW_TO_OWNER') throw Error('Live confirmation missing');
  }
  return config;
}

export async function createExitIO(config, journal, privateKey) {
  const client=createPublicClient({cacheTime:0, transport:http(config.rpcUrl,{timeout:8000,retryCount:0})});
  if (await client.getChainId() !== 1) throw Error('Ethereum mainnet required');
  const marketParams=await client.readContract({address:MORPHO_BLUE,abi:MARKET_ABI,functionName:'idToMarketParams',args:[MARKET_ID]});
  if(getAddress(marketParams[0])!==LOAN_TOKEN || getAddress(marketParams[1])!==COLLATERAL_TOKEN) throw Error('Market token mismatch');
  let account;
  const readExecutor=(functionName)=>client.readContract({address:config.executor,abi:EXECUTOR_ABI,functionName});
  if(config.live) {
    const code=await client.getCode({address:config.executor});
    if(!code || keccak256(code).toLowerCase()!==config.codeHash.toLowerCase()) throw Error('Executor bytecode hash mismatch');
    for(const [name,value] of Object.entries({owner:config.owner,operator:config.operator,MORPHO:MORPHO_BLUE,MARKET_ID,LOAN_TOKEN,COLLATERAL_TOKEN})) {
      if(String(await readExecutor(name)).toLowerCase()!==value.toLowerCase()) throw Error('Executor immutable mismatch');
    }
    const [adapterAuthorized,botAuthorized]=await Promise.all([config.executor,config.operator].map((address)=>client.readContract({address:MORPHO_BLUE,abi:AUTH_ABI,functionName:'isAuthorized',args:[config.owner,address]})));
    if(!adapterAuthorized || botAuthorized) throw Error('Authorize only reviewed executor; revoke broad bot EOA authorization');
    const { privateKeyToAccount }=await import('viem/accounts');
    account=privateKeyToAccount(privateKey);
    if(account.address!==config.operator) throw Error('Bot key/operator mismatch');
  }
  const call=(plan)=>({address:config.executor,abi:EXECUTOR_ABI,functionName:'withdraw',args:[plan.assets,plan.shares],account:config.operator});
  return {
    load:journal.load, save:journal.save,
    day:()=>new Date().toISOString().slice(0,10), time:Date.now,
    async plan() {
      const blockNumber=await client.getBlockNumber({cacheTime:0});
      const [position,market]=await Promise.all([
        client.readContract({address:MORPHO_BLUE,abi:MARKET_ABI,functionName:'position',args:[MARKET_ID,config.owner],blockNumber}),
        client.readContract({address:MORPHO_BLUE,abi:MARKET_ABI,functionName:'market',args:[MARKET_ID],blockNumber}),
      ]);
      return planWithdrawal(position,market,config.minAssets,config.maxAssets);
    },
    fees:()=>client.estimateFeesPerGas({type:'eip1559'}),
    async simulateAndEstimate(plan,fee) {
      await client.simulateContract({...call(plan),...fee});
      return (await client.estimateContractGas({...call(plan),...fee}))*120n/100n;
    },
    balance:()=>client.getBalance({address:config.operator}),
    nonce:(blockTag)=>client.getTransactionCount({address:config.operator,blockTag}),
    async sign(plan,fee,gas,nonce) {
      const raw=await account.signTransaction({chainId:1,to:config.executor,
        data:encodeFunctionData({abi:EXECUTOR_ABI,functionName:'withdraw',args:[plan.assets,plan.shares]}),
        gas,nonce,maxFeePerGas:fee.maxFeePerGas,maxPriorityFeePerGas:fee.maxPriorityFeePerGas,type:'eip1559'});
      return {raw,hash:keccak256(raw)};
    },
    broadcast:(serializedTransaction)=>client.sendRawTransaction({serializedTransaction}),
    async receipt(hash) {
      let receipt;
      try {receipt=await client.getTransactionReceipt({hash});}
      catch(error) {if(error.name==='TransactionReceiptNotFoundError') return null; throw error;}
      let assetsReceived=0n;
      if(receipt.status==='success') {
        const transferAbi=parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);
        for(const entry of receipt.logs) {
          if(entry.address.toLowerCase()!==LOAN_TOKEN.toLowerCase()) continue;
          try {
            const decoded=decodeEventLog({abi:transferAbi,data:entry.data,topics:entry.topics});
            if(decoded.args.from.toLowerCase()===MORPHO_BLUE.toLowerCase() && decoded.args.to.toLowerCase()===config.owner.toLowerCase()) assetsReceived+=decoded.args.value;
          } catch { /* Ignore unrelated events from the loan token. */ }
        }
        if(assetsReceived===0n) throw Error('Receipt has no USDC delivery to owner');
      }
      const head=await client.getBlockNumber({cacheTime:0});
      return {...receipt,assetsReceived,confirmations:head>=receipt.blockNumber?Number(head-receipt.blockNumber+1n):0};
    },
  };
}

import { ExitError } from './errors.mjs';
import { createPublicClient, http, parseAbi, getAddress, parseUnits, encodeFunctionData, decodeEventLog, keccak256 } from 'viem';
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
function required(env, key) { if (!env[key]) throw new ExitError('CONFIG_MISSING'); return env[key]; }
function integer(env, key, fallback, min) {
  const n=Number(env[key] || fallback);
  if (!Number.isSafeInteger(n) || n<min || n>1_000_000) throw new ExitError('CONFIG_INVALID');
  return n;
}
function amount(env,key,fallback,decimals) {
  const text=env[key] || fallback;
  if(!new RegExp('^\\d+(\\.\\d{1,'+decimals+'})?$').test(text)) throw new ExitError('CONFIG_INVALID');
  return parseUnits(text,decimals);
}
export function exitConfig(env, live = false) {
  const owner=getAddress(required(env,'OWNER_ADDRESS'));
  const config={ live, owner, rpcUrl:required(env,'RPC_URL'), minAssets:amount(env,'MIN_WITHDRAW_USDC','100',6),
    maxAssets:amount(env,'MAX_WITHDRAW_USDC','1000',6),
    pollMs:integer(env,'POLL_MS',5000,1000), retryMs:30000, confirmations:integer(env,'CONFIRMATIONS',3,2),
    maxGas:BigInt(env.MAX_GAS || '200000'), maxFeePerGas:amount(env,'MAX_FEE_GWEI','5',9),
    maxPriorityFeePerGas:amount(env,'MAX_PRIORITY_GWEI','0.5',9), maxTxCost:amount(env,'MAX_TX_ETH','0.001',18),
    dailyBudget:amount(env,'DAILY_GAS_ETH','0.003',18), journalPath:env.JOURNAL_PATH || 'state/safe-exit.json',
  };
  if (config.maxAssets < config.minAssets) throw new ExitError('CONFIG_INVALID');
  if (Object.values(config).some((n)=>typeof n==='bigint' && n<=0n)) throw new ExitError('CONFIG_INVALID');
  const url=new URL(config.rpcUrl);
  if (!['https:','http:'].includes(url.protocol)) throw new ExitError('CONFIG_INVALID');
  if (live) {
    config.operator=getAddress(required(env,'OPERATOR_ADDRESS'));
    config.executor=getAddress(required(env,'EXECUTOR_ADDRESS'));
    config.codeHash=required(env,'EXECUTOR_CODE_HASH');
    if (!/^0x[0-9a-fA-F]{64}$/.test(config.codeHash) || config.operator===owner || config.executor===owner || config.executor===config.operator) throw new ExitError('CONFIG_INVALID');
    if (env.LIVE_CONFIRMATION !== 'WITHDRAW_TO_OWNER') throw new ExitError('LIVE_CONFIRMATION');
  }
  return config;
}

export async function createExitIO(config, journal, privateKey) {
  const client=createPublicClient({cacheTime:0, transport:http(config.rpcUrl,{timeout:8000,retryCount:0})});
  if (await client.getChainId() !== 1) throw new ExitError('WRONG_CHAIN');
  const marketParams=await client.readContract({address:MORPHO_BLUE,abi:MARKET_ABI,functionName:'idToMarketParams',args:[MARKET_ID]});
  if(getAddress(marketParams[0])!==LOAN_TOKEN || getAddress(marketParams[1])!==COLLATERAL_TOKEN) throw new ExitError('WRONG_MARKET');
  let account;
  const readExecutor=(functionName)=>client.readContract({address:config.executor,abi:EXECUTOR_ABI,functionName});
  if(config.live) {
    const code=await client.getCode({address:config.executor});
    if(!code || keccak256(code).toLowerCase()!==config.codeHash.toLowerCase()) throw new ExitError('CODE_HASH');
    for(const [name,value] of Object.entries({owner:config.owner,operator:config.operator,MORPHO:MORPHO_BLUE,MARKET_ID,LOAN_TOKEN,COLLATERAL_TOKEN})) {
      if(String(await readExecutor(name)).toLowerCase()!==value.toLowerCase()) throw new ExitError('IMMUTABLES');
    }
    const [adapterAuthorized,botAuthorized]=await Promise.all([config.executor,config.operator].map((address)=>client.readContract({address:MORPHO_BLUE,abi:AUTH_ABI,functionName:'isAuthorized',args:[config.owner,address]})));
    if(!adapterAuthorized || botAuthorized) throw new ExitError('AUTHORIZATION');
    const { privateKeyToAccount }=await import('viem/accounts');
    try { account=privateKeyToAccount(privateKey); }
    catch { throw new ExitError('OPERATOR_KEY'); }
    if(account.address!==config.operator) throw new ExitError('OPERATOR_KEY');
  }
  const request=(plan)=>({to:config.executor,data:encodeFunctionData({abi:EXECUTOR_ABI,functionName:'withdraw',args:[plan.assets,plan.shares]})});
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
      await client.call({...request(plan),account:config.operator,...fee});
      return ((await client.estimateGas({...request(plan),account:config.operator,...fee}))*120n+99n)/100n;
    },
    balance:()=>client.getBalance({address:config.operator}),
    nonce:(blockTag)=>client.getTransactionCount({address:config.operator,blockTag}),
    async sign(plan,fee,gas,nonce) {
      const raw=await account.signTransaction({chainId:1,...request(plan),
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
        if(assetsReceived===0n) throw new ExitError('DELIVERY_MISSING');
      }
      const head=await client.getBlockNumber({cacheTime:0});
      return {...receipt,assetsReceived,confirmations:head>=receipt.blockNumber?Number(head-receipt.blockNumber+1n):0};
    },
  };
}

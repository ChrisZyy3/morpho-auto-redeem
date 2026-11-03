#!/usr/bin/env node
/** Read-only chain/head/market probe. Never logs endpoint URL, headers or provider details. */
import { config as loadEnv } from 'dotenv';
import { createPublicClient, http } from 'viem';
import { ABI, MARKET_ID, MORPHO_BLUE, LOAN_TOKEN, COLLATERAL_TOKEN, safeErrorDetails } from '../src/modes/auto-withdraw/safe-monitor.mjs';
loadEnv({path:process.env.RPC_ENV_FILE || '.env',quiet:true});
const samples=Number(process.env.RPC_PROBE_SAMPLES || '5');
if(!process.env.RPC_URL || !Number.isSafeInteger(samples) || samples<1 || samples>60) {
  console.log(JSON.stringify({event:'probe_invalid_config',message:'Set RPC_URL locally and RPC_PROBE_SAMPLES to 1..60.'}));process.exitCode=1;
} else {
 const client=createPublicClient({cacheTime:0,transport:http(process.env.RPC_URL,{timeout:8000,retryCount:0})});
 const results=[];
 for(let i=0;i<samples;i++) {
  const start=performance.now();
  try {
   if(await client.getChainId()!==1) throw Error('wrong chain');
   const params=await client.readContract({address:MORPHO_BLUE,abi:ABI,functionName:'idToMarketParams',args:[MARKET_ID]});
   if(params[0].toLowerCase()!==LOAN_TOKEN.toLowerCase() || params[1].toLowerCase()!==COLLATERAL_TOKEN.toLowerCase()) throw Error('wrong market');
   const blockNumber=await client.getBlockNumber({cacheTime:0});
   await client.readContract({address:MORPHO_BLUE,abi:ABI,functionName:'market',args:[MARKET_ID],blockNumber});
   results.push({ok:true,block:String(blockNumber),ms:Math.round(performance.now()-start)});
  } catch(error) {results.push({ok:false,ms:Math.round(performance.now()-start),...safeErrorDetails(error)});}
 }
 console.log(JSON.stringify({event:'rpc_probe',readOnly:true,samples,passed:results.filter(x=>x.ok).length,results}));
 process.exitCode=results.every(x=>x.ok)?0:1;
}

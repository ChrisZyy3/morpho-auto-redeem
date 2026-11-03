import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { createPublicClient, createWalletClient, http, parseAbi, parseEther, keccak256 } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { exitConfig, createExitIO } from './runtime.mjs';
import { exitTick } from './engine.mjs';
import { openJournal } from './journal.mjs';
import { MORPHO_BLUE, LOAN_TOKEN } from '../auto-withdraw/safe-monitor.mjs';

const artifact=(file,name)=>JSON.parse(readFileSync(new URL(`../../../artifacts/solidity/${file}/${name}.json`,import.meta.url),'utf8'));

test('local EVM: actual simulation, signing, durable broadcast, receipt and USDC delivery to owner', {skip:!process.env.ANVIL_BIN, timeout:30000}, async(t)=>{
 const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(r=>server.close(r));
 const child=spawn(process.env.ANVIL_BIN,['--host','127.0.0.1','--port',String(port),'--chain-id','1','--silent'],{stdio:'ignore'});
 t.after(()=>{child.kill('SIGTERM');});
 const url=`http://127.0.0.1:${port}`;
 const client=createPublicClient({cacheTime:0,transport:http(url,{retryCount:0,timeout:1000})});
 let ready=false;
 for(let i=0;i<60;i++){try{await client.getChainId();ready=true;break;}catch{await new Promise(r=>setTimeout(r,50));}}
 assert.ok(ready,'local Anvil started');
 // Fresh ephemeral accounts exist only on this local chain; no real wallet or key is used.
 const ownerKey=generatePrivateKey();const operatorKey=generatePrivateKey();
 const owner=privateKeyToAccount(ownerKey);const bot=privateKeyToAccount(operatorKey);
 const chain={id:1,name:'Local test EVM',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[url]}}};
 const wallet=createWalletClient({chain,account:owner,transport:http(url)});
 for(const address of [owner.address,bot.address])await client.request({method:'anvil_setBalance',params:[address,'0x'+parseEther('10').toString(16)]});
 for(const [address,name] of [[MORPHO_BLUE,'IntegrationMorpho'],[LOAN_TOKEN,'FixtureUSDC']]) {
  await client.request({method:'anvil_setCode',params:[address,artifact('IntegrationFixture.sol',name).deployedBytecode.object]});
 }
 const morphoAbi=parseAbi(['function seed(address,uint128)','function setAuthorization(address,bool)']);
 let hash=await wallet.writeContract({address:MORPHO_BLUE,abi:morphoAbi,functionName:'seed',args:[owner.address,2000_000000n]});await client.waitForTransactionReceipt({hash});
 const executorArtifact=artifact('ScopedMorphoWithdraw.sol','ScopedMorphoWithdraw');
 hash=await wallet.deployContract({abi:executorArtifact.abi,bytecode:executorArtifact.bytecode.object,args:[owner.address,bot.address]});
 const deployed=await client.waitForTransactionReceipt({hash});const executor=deployed.contractAddress;
 hash=await wallet.writeContract({address:MORPHO_BLUE,abi:morphoAbi,functionName:'setAuthorization',args:[executor,true]});await client.waitForTransactionReceipt({hash});
 const code=await client.getCode({address:executor});
 const dir=mkdtempSync(join(tmpdir(),'morpho-live-evm-'));
 const cfg=exitConfig({RPC_URL:url,OWNER_ADDRESS:owner.address,OPERATOR_ADDRESS:bot.address,EXECUTOR_ADDRESS:executor,
 EXECUTOR_CODE_HASH:keccak256(code),BOT_PRIVATE_KEY:operatorKey,LIVE_CONFIRMATION:'WITHDRAW_TO_OWNER',MAX_WITHDRAW_USDC:'2000',MAX_FEE_GWEI:'100',MAX_PRIORITY_GWEI:'5',MAX_TX_ETH:'0.1',DAILY_GAS_ETH:'1'},true);
 const journal=openJournal(join(dir,'state.json'),'evm');t.after(()=>{journal.close();rmSync(dir,{recursive:true,force:true});});
 const io=await createExitIO(cfg,journal,operatorKey);
 const snapshotId=await client.request({method:'evm_snapshot',params:[]});
 const result=await exitTick(io,cfg);assert.equal(result.event,'withdraw_submitted');
 await client.waitForTransactionReceipt({hash:result.hash});
 const staleReceipt=await client.request({method:'eth_getTransactionReceipt',params:[result.hash]});
 assert.ok(staleReceipt,'wait for actual mining before capturing the orphan-receipt fixture');
 const pending=journal.load().pending;assert.equal(pending.hash,result.hash);
 await client.request({method:'anvil_mine',params:['0x3']});
 assert.equal((await exitTick(io,cfg)).event,'withdraw_confirmed');
 assert.equal(journal.load().pending,null);
 const balanceAbi=parseAbi(['function balanceOf(address) view returns(uint256)']);
 assert.equal(await client.readContract({address:LOAN_TOKEN,abi:balanceAbi,functionName:'balanceOf',args:[owner.address]}),2000_000000n);
 assert.equal(await client.readContract({address:LOAN_TOKEN,abi:balanceAbi,functionName:'balanceOf',args:[bot.address]}),0n);
 assert.equal((await exitTick(io,cfg)).event,'no_liquidity');
 // Bytecode and permission preflights must reject incorrect deployment and broad EOA authority.
 await assert.rejects(createExitIO({...cfg,codeHash:'0x'+'0'.repeat(64)},journal,operatorKey));
 hash=await wallet.writeContract({address:MORPHO_BLUE,abi:morphoAbi,functionName:'setAuthorization',args:[bot.address,true]});await client.waitForTransactionReceipt({hash});
 await assert.rejects(createExitIO(cfg,journal,operatorKey));
 // Reorg the withdrawal away, then emulate a stale receipt backend mixed with the current chain.
 await client.request({method:'evm_revert',params:[snapshotId]});
 await client.request({method:'anvil_mine',params:['0x4']});
 const canonical=await client.getBlock({blockNumber:BigInt(staleReceipt.blockNumber)});
 assert.notEqual(canonical.hash,staleReceipt.blockHash);
 const proxy=createHttpServer(async(req,res)=>{
  let text='';for await(const chunk of req)text+=chunk;
  const call=JSON.parse(text);
  try {
   const result=call.method==='eth_getTransactionReceipt'?staleReceipt:await client.request({method:call.method,params:call.params});
   res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:call.id,result}));
  }catch{res.end(JSON.stringify({jsonrpc:'2.0',id:call.id,error:{code:-32000,message:'local test error'}}));}
 });
 proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
 t.after(()=>new Promise(resolve=>{proxy.closeAllConnections();proxy.close(resolve);}));
 const staleIO=await createExitIO({...cfg,rpcUrl:`http://127.0.0.1:${proxy.address().port}`},journal,operatorKey);
 assert.equal(await staleIO.receipt(result.hash),null,'orphan receipt must not finalize a withdrawal');

});

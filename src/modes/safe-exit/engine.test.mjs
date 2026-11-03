import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exitTick, planWithdrawal } from './engine.mjs';
import { openJournal } from './journal.mjs';
import { exitConfig } from './runtime.mjs';
const hash='0x'+'a'.repeat(64);
const cfg={live:true,maxFeePerGas:10n,maxPriorityFeePerGas:2n,maxGas:100n,maxTxCost:1000n,dailyBudget:2000n,confirmations:3,retryMs:30000};
function fixture() {
 let state={spent:{},pending:null};
 const calls=[];
 const io={
  load:()=>structuredClone(state),save:(next)=>{calls.push('save');state=structuredClone(next);},day:()=> '2026-11-03',time:()=>50000,
  plan:async()=>({assets:100n,shares:0n,estimatedAssets:100n}),fees:async()=>({maxFeePerGas:5n,maxPriorityFeePerGas:1n}),
  simulateAndEstimate:async()=>{calls.push('simulate');return 100n;},balance:async()=>5000n,nonce:async()=>state.pending?8:7,
  sign:async()=>{calls.push('sign');return {hash,raw:'0x1234'};},
  broadcast:async()=>{calls.push('broadcast');},receipt:async()=>null,
 };
 return {io,calls,state:()=>state};
}

test('dry run can plan but never calls fees, simulation, signer or broadcaster',async()=>{
 const {io,calls}=fixture();
 assert.equal((await exitTick(io,{...cfg,live:false})).event,'dry_run');assert.deepEqual(calls,[]);
});
test('simulation precedes signing and durable journal precedes broadcast',async()=>{
 const f=fixture(); assert.equal((await exitTick(f.io,cfg)).event,'withdraw_submitted');
 assert.deepEqual(f.calls,['simulate','sign','save','broadcast']); assert.equal(f.state().pending.hash,hash);
});
test('broadcast timeout preserves signed transaction; restart rebroadcasts same bytes without resigning',async()=>{
 const f=fixture(); f.io.broadcast=async()=>{throw Error('RPC timeout');};
 assert.equal((await exitTick(f.io,cfg)).event,'broadcast_uncertain');
 const original=structuredClone(f.state().pending);f.calls.length=0;
 f.io.time=()=>90000;f.io.broadcast=async(raw)=>{assert.equal(raw,original.raw);f.calls.push('broadcast');};
 assert.equal((await exitTick(f.io,cfg)).event,'pending');assert.deepEqual(f.calls,['save','broadcast']);
});
test('pending or insufficiently confirmed transactions prevent another withdrawal',async()=>{
 const f=fixture();await exitTick(f.io,cfg);f.calls.length=0;
 assert.equal((await exitTick(f.io,cfg)).event,'pending');assert.deepEqual(f.calls,[]);
 f.io.receipt=async()=>({confirmations:2});assert.equal((await exitTick(f.io,cfg)).event,'confirming');
 assert.deepEqual(f.calls,[]);
});
test('reverted receipt is reported accurately and still consumes gas budget',async()=>{
 const f=fixture();await exitTick(f.io,cfg);
 f.io.receipt=async()=>({confirmations:3,status:'reverted',gasUsed:80n,effectiveGasPrice:4n,transactionHash:hash});
 assert.equal((await exitTick(f.io,cfg)).event,'withdraw_reverted');
 assert.equal(f.state().spent['2026-11-03'],'320');assert.equal(f.state().pending,null);
});
test('fee, gas, per-transaction and daily limits stop signing',async()=>{
 for(const overrides of [{maxFeePerGas:4n},{maxPriorityFeePerGas:0n},{maxGas:99n},{maxTxCost:499n},{dailyBudget:499n}]) {
  const f=fixture();await exitTick(f.io,{...cfg,...overrides});assert.ok(!f.calls.includes('sign'));
 }
});
test('simulation failure, external pending nonce and insufficient balance stop signing',async()=>{
 for(const kind of ['simulation','nonce','balance']) {
  const f=fixture();
  if(kind==='simulation') {f.io.simulateAndEstimate=async()=>{throw Error('revert');}; await assert.rejects(exitTick(f.io,cfg));}
  else {if(kind==='nonce')f.io.nonce=async(tag)=>tag==='pending'?8:7;else f.io.balance=async()=>0n;await exitTick(f.io,cfg);}
  assert.ok(!f.calls.includes('sign'));
 }
});
test('journal write failure prevents broadcasting signed transaction',async()=>{
 const f=fixture();f.io.save=()=>{throw Error('disk full');};await assert.rejects(exitTick(f.io,cfg));
 assert.ok(!f.calls.includes('broadcast'));
});
test('a receipt from an earlier day is charged to its reservation day, and nonce rollback halts',async()=>{
 const f=fixture();await exitTick(f.io,cfg);f.io.day=()=> '2026-11-04';
 f.io.receipt=async()=>({confirmations:3,status:'success',gasUsed:80n,effectiveGasPrice:4n,transactionHash:hash});
 assert.equal((await exitTick(f.io,cfg)).event,'withdraw_confirmed');
 assert.equal(f.state().spent['2026-11-03'],'320');assert.equal(f.state().spent['2026-11-04'],undefined);
 await assert.rejects(exitTick(f.io,cfg),/nonce rolled back/);
});
test('liquidity plan handles full and partial exact assets, zero liquidity and threshold',()=>{
 const market=[1000000n,1000000n,900000n];const position=[500000n];
 assert.equal(planWithdrawal(position,market,1n).assets,100000n);
 assert.equal(planWithdrawal(position,[1000000n,1000000n,0n],1n).assets,250000n);
 assert.equal(planWithdrawal(position,[1000000n,1000000n,1000000n],1n),null);
 assert.equal(planWithdrawal(position,market,100001n),null);
});
test('journal lock prevents simultaneous workers; corrupt data and wrong identity fail closed',()=>{
 const dir=mkdtempSync(join(tmpdir(),'morpho-exit-'));const path=join(dir,'state.json');
 try {
  const j=openJournal(path,'test');j.load();assert.equal(statSync(path).mode&0o777,0o600);
  assert.throws(()=>openJournal(path,'test'));j.close();
  const other=openJournal(path,'different');assert.throws(()=>other.load());other.close();
  writeFileSync(path,'broken');const broken=openJournal(path,'test');assert.throws(()=>broken.load());broken.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('configuration is dry by default, rejects main-wallet operator and requires live confirmation',()=>{
 const env={OWNER_ADDRESS:'0x1111111111111111111111111111111111111111',RPC_URL:'https://example.invalid'};
 assert.equal(exitConfig(env).live,false);
 assert.throws(()=>exitConfig(env,true));
 assert.throws(()=>exitConfig({...env,OPERATOR_ADDRESS:env.OWNER_ADDRESS,EXECUTOR_ADDRESS:'0x2222222222222222222222222222222222222222',EXECUTOR_CODE_HASH:hash,LIVE_CONFIRMATION:'WITHDRAW_TO_OWNER'},true));
});

test('deleting an initialized journal never resets spending or pending state',()=>{
 const dir=mkdtempSync(join(tmpdir(),'morpho-lost-state-'));const path=join(dir,'state.json');
 try {
  const j=openJournal(path,'test');j.load();j.close();rmSync(path);
  const reopened=openJournal(path,'test');assert.throws(()=>reopened.load());reopened.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('withdrawal cap forces exact asset amount even with full liquidity',()=>{
 const p=planWithdrawal([500000n],[1000000n,1000000n,0n],1n,100n);
 assert.equal(p.assets,100n);assert.equal(p.shares,0n);
});

test('exit guards preserve actionable fixed reasons without leaking provider messages',async()=>{
 const {ExitError,safeExitError}=await import('./errors.mjs');
 assert.equal(safeExitError(new ExitError('CODE_HASH')).code,'CODE_HASH');
 assert.equal(safeExitError(new ExitError('JOURNAL_LOCKED')).code,'JOURNAL_LOCKED');
 assert.ok(!JSON.stringify(safeExitError(Error('TEST_ONLY_PRIVATE_RPC_URL'))).includes('TEST_ONLY'));
});

test('UTC rollover during preflight or signing rechecks the actual reservation day budget',async()=>{
 for(const stage of ['simulation','signing']) {
  const f=fixture();f.io.save({spent:{'2026-11-04':'1600'},pending:null});f.calls.length=0;
  const change=()=>{f.io.day=()=> '2026-11-04';};
  if(stage==='simulation')f.io.simulateAndEstimate=async()=>{change();return 100n;};
  else f.io.sign=async()=>{change();return {hash,raw:'0x1234'};};
  assert.equal((await exitTick(f.io,cfg)).event,'budget_limit');
  assert.equal(f.state().pending,null);assert.ok(!f.calls.includes('broadcast'));
 }
});
test('interest cannot inflate a capped worker withdrawal because plans use exact assets',()=>{
 const p=planWithdrawal([2000000000n],[1000_000000n,2000000000n,0n],1n,1000_000000n);
 assert.equal(p.shares,0n);assert.ok(p.assets<=1000_000000n);
});
test('pending recovery checks nonce rollback before receipt lookup or rebroadcast',async()=>{
 const f=fixture();f.io.nonce=async()=>8;await exitTick(f.io,cfg);f.calls.length=0;
 const saved=f.state();saved.lastConfirmedNonce=7;f.io.save(saved);f.calls.length=0;
 f.io.nonce=async()=>7;f.io.time=()=>90000;f.io.receipt=async()=>assert.fail('rollback must be checked first');
 await assert.rejects(exitTick(f.io,cfg),/nonce rolled back/);assert.deepEqual(f.calls,[]);
});

test('an apparent receipt cannot finalize while canonical latest nonce still equals pending nonce',async()=>{
 const f=fixture();await exitTick(f.io,cfg);f.calls.length=0;
 f.io.nonce=async()=>7;
 f.io.receipt=async()=>({confirmations:3,status:'success',gasUsed:80n,effectiveGasPrice:4n,transactionHash:hash});
 assert.equal((await exitTick(f.io,cfg)).event,'receipt_inconsistent');
 assert.equal(f.state().pending.hash,hash);assert.deepEqual(f.state().spent,{});assert.deepEqual(f.calls,[]);
});

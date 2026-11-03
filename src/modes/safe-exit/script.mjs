#!/usr/bin/env node
import { config as loadEnv } from 'dotenv';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { exitTick } from './engine.mjs';
import { openJournal } from './journal.mjs';
import { exitConfig, createExitIO } from './runtime.mjs';
import { safeExitError } from './errors.mjs';
import { log } from '../auto-withdraw/safe-monitor.mjs';

async function main() {
  loadEnv({path:process.env.EXIT_ENV_FILE || '.env.exit.local',quiet:true});
  if(process.argv.slice(2).some((arg)=>!['--live','--once'].includes(arg))) throw Error('Unknown option');
  const config=exitConfig(process.env,process.argv.includes('--live'));
  const identity=JSON.stringify({chainId:1,owner:config.owner,executor:config.executor || null,operator:config.operator || null,mode:config.live?'live':'dry'});
  const journal=openJournal(resolve(config.journalPath),identity);
  const controller=new AbortController();
  const stop=()=>controller.abort();
  process.once('SIGINT',stop); process.once('SIGTERM',stop);
  try {
    const io=await createExitIO(config,journal,config.live?process.env.BOT_PRIVATE_KEY:undefined);
    log('exit_started',{mode:config.live?'LIVE':'DRY_RUN',owner:config.owner});
    while(!controller.signal.aborted) {
      try {
        const result=await exitTick(io,config);
        log(result.event,Object.fromEntries(Object.entries(result).filter(([key])=>key!=='event').map(([k,v])=>[k,typeof v==='bigint'?String(v):v])));
      } catch(error) {
        log('exit_error',safeExitError(error));
        // Fail closed: journal/signing/nonce errors must be inspected before restart.
        throw error;
      }
      if(process.argv.includes('--once')) break;
      try {await delay(config.pollMs,undefined,{signal:controller.signal});}
      catch(error) {if(error.name!=='AbortError') throw error;}
    }
  } finally {
    process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
    journal.close();
  }
}
main().catch((error)=>{log('exit_fatal',safeExitError(error));process.exitCode=1;});

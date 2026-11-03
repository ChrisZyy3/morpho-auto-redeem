import { ExitError } from './errors.mjs';
import { openSync, closeSync, writeFileSync, readFileSync, renameSync, unlinkSync, mkdirSync, fsyncSync, existsSync } from 'node:fs';
import { keccak256 } from 'viem';
import { dirname } from 'node:path';

export function openJournal(path, identity) {
  try { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); }
  catch { throw new ExitError('JOURNAL_IO'); }
  // Existing locks require manual investigation. Never auto-steal a potentially live signer lock.
  let lock;
  try { lock = openSync(path + '.lock', 'wx', 0o600); }
  catch (error) { throw new ExitError(error.code==='EEXIST'?'JOURNAL_LOCKED':'JOURNAL_IO'); }
  writeFileSync(lock, String(process.pid));
  let closed = false;
  const writeState = (state) => {
    const temp = path + '.tmp';
    const fd = openSync(temp, 'w', 0o600);
    try { writeFileSync(fd, JSON.stringify(state)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
    if (!existsSync(path + '.initialized')) {
      const marker = openSync(path + '.initialized', 'wx', 0o600);
      try { fsyncSync(marker); } finally { closeSync(marker); }
    }
    const dir = openSync(dirname(path), 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  };
  const save = (state) => {
    try { writeState(state); } catch { throw new ExitError('JOURNAL_IO'); }
  };
  const load = () => {
    let state;
    try { state = JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT' || existsSync(path + '.initialized')) throw new ExitError('JOURNAL_IO');
      state = { identity, spent: {}, pending: null };
      save(state);
    }
    if (state.identity !== identity || !state.spent || typeof state.spent !== 'object' || Array.isArray(state.spent)) throw new ExitError('JOURNAL_INVALID');
    for (const value of Object.values(state.spent)) if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new ExitError('JOURNAL_INVALID');
    if (state.pending && (!/^0x[0-9a-fA-F]{64}$/.test(state.pending.hash) || !/^0x[0-9a-fA-F]+$/.test(state.pending.raw))) throw new ExitError('JOURNAL_INVALID');
    if (state.lastConfirmedNonce !== undefined && (!Number.isSafeInteger(state.lastConfirmedNonce) || state.lastConfirmedNonce < 0)) throw new ExitError('JOURNAL_INVALID');
    if (state.pending && (keccak256(state.pending.raw) !== state.pending.hash ||
      !/^\d{4}-\d{2}-\d{2}$/.test(state.pending.day) ||
      !Number.isSafeInteger(state.pending.lastBroadcastAt) || state.pending.lastBroadcastAt < 0 ||
      !Number.isSafeInteger(state.pending.nonce) || state.pending.nonce < 0 ||
      !/^\d+$/.test(state.pending.reserved))) throw new ExitError('JOURNAL_INVALID');
    return state;
  };
  return { load, save, close() { if (!closed) { closeSync(lock); unlinkSync(path+'.lock'); closed=true; } } };
}

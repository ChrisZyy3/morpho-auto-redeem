import { openSync, closeSync, writeFileSync, readFileSync, renameSync, unlinkSync, mkdirSync, fsyncSync, existsSync } from 'node:fs';
import { keccak256 } from 'viem';
import { dirname } from 'node:path';

export function openJournal(path, identity) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Existing locks require manual investigation. Never auto-steal a potentially live signer lock.
  const lock = openSync(path + '.lock', 'wx', 0o600);
  writeFileSync(lock, String(process.pid));
  let closed = false;
  const save = (state) => {
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
  const load = () => {
    let state;
    try { state = JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT' || existsSync(path + '.initialized')) throw Error('Journal unreadable; manual recovery required');
      state = { identity, spent: {}, pending: null };
      save(state);
    }
    if (state.identity !== identity || !state.spent || typeof state.spent !== 'object' || Array.isArray(state.spent)) throw Error('Journal identity/schema mismatch');
    for (const value of Object.values(state.spent)) if (typeof value !== 'string' || !/^\d+$/.test(value)) throw Error('Invalid journal budget');
    if (state.pending && (!/^0x[0-9a-fA-F]{64}$/.test(state.pending.hash) || !/^0x[0-9a-fA-F]+$/.test(state.pending.raw))) throw Error('Invalid pending transaction');
    if (state.pending && (keccak256(state.pending.raw) !== state.pending.hash ||
      !/^\d{4}-\d{2}-\d{2}$/.test(state.pending.day) ||
      !Number.isSafeInteger(state.pending.nonce) || state.pending.nonce < 0 ||
      !/^\d+$/.test(state.pending.reserved))) throw Error('Invalid pending transaction metadata');
    return state;
  };
  return { load, save, close() { if (!closed) { closeSync(lock); unlinkSync(path+'.lock'); closed=true; } } };
}

import { safeErrorDetails } from '../auto-withdraw/safe-monitor.mjs';
const messages = Object.freeze({
  CONFIG_MISSING: 'Required exit configuration is missing.',
  CONFIG_INVALID: 'Exit configuration or limit is invalid.',
  LIVE_CONFIRMATION: 'Explicit live confirmation is missing.',
  WRONG_CHAIN: 'Ethereum mainnet RPC is required.',
  WRONG_MARKET: 'Configured market tokens do not match.',
  CODE_HASH: 'Executor runtime bytecode hash does not match the verified deployment.',
  IMMUTABLES: 'Executor immutable addresses or market do not match.',
  AUTHORIZATION: 'Authorize only the adapter and revoke broad bot EOA authority.',
  OPERATOR_KEY: 'Local bot key does not match the configured operator.',
  JOURNAL_LOCKED: 'Journal lock exists. Verify the previous process before manual recovery.',
  JOURNAL_IO: 'Journal could not be persisted or read; inspect disk and saved state.',
  JOURNAL_INVALID: 'Journal identity or state is invalid; manual recovery required.',
  NONCE_ROLLBACK: 'Confirmed nonce rolled back; inspect chain and pending transaction before recovery.',
  RECEIPT_MISMATCH: 'Receipt transaction hash does not match the pending transaction.',
  DELIVERY_MISSING: 'Successful receipt has no USDC delivery from Morpho to owner.',
});
export class ExitError extends Error {
  constructor(code) { super(messages[code] || messages.CONFIG_INVALID); this.code=code; }
}
export function safeExitError(error) {
  if(error instanceof ExitError && Object.hasOwn(messages,error.code)) return {errorType:'ExitError',code:error.code,message:messages[error.code]};
  return safeErrorDetails(error);
}

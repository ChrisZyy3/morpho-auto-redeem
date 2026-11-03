import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { encodeAbiParameters, encodeFunctionData, parseAbiParameters, HttpRequestError } from 'viem';
import {
  ABI, MARKET_ID, LOAN_TOKEN, COLLATERAL_TOKEN, parseSettings, runMonitor, safeErrorDetails,
} from './safe-monitor.mjs';

const owner = '0x1111111111111111111111111111111111111111';
const settings = parseSettings({ RPC_URL: 'http://127.0.0.1:1', OWNER_ADDRESS: owner, HEARTBEAT_MS: '1000', STALE_MS: '2000' });
const market = [100_000_000_000n, 100_000_000_000_000_000n, 100_000_000_000n, 0n, 1n, 0n];
const position = [70_164_000_000_000_000n, 0n, 0n];
const params = [LOAN_TOKEN, COLLATERAL_TOKEN, owner, owner, 0n];

async function scenario({ blocks = [100n, 101n], failAt = [], empty = false, liquidity = 0n } = {}) {
  const events = [];
  const controller = new AbortController();
  let tick = 0;
  let clock = 0;
  const pins = [];
  let inFlight = 0;
  const client = {
    getChainId: async () => 1,
    getBlockNumber: async (options) => {
      assert.equal(inFlight, 0, 'a new tick must not overlap the previous reads');
      assert.deepEqual(options, { cacheTime: 0 });
      if (failAt.includes(tick)) throw new HttpRequestError({ url: 'https://example.invalid/v2/TEST_ONLY_RPC_SECRET' });
      return blocks[tick];
    },
    readContract: async (args) => {
      if (args.functionName === 'idToMarketParams') return params;
      inFlight++;
      await Promise.resolve();
      pins.push([args.functionName, args.blockNumber]);
      inFlight--;
      return args.functionName === 'market'
        ? [market[0], market[1], market[2] - liquidity, ...market.slice(3)]
        : empty ? [0n, 0n, 0n] : position;
    },
  };
  await runMonitor(settings, {
    client, signal: controller.signal, now: () => clock,
    emit: (event, data) => events.push({ event, ...data }),
    wait: async () => { clock += 1000; if (++tick >= blocks.length) controller.abort(); },
  });
  return { events, pins };
}

test('initial snapshot confirms the 70,164 USDC position even with no liquidity', async () => {
  const { events, pins } = await scenario();
  assert.equal(events.find((e) => e.event === 'snapshot').ownerSupplyUsdcApprox, '70164');
  assert.equal(events.find((e) => e.event === 'snapshot').possibleWithdrawUsdcApprox, '0');
  assert.equal(events.find((e) => e.event === 'status').health, 'healthy');
  assert.deepEqual(pins, [['market', 100n], ['position', 100n], ['market', 101n], ['position', 101n]]);
});

test('unchanged block raises a stale warning; progress raises recovery once', async () => {
  const { events } = await scenario({ blocks: [100n, 100n, 100n, 101n] });
  assert.equal(events.filter((e) => e.event === 'head_stale').length, 1);
  assert.equal(events.filter((e) => e.event === 'head_recovered').length, 1);
  assert.equal(events.filter((e) => e.event === 'status')[1].health, 'stale');
  assert.equal(events.filter((e) => e.event === 'status').at(-1).health, 'healthy');
});

test('repeated RPC failure stays observable without leaking credentials and recovers', async () => {
  const { events } = await scenario({ blocks: [100n, 101n, 102n, 103n], failAt: [1, 2] });
  assert.equal(events.filter((e) => e.event === 'rpc_error').length, 1);
  assert.equal(events.filter((e) => e.event === 'rpc_recovered').length, 1);
  const failedStatus = events.filter((e) => e.event === 'status')[1];
  assert.equal(failedStatus.health, 'rpc_error');
  assert.equal(failedStatus.consecutiveErrors, 2);
  assert.equal(failedStatus.snapshot.block, '100');
  assert.equal(failedStatus.lastSuccessfulReadAt, new Date(0).toISOString());
  assert.ok(!JSON.stringify(events).includes('TEST_ONLY_RPC_SECRET'));
});

test('empty position exits cleanly without sleeping or restarting itself', async () => {
  const { events } = await scenario({ empty: true });
  assert.equal(events.at(-1).event, 'stopped');
  assert.equal(events.at(-1).reason, 'position_empty');
  assert.equal(events.filter((e) => e.event === 'position_empty').length, 1);
});

test('liquidity above threshold alerts without sending a transaction', async () => {
  const { events } = await scenario({ liquidity: 2_000_000_000n });
  const alert = events.find((e) => e.event === 'liquidity_detected');
  assert.equal(alert.possibleWithdrawUsdcApprox, '2000');
  assert.equal(events.filter((e) => e.event === 'liquidity_detected').length, 1);
});

test('settings reject invalid thresholds and URLs without echoing user input', () => {
  for (const value of ['0', '-1', 'NaN', '0.0000001', '1.0000001']) {
    assert.throws(() => parseSettings({ RPC_URL: settings.rpcUrl, OWNER_ADDRESS: owner, MIN_ALERT_USDC: value }));
  }
  for (const value of ['https://', 'file:///TEST_ONLY_SECRET']) {
    assert.throws(() => parseSettings({ RPC_URL: value, OWNER_ADDRESS: owner }), (error) => !error.message.includes(value));
  }
});

test('provider errors never expose URL, cause, body, stack or custom names', () => {
  const secret = 'TEST_ONLY_SECRET';
  const error = new HttpRequestError({
    url: `https://user:${secret}@example.invalid/v2/${secret}?key=${secret}`,
    body: { secret }, cause: Error(secret), details: secret,
  });
  assert.ok(error.message.includes(secret), 'regression fixture must contain a real viem URL leak');
  assert.ok(!JSON.stringify(safeErrorDetails(error)).includes(secret));
  assert.ok(!JSON.stringify(safeErrorDetails({ name: secret, message: secret })).includes(secret));
});

test('wrong chain and wrong market are rejected before polling', async () => {
  for (const chainId of [10, 1]) {
    await assert.rejects(runMonitor(settings, {
      client: {
        getChainId: async () => chainId,
        readContract: async () => [owner, COLLATERAL_TOKEN],
        getBlockNumber: () => assert.fail('must not poll an unverified market'),
      },
      emit: () => assert.fail('must not report started'),
    }));
  }
});

async function mockRpc(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('real viem transport only reads RPC, bypasses block cache and pins reads', async (t) => {
  const requests = [];
  let blockRequests = 0;
  const selectors = Object.fromEntries(['market', 'position', 'idToMarketParams'].map((name) => [
    encodeFunctionData({ abi: ABI, functionName: name, args: name === 'position' ? [MARKET_ID, owner] : [MARKET_ID] }).slice(0, 10), name,
  ]));
  const rpcUrl = await mockRpc(t, async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const call = JSON.parse(body);
    requests.push(call);
    let result;
    if (call.method === 'eth_chainId') result = '0x1';
    else if (call.method === 'eth_blockNumber') result = '0x' + (100 + blockRequests++).toString(16);
    else if (call.method === 'eth_call') {
      const name = selectors[call.params[0].data.slice(0, 10)];
      if (name === 'idToMarketParams') result = encodeAbiParameters(parseAbiParameters('address,address,address,address,uint256'), params);
      else if (name === 'market') result = encodeAbiParameters(parseAbiParameters('uint128,uint128,uint128,uint128,uint128,uint128'), market);
      else if (name === 'position') result = encodeAbiParameters(parseAbiParameters('uint256,uint128,uint128'), blockRequests === 1 ? position : [0n, 0n, 0n]);
    }
    if (result === undefined) { res.writeHead(400); res.end(); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
  });
  const events = [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    await runMonitor({ ...settings, rpcUrl }, {
      emit: (event, data) => events.push({ event, ...data }), wait: async () => {}, signal: controller.signal,
    });
  } finally { clearTimeout(timeout); }
  assert.equal(blockRequests, 2, 'two immediate polls must reach RPC, not a 4 second cache');
  assert.equal(events.at(-1).reason, 'position_empty');
  assert.ok(requests.every((r) => ['eth_chainId', 'eth_blockNumber', 'eth_call'].includes(r.method)));
  const pinnedReads = requests.filter((r) => r.method === 'eth_call' && r.params[1] !== 'latest');
  assert.deepEqual(pinnedReads.map((r) => r.params[1]), ['0x64', '0x64', '0x65', '0x65']);
});

test('actual CLI startup failure emits sanitized JSON and nonzero exit', async (t) => {
  const rpcUrl = await mockRpc(t, (_req, res) => { res.writeHead(401); res.end('TEST_ONLY_PROVIDER_SECRET'); });
  const child = spawn(process.execPath, ['src/modes/auto-withdraw/safe-monitor.mjs'], {
    cwd: new URL('../../../', import.meta.url),
    env: { PATH: process.env.PATH, RPC_URL: `${rpcUrl}/v2/TEST_ONLY_URL_SECRET`, OWNER_ADDRESS: owner },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  const [code] = await once(child, 'exit');
  clearTimeout(timer);
  assert.equal(code, 1);
  assert.equal(stderr, '');
  assert.equal(JSON.parse(stdout).event, 'fatal');
  assert.ok(!(stdout + stderr).includes('TEST_ONLY_'));
});

test('actual CLI prints a zero-liquidity snapshot and stops promptly during a long poll sleep', async (t) => {
  const rpcUrl = await mockRpc(t, async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const call = JSON.parse(body);
    let result;
    if (call.method === 'eth_chainId') result = '0x1';
    else if (call.method === 'eth_blockNumber') result = '0x64';
    else if (call.method === 'eth_call') {
      const selector = call.params[0].data.slice(0, 10);
      if (selector === encodeFunctionData({ abi: ABI, functionName: 'idToMarketParams', args: [MARKET_ID] }).slice(0, 10)) {
        result = encodeAbiParameters(parseAbiParameters('address,address,address,address,uint256'), params);
      } else if (selector === encodeFunctionData({ abi: ABI, functionName: 'market', args: [MARKET_ID] }).slice(0, 10)) {
        result = encodeAbiParameters(parseAbiParameters('uint128,uint128,uint128,uint128,uint128,uint128'), market);
      } else {
        result = encodeAbiParameters(parseAbiParameters('uint256,uint128,uint128'), position);
      }
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
  });
  const child = spawn(process.execPath, ['src/modes/auto-withdraw/safe-monitor.mjs'], {
    cwd: new URL('../../../', import.meta.url),
    env: { PATH: process.env.PATH, RPC_URL: rpcUrl, OWNER_ADDRESS: owner, POLL_MS: '60000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stdout = '';
  let stderr = '';
  let signalled = false;
  child.stdout.on('data', (data) => {
    stdout += data;
    if (!signalled && stdout.includes('"event":"snapshot"')) {
      signalled = true;
      child.kill('SIGTERM');
    }
  });
  child.stderr.on('data', (data) => { stderr += data; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  const [code] = await once(child, 'exit');
  clearTimeout(timer);
  assert.equal(code, 0);
  assert.equal(stderr, '');
  const events = stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(events.find((e) => e.event === 'snapshot').ownerSupplyUsdcApprox, '70164');
  assert.equal(events.at(-1).reason, 'signal');
});

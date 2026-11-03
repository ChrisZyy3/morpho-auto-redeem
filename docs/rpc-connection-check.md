# RPC connection diagnosis (Mac mini, read-only)

No Bot wallet, private key, authorization or ETH is needed for this check.

## Findings from 2026-11-03

The configured local LaunchAgent forced Node's experimental environment-proxy agent
through the system HTTP proxy. A controlled simultaneous 35-second run of identical
monitor code against PublicNode showed direct mode healthy while proxy mode emitted
an RPC error and recovery. Independent curl probes also saw direct PublicNode pass
when its proxy route timed out. This supports removing the unnecessary proxy hop on
this machine; it does not establish that a public provider or network is infallible.

Other public endpoints were not blindly adopted as fallbacks: Merkle returned HTTP
429 / RPC -32005, Llama returned HTTP 525, and dRPC/1RPC routes did not complete the
full chain/head/market sequence. Flashbots passed chain/head but rejected the
required market eth_call with HTTP 403 / RPC -32601; it was not used as a read fallback. An endpoint returning a chain ID alone is not enough.

The local service was changed to direct mode: no `--use-env-proxy`, and
`NODE_USE_ENV_PROXY=0`. A backup of its previous local plist was retained outside Git.
Global macOS proxy settings were not changed. The portable repository plist already
uses direct Node HTTP by default.

## Repeatable check

Use Node 22+ with the read-only `.env` containing RPC_URL. The probe verifies chain 1,
market token pair, uncached head and a market read pinned to that head. It never sends
a transaction or prints RPC credentials. Exit 0 means all samples passed, not a
long-term uptime guarantee.

```bash
NODE_USE_ENV_PROXY=0 node scripts/check-rpc.mjs
```

For a controlled proxy comparison, only if that route is needed on your network:

```bash
HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 \
  node --use-env-proxy scripts/check-rpc.mjs
```

`RPC_PROBE_SAMPLES=5` is the default; 1..60 is supported. No endpoint URL, request
headers or arbitrary provider error details are printed. Do not paste .env files or
raw private-provider errors into issue reports.

After a route change check the LaunchAgent's new `started` event, initial snapshot,
multiple `status` entries, advancing block numbers, and absence of new RPC/stale
warnings. Keep monitoring: a short green probe does not prove sustained availability.


## Post-change observation

After restarting the actual LaunchAgent in direct mode at 08:33:15 UTC (16:33:15
Asia/Shanghai), the first 10 minutes produced 20 status samples, one transient RPC
error followed by automatic recovery, no stale-head warning, and a healthy latest
status at 08:43:29 UTC. A repeated direct 3-sample chain/head/market probe passed.
This restores useful monitoring and removes the failing proxy hop; it does not
prove zero packet loss or a public-RPC availability SLA. Do not equate sample counts
with an exact uptime percentage, or latest stored balances with executable liquidity.

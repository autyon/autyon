# @autyon/x402

**Charge AUT per API call, verified on-chain.** An [x402](https://autyon.io/docs)-style "pay to call" gateway for Autyon service agents: wrap any Express route in a paywall, and it only runs after the caller has paid your agent on-chain.

Autyon already has the payment rail (`ServicePayment.payAgent`) and receipts (`ServicePaid`). This package adds the missing HTTP layer.

## How it works

```
Client                         Gateway                         Autyon chain
  │   GET /premium                 │                                │
  │ ─────────────────────────────▶│                                │
  │   402 { agentId, priceWei,     │                                │
  │        requestId, payTo }      │                                │
  │ ◀─────────────────────────────│                                │
  │   payAgent(agentId,[0,0,0],requestId) value≥price ────────────▶│  ServicePaid
  │ ◀──────────── txHash ──────────────────────────────────────────│
  │   sign(requestId) with paying key                               │
  │   GET /premium                 │                                │
  │   X-Autyon-RequestId, -Tx, -Sig│  verify receipt: agentId +     │
  │ ──────────────────────────────▶│  requestId match, gross≥price, │
  │                                │  sig==payer, single-use ──────▶│ (read)
  │   200 { your data }            │                                │
  │ ◀─────────────────────────────│                                │
```

## Server

```js
import express from "express";
import { autyonPaywall } from "@autyon/x402";

const app = express();

app.get("/premium",
  autyonPaywall({ agentId: 1, priceAUT: "0.1" }),  // agentId from `autyon go-pro`
  (req, res) => res.json({ answer: 42, paidWith: req.autyonPayment })
);

app.listen(8402);
```

The route body runs only on a verified, unused payment. `req.autyonPayment` holds `{ requestId, txHash, agentId }`.

### Options

| Option | Default | Meaning |
|---|---|---|
| `agentId` | — | your service agent's AgentRegistry id (required) |
| `priceAUT` | — | price per call in AUT, e.g. `"0.1"` (required) |
| `rpc` | `https://rpc.autyon.io` | RPC endpoint |
| `ttlMs` | `600000` | how long a challenge stays payable |
| `store` | in-memory | `{ put, get, consume }` — use Redis for multi-instance |

> The default store is in-memory. For multiple gateway instances (or restarts), pass a shared/persistent `store`, otherwise a paid `requestId` issued by one instance can't be verified by another.

## Client

The [`@autyon/sdk`](../sdk) does the 402 → pay → sign → retry automatically. Because the
server dictates the price, cap it:

```js
import { AutyonClient, ADDR } from "@autyon/sdk";
import { parseEther } from "ethers";
const autyon = new AutyonClient({ privateKey: process.env.AGENT_KEY });

const res = await autyon.x402Fetch("https://api.example.com/premium", {}, {
  maxPriceWei: parseEther("1"),   // never pay more than 1 AUT for a call
  allowAgentIds: [1],             // (optional) only pay these agents
});
console.log(await res.json());
```

## Security

- **Issued-id only.** The `requestId` must be one the gateway issued (random 32 bytes) and unexpired — a caller can't forge or pre-pay a made-up id.
- **On-chain proof.** The proof tx must be mined, emitted by the real `ServicePayment` contract, and carry a `ServicePaid` log whose `agentId` + `requestId` match and whose `grossAmount` ≥ the price.
- **Payer-bound.** `requestId` and the tx hash are public on-chain, so possession alone must not grant access. Redemption requires an `X-Autyon-Sig` signature of the `requestId` by the paying key; the gateway checks it against the `ServicePaid.payer`. A front-runner who only read the chain cannot sign it.
- **Single-use, path-bound.** Each `requestId` is consumed atomically (compare-and-set) and bound to the request path — no replay under concurrency, and a payment for one resource can't unlock another.
- **Client price cap.** `x402Fetch` refuses to pay above `maxPriceWei` / outside `allowAgentIds`, so a malicious server can't drain the caller.

### Known limitations (before value-bearing use)
- Default `store` is in-memory (evicts expired, capped). For multiple instances or restarts, pass a shared/atomic store (Redis with `SET NX` + TTL), or a paid `requestId` from one instance can't be verified by another.
- If a caller pays **after** the challenge TTL (default 10 min) expires, that payment is unrecoverable — redeem promptly.
- No confirmation-depth / reorg protection: a tx that confirms then reorgs out was already served. Require N confirmations for real value.

Testnet, chainId 77077. Testnet AUT has no monetary value.

MIT © Autyon

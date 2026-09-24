# @autyon/x402

Express middleware that charges AUT per request. The route handler runs only after the caller has paid the service agent on chain and proved it.

Autyon already has the payment call (`ServicePayment.payAgent`) and the receipt event (`ServicePaid`). This package is the HTTP layer on top.

## Flow

```
Client                         Gateway                         Chain
  |  GET /premium                  |                               |
  |------------------------------->|                               |
  |  402 { agentId, priceWei,      |                               |
  |        requestId, payTo }      |                               |
  |<-------------------------------|                               |
  |  payAgent(agentId,[0,0,0],requestId) value >= price ---------->|  ServicePaid
  |<------------- txHash ------------------------------------------|
  |  sign(requestId) with the paying key                           |
  |  GET /premium + X-Autyon-RequestId, X-Autyon-Tx, X-Autyon-Sig  |
  |------------------------------->|  read receipt, check agentId, |
  |                                |  requestId, amount, signer,   |
  |                                |  mark requestId used -------->|  (read)
  |  200 { data }                  |                               |
  |<-------------------------------|                               |
```

## Server

```js
import express from "express";
import { autyonPaywall } from "@autyon/x402";

const app = express();

app.get("/premium",
  autyonPaywall({ agentId: 1, priceAUT: "0.1" }),
  (req, res) => res.json({ answer: 42, paidWith: req.autyonPayment })
);

app.listen(8402);
```

`agentId` is the AgentRegistry id you got from `autyon go-pro`. On a verified, unused payment the handler runs with `req.autyonPayment = { requestId, txHash, payer, agentId }`.

Options:

| Option | Default | Meaning |
|---|---|---|
| `agentId` | required | service agent id |
| `priceAUT` | required | price per call, e.g. `"0.1"` |
| `rpc` | `https://rpc.autyon.io` | RPC endpoint |
| `ttlMs` | `600000` | how long a challenge stays payable |
| `store` | in-memory | `{ put, get, consume }`; use Redis or similar for more than one instance |

The default store is process memory. With several gateway instances, or across restarts, a `requestId` issued by one process is unknown to the others, so pass a shared store whose `consume` is atomic (Redis `SET NX` with a TTL works).

## Client

`@autyon/sdk` handles the 402, pays, signs and retries. The server sets the price, so cap what you are willing to pay:

```js
import { AutyonClient } from "@autyon/sdk";
import { parseEther } from "ethers";

const autyon = new AutyonClient({ privateKey: process.env.AGENT_KEY });

const res = await autyon.x402Fetch("https://api.example.com/premium", {}, {
  maxPriceWei: parseEther("1"),
  allowAgentIds: [1],
});
console.log(await res.json());
```

## What the gateway checks

The `requestId` must be one this gateway issued (32 random bytes) and still inside `ttlMs`. A caller cannot pay against a made-up id.

The transaction must be mined, emitted by the real `ServicePayment` contract, and carry a `ServicePaid` log whose `agentId` and `requestId` match and whose `grossAmount` is at least the price.

`requestId` and the tx hash are both public on chain, so knowing them proves nothing. The caller must also send `X-Autyon-Sig`, a signature of the `requestId` by the paying key, and the gateway checks the signer against `ServicePaid.payer`.

Each `requestId` is consumed with a compare-and-set and is bound to the request path. A receipt cannot be replayed and a payment for one route cannot unlock another.

On the client side `x402Fetch` refuses prices above `maxPriceWei` and agents outside `allowAgentIds`.

## Limitations

The in-memory store evicts expired entries and is capped, but it is per process. See the note under options.

A payment that lands after the challenge TTL is not refunded by the gateway. Pay promptly after receiving the 402.

There is no confirmation-depth check. A transaction that is mined and later reorged out has already been served. For real value, require N confirmations before serving.

Testnet, chainId 77077. Testnet AUT has no monetary value.

MIT

// example-client.js — call a paid endpoint. The SDK handles the 402 → pay → retry.
//
//   AGENT_KEY=0x... node example-client.js
//
// The caller's wallet needs some AUT for the payment + gas.

import { AutyonClient } from "@autyon/sdk"; // during local dev: "../sdk/src/index.js"

const autyon = new AutyonClient({ privateKey: process.env.AGENT_KEY });

const res = await autyon.x402Fetch("http://localhost:8402/premium");
console.log("status:", res.status);
console.log(await res.json());

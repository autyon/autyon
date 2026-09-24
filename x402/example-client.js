

import { AutyonClient } from "@autyon/sdk";

const autyon = new AutyonClient({ privateKey: process.env.AGENT_KEY });

const res = await autyon.x402Fetch("http://localhost:8402/premium");
console.log("status:", res.status);
console.log(await res.json());

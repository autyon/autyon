// paywall.js — x402 "pay to call" gateway for Autyon service agents.
//
//   import { autyonPaywall } from "@autyon/x402";
//   app.get("/premium", autyonPaywall({ agentId: 1, priceAUT: "0.1" }), (req, res) => {
//     res.json({ answer: 42 });               // only runs after a verified on-chain payment
//   });
//
// Flow: an unpaid request gets HTTP 402 with a challenge { agentId, priceWei, requestId,
// payTo }. The caller pays ServicePayment.payAgent(agentId, [0,0,0], requestId) with
// value >= price, then retries with headers X-Autyon-RequestId + X-Autyon-Tx. The gateway
// verifies the tx receipt on-chain and, if valid and unused, serves the response.
//
// Money-safety rules enforced here:
// - The requestId must be one THIS gateway issued (random 32 bytes) and not expired.
// - The proof tx must be mined (status 1), emitted by the real ServicePayment contract,
//   and carry a ServicePaid log whose agentId + requestId match and whose grossAmount
//   (what the caller paid) is >= the advertised price.
// - Each requestId is single-use (marked consumed) — no replay, and a payment for one
//   resource cannot unlock another (requestId is bound to the request path).

import { JsonRpcProvider, Interface, parseEther, hexlify, randomBytes, verifyMessage } from "ethers";

const SERVICE = "0x3218003233f418bb83829c9627494b49ef0edf96"; // ServicePayment
const CHAIN_ID = 77077;
const DEFAULT_RPC = "https://rpc.autyon.io";
const SERVICE_ABI = [
  "event ServicePaid(uint256 indexed agentId, address indexed payer, address indexed agentOwner, uint256 grossAmount, uint256 taxAmount, uint256 referralAmount, uint256 netToAgent, bytes32 requestId)",
];

/** Default in-memory challenge store. Swap for Redis in production (multi-instance).
 *  `consume` is an atomic compare-and-set: it returns true only for the caller that
 *  flips pending -> consumed, so a single payment can be redeemed exactly once even
 *  under concurrent requests. `put` evicts expired entries and caps total size so
 *  unpaid requests cannot grow the map without bound. */
function memoryStore(max = 10_000) {
  const m = new Map();
  return {
    async put(id, v) {
      const now = Date.now();
      if (m.size >= max) for (const [k, e] of m) { if (e.exp < now) m.delete(k); if (m.size < max) break; }
      if (m.size >= max) m.delete(m.keys().next().value); // hard cap: drop oldest
      m.set(id, v);
    },
    async get(id) { return m.get(id); },
    // Atomic single-use flip. Returns true iff this call consumed a still-pending entry.
    async consume(id) {
      const v = m.get(id);
      if (!v || v.status === "consumed") return false;
      v.status = "consumed"; m.set(id, v);
      return true;
    },
  };
}

/**
 * @param {object} opts
 * @param {number|string|bigint} opts.agentId  the service agent's AgentRegistry id.
 * @param {string} opts.priceAUT               price per call, in AUT (e.g. "0.1").
 * @param {string} [opts.rpc]
 * @param {string} [opts.service]              ServicePayment address override.
 * @param {number} [opts.ttlMs]                challenge lifetime (default 10 min).
 * @param {object} [opts.store]                { put, get, consume } — default in-memory.
 */
export function autyonPaywall(opts = {}) {
  const agentId = BigInt(opts.agentId);
  const priceWei = parseEther(String(opts.priceAUT));
  const service = (opts.service || SERVICE).toLowerCase();
  const ttlMs = opts.ttlMs ?? 10 * 60 * 1000;
  const provider = new JsonRpcProvider(opts.rpc || DEFAULT_RPC, CHAIN_ID, { staticNetwork: true });
  const iface = new Interface(SERVICE_ABI);
  const store = opts.store || memoryStore();

  function challenge(req, res) {
    const requestId = hexlify(randomBytes(32));
    store.put(requestId, { resource: req.path, priceWei: priceWei.toString(), status: "pending", exp: Date.now() + ttlMs });
    res.status(402).json({
      x402Version: 1,
      error: "payment required",
      agentId: agentId.toString(),
      priceWei: priceWei.toString(),
      priceAUT: String(opts.priceAUT),
      payTo: service,
      chainId: CHAIN_ID,
      requestId,
      resource: req.path,
      how: "call ServicePayment.payAgent(agentId, [0,0,0], requestId) with value>=priceWei, then retry with headers X-Autyon-RequestId and X-Autyon-Tx",
    });
  }

  return async function paywall(req, res, next) {
    try {
      const requestId = req.header("X-Autyon-RequestId");
      const txHash = req.header("X-Autyon-Tx");
      const sig = req.header("X-Autyon-Sig");
      if (!requestId || !txHash) return challenge(req, res);
      if (!/^0x[0-9a-fA-F]{64}$/.test(requestId)) return res.status(400).json({ error: "bad requestId" });
      if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return res.status(400).json({ error: "bad tx hash" });
      if (!sig) return res.status(400).json({ error: "missing X-Autyon-Sig (sign the requestId with the paying key)" });

      const rec = await store.get(requestId);
      if (!rec || rec.exp < Date.now()) return challenge(req, res);          // unknown/expired -> new challenge
      if (rec.status === "consumed") return res.status(402).json({ error: "payment already used" });
      if (rec.resource !== req.path) return res.status(403).json({ error: "payment is for a different resource" });

      const receipt = await provider.getTransactionReceipt(txHash);
      if (!receipt || receipt.status !== 1) return res.status(402).json({ error: "payment tx not confirmed yet" });

      let payer = null;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== service) continue;               // must be the real ServicePayment
        let parsed; try { parsed = iface.parseLog(log); } catch { continue; }
        if (parsed?.name !== "ServicePaid") continue;
        if (parsed.args.requestId.toLowerCase() !== requestId.toLowerCase()) continue;
        if (parsed.args.agentId !== agentId) continue;                     // must pay THIS agent
        if (parsed.args.grossAmount < BigInt(rec.priceWei)) continue;      // must pay at least the price
        payer = parsed.args.payer; break;
      }
      if (!payer) return res.status(402).json({ error: "no matching payment found in that transaction" });

      // Bind redemption to the payer: only the wallet that paid can sign the requestId.
      // (requestId and txHash are public on-chain, so possession alone must not grant access.)
      let recovered;
      try { recovered = verifyMessage(requestId, sig); } catch { return res.status(400).json({ error: "bad signature" }); }
      if (recovered.toLowerCase() !== payer.toLowerCase())
        return res.status(403).json({ error: "signature is not from the payer" });

      // Atomic single-use: only the winner of the race proceeds.
      if (!(await store.consume(requestId))) return res.status(402).json({ error: "payment already used" });
      req.autyonPayment = { requestId, txHash, payer, agentId: agentId.toString() };
      return next();
    } catch (e) {
      return res.status(500).json({ error: "paywall error: " + (e.message || String(e)) });
    }
  };
}

export { memoryStore };

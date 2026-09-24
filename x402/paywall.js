

import { JsonRpcProvider, Interface, parseEther, hexlify, randomBytes, verifyMessage } from "ethers";

const SERVICE = "0x3218003233f418bb83829c9627494b49ef0edf96";
const CHAIN_ID = 77077;
const DEFAULT_RPC = "https://rpc.autyon.io";
const SERVICE_ABI = [
  "event ServicePaid(uint256 indexed agentId, address indexed payer, address indexed agentOwner, uint256 grossAmount, uint256 taxAmount, uint256 referralAmount, uint256 netToAgent, bytes32 requestId)",
];

function memoryStore(max = 10_000) {
  const m = new Map();
  return {
    async put(id, v) {
      const now = Date.now();
      if (m.size >= max) for (const [k, e] of m) { if (e.exp < now) m.delete(k); if (m.size < max) break; }
      if (m.size >= max) m.delete(m.keys().next().value);
      m.set(id, v);
    },
    async get(id) { return m.get(id); },
    async consume(id) {
      const v = m.get(id);
      if (!v || v.status === "consumed") return false;
      v.status = "consumed"; m.set(id, v);
      return true;
    },
  };
}

export function autyonPaywall(opts = {}) {
  const agentId = BigInt(opts.agentId);
  const priceWei = parseEther(String(opts.priceAUT));
  const service = (opts.service || SERVICE).toLowerCase();
  const ttlMs = opts.ttlMs ?? 10 * 60 * 1000;
  const provider = new JsonRpcProvider(opts.rpc || DEFAULT_RPC, CHAIN_ID, { staticNetwork: true });
  const iface = new Interface(SERVICE_ABI);
  const store = opts.store || memoryStore();

  async function challenge(req, res) {
    const requestId = hexlify(randomBytes(32));
    await store.put(requestId, { resource: req.path, priceWei: priceWei.toString(), status: "pending", exp: Date.now() + ttlMs });
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
      if (!requestId || !txHash) return await challenge(req, res);
      if (!/^0x[0-9a-fA-F]{64}$/.test(requestId)) return res.status(400).json({ error: "bad requestId" });
      if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return res.status(400).json({ error: "bad tx hash" });
      if (!sig) return res.status(400).json({ error: "missing X-Autyon-Sig (sign the requestId with the paying key)" });

      const rec = await store.get(requestId);
      if (!rec || rec.exp < Date.now()) return await challenge(req, res);
      if (rec.status === "consumed") return res.status(402).json({ error: "payment already used" });
      if (rec.resource !== req.path) return res.status(403).json({ error: "payment is for a different resource" });

      const receipt = await provider.getTransactionReceipt(txHash);
      if (!receipt || receipt.status !== 1) return res.status(402).json({ error: "payment tx not confirmed yet" });

      let payer = null;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== service) continue;
        let parsed; try { parsed = iface.parseLog(log); } catch { continue; }
        if (parsed?.name !== "ServicePaid") continue;
        if (parsed.args.requestId.toLowerCase() !== requestId.toLowerCase()) continue;
        if (parsed.args.agentId !== agentId) continue;
        if (parsed.args.grossAmount < BigInt(rec.priceWei)) continue;
        payer = parsed.args.payer; break;
      }
      if (!payer) return res.status(402).json({ error: "no matching payment found in that transaction" });

      let recovered;
      try { recovered = verifyMessage(requestId, sig); } catch { return res.status(400).json({ error: "bad signature" }); }
      if (recovered.toLowerCase() !== payer.toLowerCase())
        return res.status(403).json({ error: "signature is not from the payer" });

      if (!(await store.consume(requestId))) return res.status(402).json({ error: "payment already used" });
      req.autyonPayment = { requestId, txHash, payer, agentId: agentId.toString() };
      return next();
    } catch (e) {
      return res.status(500).json({ error: "paywall error: " + (e.message || String(e)) });
    }
  };
}

export { memoryStore };

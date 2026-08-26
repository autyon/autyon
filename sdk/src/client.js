// client.js — AutyonClient: a typed wrapper over Autyon's on-chain agent primitives.
//
//   import { AutyonClient } from "@autyon/sdk";
//   const autyon = new AutyonClient({ privateKey: process.env.AGENT_KEY });
//   await autyon.whoami();
//
// The caller holds the key, so there is no policy/cap layer here (that belongs to
// the MCP, where an LLM is an untrusted caller). Methods return structured data;
// every state-changing call resolves after the tx is mined and includes txHash + a
// block-explorer URL.

import {
  JsonRpcProvider, Wallet, Contract, parseEther, formatEther, isAddress, ZeroAddress, id,
} from "ethers";
import {
  CHAIN_ID, DEFAULT_RPC, DEFAULT_API, SCAN, ADDR, ABI, JOB_STATUS, PROFILE_KEYS,
} from "./contracts.js";

const GAS = { gasPrice: 1_000_000_000n }; // flat 1 gwei, zeroBaseFee chain
const TX_TIMEOUT_MS = 120_000;
const ZERO32 = "0x" + "0".repeat(64);

async function fetchT(url, ms = 8000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { signal: ac.signal }); }
  finally { clearTimeout(t); }
}
const clean = (n) => String(n || "").trim().toLowerCase().replace(/\.agent$/, "");
function validLabel(l) {
  return typeof l === "string" && l.length >= 3 && l.length <= 63 &&
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(l) && !l.includes("--") && !/^0x/i.test(l);
}
function humanDuration(secs) {
  secs = Number(secs);
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export class AutyonClient {
  /**
   * @param {object} opts
   * @param {string} opts.privateKey  0x-prefixed private key of the agent wallet.
   * @param {string} [opts.rpc]       RPC URL (default https://rpc.autyon.io).
   * @param {string} [opts.api]       Name-service API (default https://api.autyon.io).
   */
  constructor({ privateKey, rpc = DEFAULT_RPC, api = DEFAULT_API } = {}) {
    if (!privateKey) throw new Error("AutyonClient requires a privateKey.");
    this.provider = new JsonRpcProvider(rpc, CHAIN_ID, { staticNetwork: true });
    this.signer = new Wallet(privateKey, this.provider);
    this.api = api;
    this.address = this.signer.address;
  }

  /** Generate a fresh random wallet; returns { address, privateKey }. */
  static createWallet() {
    const w = Wallet.createRandom();
    return { address: w.address, privateKey: w.privateKey };
  }

  _c(name, withSigner = false) {
    return new Contract(ADDR[name], ABI[name], withSigner ? this.signer : this.provider);
  }
  async _wait(tx) { return tx.wait(1, TX_TIMEOUT_MS); }
  txUrl(h) { return `${SCAN}/tx/${h}`; }
  addressUrl(a) { return `${SCAN}/address/${a}`; }

  // ---------- reads ----------

  async balance(address = this.address) { return formatEther(await this.provider.getBalance(address)); }

  async creditReport(address = this.address) {
    const out = { address };
    try { out.transactions = Number(await this.provider.getTransactionCount(address)); } catch { out.transactions = 0; }
    try {
      const r = await fetchT(`${SCAN}/api/v2/addresses/${address}/counters`);
      if (r.ok) out.transactions = Math.max(out.transactions, Number((await r.json()).transactions_count ?? 0));
    } catch {}
    try { out.loggedActions = (await this._c("actionLog").getAgentActions(address)).length; } catch {}
    try { out.stakedAUT = formatEther(await this._c("service").payerLockedStake(address)); } catch {}
    try {
      const p = await this._c("registrar").primaryName(address);
      if (p) out.primaryName = `${clean(p)}.agent`;
    } catch {}
    try {
      const reg = this._c("registry");
      const idn = await reg.ownerAgents(address, 0);
      if (idn > 0n) {
        const a = await reg.getAgent(idn);
        out.serviceAgentId = idn.toString();
        out.serviceActive = Number(a.status) === 1;
        out.serviceReputation = a.reputation.toString();
        out.serviceCalls = a.totalCalls.toString();
        out.serviceEarned = formatEther(a.totalEarned);
        out.serviceStake = formatEther(a.stakedAmount);
      }
    } catch {}
    try {
      const r = await fetchT(`${SCAN}/api?module=account&action=txlist&address=${address}&sort=asc&page=1&offset=1`);
      const first = (await r.json()).result?.[0];
      if (first?.timeStamp) out.ageDays = Math.max(1, Math.floor((Date.now() / 1000 - Number(first.timeStamp)) / 86400));
    } catch {}
    out.creditScore = this.creditScore(out);
    return out;
  }

  creditScore(rep) {
    let s = 0;
    if (rep.primaryName) s += 20;
    const staked = Number(rep.stakedAUT || 0) + Number(rep.serviceStake || 0);
    s += Math.min(staked / 50, 1) * 25;
    s += Math.min(Number(rep.serviceCalls || 0) / 50, 1) * 20;
    s += Math.min(Number(rep.loggedActions || 0) / 25, 1) * 15;
    s += Math.min(Number(rep.transactions || 0) / 100, 1) * 10;
    s += Math.min(Number(rep.ageDays || 0) / 90, 1) * 10;
    return Math.round(s);
  }

  async whoami() {
    const [bal, rep] = await Promise.all([this.balance(), this.creditReport()]);
    return { address: this.address, name: rep.primaryName || null, balanceAUT: bal, creditScore: rep.creditScore, ...rep };
  }

  async resolve(query) {
    let address, name = null, owner = null;
    if (isAddress(query)) address = query;
    else {
      const l = clean(query);
      if (!validLabel(l)) throw new Error(`"${query}" is not a valid .agent name or address.`);
      const r = await fetchT(`${this.api}/api/names/${encodeURIComponent(l)}`);
      if (!r.ok) throw new Error(`no such name: ${l}.agent`);
      const d = await r.json();
      if (!d?.name) throw new Error(`no such name: ${l}.agent`);
      address = d.address || d.owner; name = d.name; owner = d.owner;
    }
    const rep = await this.creditReport(address);
    return { name, owner, ...rep };
  }

  /** On-chain-authoritative resolution used before moving funds. */
  async _resolveTo(target) {
    if (isAddress(target)) return { address: target, name: null };
    const label = clean(target);
    if (!validLabel(label)) throw new Error(`"${target}" is not a valid .agent name.`);
    const reg = this._c("registrar"), resolver = this._c("resolver");
    const node = await reg.nodeOf(label);
    let a = ZeroAddress;
    try { a = await resolver.addr(node); } catch {}
    if (a === ZeroAddress) { try { a = await resolver.wallet(node); } catch {} }
    if (a === ZeroAddress) { try { a = await reg.ownerOf(await reg.tokenIdOf(label)); } catch {} }
    if (!isAddress(a) || a === ZeroAddress) throw new Error(`"${label}.agent" is not registered on-chain.`);
    try {
      const r = await fetchT(`${this.api}/api/names/${encodeURIComponent(label)}`);
      if (r.ok) {
        const d = await r.json();
        const apiAddr = d?.address || d?.owner;
        if (apiAddr && isAddress(apiAddr) && apiAddr.toLowerCase() !== a.toLowerCase())
          throw new Error(`SAFETY: name service and on-chain resolver disagree for ${label}.agent (api=${apiAddr}, chain=${a}).`);
      }
    } catch (e) { if (String(e.message).startsWith("SAFETY:")) throw e; }
    return { address: a, name: `${label}.agent` };
  }

  async getProfile(query) {
    const reg = this._c("registrar");
    let label = clean(query);
    if (isAddress(query)) { label = clean(await reg.primaryName(query)); if (!label) throw new Error("that address has no primary .agent name."); }
    if (!validLabel(label)) throw new Error(`"${query}" is not a valid .agent name.`);
    const node = await reg.nodeOf(label);
    const vals = await this._c("resolver").texts_(node, PROFILE_KEYS);
    const out = { name: `${label}.agent`, page: `https://names.autyon.io/${label}` };
    PROFILE_KEYS.forEach((k, i) => { if (vals[i]) out[k] = vals[i]; });
    return out;
  }

  async earnings() {
    const reg = this._c("registry");
    let idn; try { idn = await reg.ownerAgents(this.address, 0); } catch {}
    if (!idn || idn === 0n) return { serviceAgent: false };
    const a = await reg.getAgent(idn);
    return {
      serviceAgent: true, agentId: idn.toString(), active: Number(a.status) === 1,
      totalCalls: a.totalCalls.toString(), totalEarnedAUT: formatEther(a.totalEarned),
      reputation: a.reputation.toString(), stakedAUT: formatEther(a.stakedAmount),
    };
  }

  async jobs(jobId) {
    const esc = this._c("escrow");
    if (jobId != null) {
      const j = await esc.getJob(BigInt(jobId));
      if (j.client === ZeroAddress) throw new Error(`job #${jobId} does not exist.`);
      return this._job(jobId, j);
    }
    const me = this.address.toLowerCase();
    const next = Number(await esc.nextJobId());
    const from = Math.max(1, next - 40);
    const out = [];
    for (let i = next - 1; i >= from; i--) {
      try {
        const j = await esc.getJob(BigInt(i));
        if (j.client.toLowerCase() === me || j.worker.toLowerCase() === me) { out.push(this._job(i, j)); if (out.length >= 20) break; }
      } catch {}
    }
    return out;
  }
  _job(idn, j) {
    return {
      jobId: String(idn), status: JOB_STATUS[Number(j.status)], client: j.client, worker: j.worker,
      amountAUT: formatEther(j.amount), deadline: new Date(Number(j.deadline) * 1000).toISOString(),
      delivered: j.delivered, deliveryHash: j.deliveryHash,
    };
  }

  // ---------- writes ----------

  async registerIdentity(label) {
    const l = clean(label);
    if (!validLabel(l)) throw new Error(`"${label}" is not a valid .agent label (3-63 chars, a-z 0-9 -, no leading/trailing/double hyphen, no 0x-).`);
    const reg = this._c("registrar", true);
    if (!(await reg.available(l))) throw new Error(`"${l}.agent" is taken or reserved.`);
    const price = await reg.price();
    const tx1 = await reg.register(l, this.address, { value: price, ...GAS });
    await this._wait(tx1);
    let tx2 = null;
    try { if (clean(await reg.primaryName(this.address)) !== l) { tx2 = await reg.setPrimaryName(l, GAS); await this._wait(tx2); } } catch {}
    return { name: `${l}.agent`, registerTx: tx1.hash, bindTx: tx2?.hash || null, page: `https://names.autyon.io/${l}` };
  }

  async pay(to, amount, memo = "") {
    const wei = parseEther(String(amount));
    if (wei <= 0n) throw new Error("amount must be greater than zero.");
    const dest = await this._resolveTo(to);
    const tx = await this.signer.sendTransaction({ to: dest.address, value: wei, ...GAS, gasLimit: 21000n });
    await this._wait(tx);
    let logTx = null;
    try { const t = await this._c("actionLog", true).logAction(0, this.address, "payment", dest.address, wei, String(memo).slice(0, 500), GAS); await this._wait(t); logTx = t.hash; } catch {}
    return { to: dest.name || dest.address, amountAUT: String(amount), tx: tx.hash, logTx };
  }

  async stake(amount) {
    const wei = parseEther(String(amount));
    const tx = await this._c("service", true).lockStake({ value: wei, ...GAS });
    await this._wait(tx);
    return { stakedAUT: formatEther(await this._c("service").payerLockedStake(this.address)), tx: tx.hash };
  }
  async unstake(amount) {
    const until = Number(await this._c("service").lockedUntil(this.address));
    if (until > Math.floor(Date.now() / 1000)) throw new Error(`staked AUT is locked for another ${humanDuration(until - Math.floor(Date.now() / 1000))}.`);
    const tx = await this._c("service", true).unlockStake(parseEther(String(amount)), GAS);
    await this._wait(tx);
    return { stakedAUT: formatEther(await this._c("service").payerLockedStake(this.address)), tx: tx.hash };
  }

  async setProfile(fields = {}) {
    const reg = this._c("registrar");
    const primary = clean(await reg.primaryName(this.address));
    if (!primary) throw new Error("register a .agent name first (registerIdentity).");
    const keys = [], values = [];
    for (const k of PROFILE_KEYS) if (fields[k] != null && fields[k] !== "") { keys.push(k); values.push(String(fields[k]).slice(0, 400)); }
    if (!keys.length) throw new Error(`provide at least one of: ${PROFILE_KEYS.join(", ")}.`);
    const tx = await this._c("resolver", true).setTexts(await reg.nodeOf(primary), keys, values, GAS);
    await this._wait(tx);
    return { name: `${primary}.agent`, set: keys, tx: tx.hash };
  }

  async goPro({ name = "", description = "", endpoint = "" } = {}) {
    const reg = this._c("registry");
    try { const idn = await reg.ownerAgents(this.address, 0); if (idn > 0n) return { already: true, agentId: idn.toString() }; } catch {}
    const min = await reg.MIN_STAKE();
    const meta = JSON.stringify({ name, description, endpoint });
    const tx = await this._c("registry", true).registerAgent(ZERO32, ZERO32, ZERO32, meta, { value: min, ...GAS });
    await this._wait(tx);
    let idn = "?"; try { idn = (await reg.ownerAgents(this.address, 0)).toString(); } catch {}
    return { agentId: idn, stakedAUT: formatEther(min), tx: tx.hash };
  }

  async faucet() {
    const f = this._c("faucet", true);
    try { const wait = await f.timeUntilNextClaim(this.address); if (wait > 0n) return { cooldown: humanDuration(wait) }; } catch {}
    const tx = await f.claim(GAS);
    await this._wait(tx);
    return { balanceAUT: await this.balance(), tx: tx.hash };
  }

  async logAction(actionType, detail) {
    const tx = await this._c("actionLog", true).logAction(0, this.address, String(actionType).slice(0, 64), this.address, 0, String(detail).slice(0, 500), GAS);
    await this._wait(tx);
    return { tx: tx.hash };
  }

  // ---------- x402: pay to call a service ----------

  /** Pay a registered service agent for one call. `requestId` is a 32-byte hex string. */
  async payForCall(agentId, amountAUT, requestId) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(requestId))) throw new Error("requestId must be a 0x 32-byte hex string.");
    const tx = await this._c("service", true).payAgent(
      BigInt(agentId), [ZeroAddress, ZeroAddress, ZeroAddress], requestId,
      { value: parseEther(String(amountAUT)), ...GAS });
    await this._wait(tx);
    return { agentId: String(agentId), requestId, amountAUT: String(amountAUT), tx: tx.hash };
  }

  /**
   * Fetch an x402-protected URL. On HTTP 402 it reads the { agentId, priceWei, requestId }
   * challenge, pays on-chain, signs the requestId, and retries with proof headers.
   * @param {string} url
   * @param {RequestInit} [init]
   * @param {object} [opts]
   * @param {bigint|string} [opts.maxPriceWei]  refuse to pay more than this (in wei).
   * @param {Array<string|number>} [opts.allowAgentIds]  only pay these agent ids.
   */
  async x402Fetch(url, init = {}, opts = {}) {
    let res = await fetch(url, init);
    if (res.status !== 402) return res;
    const ch = await res.json().catch(() => ({}));
    const { agentId, priceWei, requestId } = ch;
    if (agentId == null || priceWei == null || !requestId) throw new Error("x402: malformed 402 challenge from server.");
    // The server dictates price + agentId, so guard before spending.
    if (opts.maxPriceWei != null && BigInt(priceWei) > BigInt(opts.maxPriceWei))
      throw new Error(`x402: server price ${formatEther(BigInt(priceWei))} AUT exceeds your maxPriceWei.`);
    if (opts.allowAgentIds && !opts.allowAgentIds.map(String).includes(String(agentId)))
      throw new Error(`x402: server agentId ${agentId} is not in allowAgentIds.`);
    const paid = await this.payForCall(agentId, formatEther(BigInt(priceWei)), requestId);
    const sig = await this.signer.signMessage(requestId); // proves the payer redeems (not a front-runner)
    const headers = { ...(init.headers || {}), "X-Autyon-RequestId": requestId, "X-Autyon-Tx": paid.tx, "X-Autyon-Sig": sig };
    return fetch(url, { ...init, headers });
  }

  // ---------- hiring / escrow ----------

  async hire(worker, amount, hours = 24) {
    const wei = parseEther(String(amount));
    if (wei <= 0n) throw new Error("amount must be greater than zero.");
    let dur = Math.round(Number(hours) * 3600);
    if (dur < 60) dur = 60;
    if (dur > 30 * 24 * 3600) throw new Error("deadline too far (max 720 hours).");
    const dest = await this._resolveTo(worker);
    if (dest.address.toLowerCase() === this.address.toLowerCase()) throw new Error("cannot hire yourself.");
    const esc = this._c("escrow", true);
    let jobId = (await esc.nextJobId()).toString();
    const tx = await esc.createJob(dest.address, BigInt(dur), { value: wei, ...GAS });
    const rc = await this._wait(tx);
    for (const l of rc.logs) { try { const p = esc.interface.parseLog(l); if (p?.name === "JobCreated") { jobId = p.args.jobId.toString(); break; } } catch {} }
    return { jobId, worker: dest.name || dest.address, amountAUT: String(amount), tx: tx.hash };
  }
  async deliver(jobId, proof = "") {
    const tx = await this._c("escrow", true).deliver(BigInt(jobId), proof ? id(String(proof)) : ZERO32, GAS);
    await this._wait(tx); return { jobId: String(jobId), tx: tx.hash };
  }
  async release(jobId) { const tx = await this._c("escrow", true).release(BigInt(jobId), GAS); await this._wait(tx); return { jobId: String(jobId), tx: tx.hash }; }
  async collect(jobId) { const tx = await this._c("escrow", true).autoRelease(BigInt(jobId), GAS); await this._wait(tx); return { jobId: String(jobId), tx: tx.hash }; }
  async dispute(jobId) { const tx = await this._c("escrow", true).dispute(BigInt(jobId), GAS); await this._wait(tx); return { jobId: String(jobId), tx: tx.hash }; }
  async cancelJob(jobId) {
    const j = await this._c("escrow").getJob(BigInt(jobId));
    const esc = this._c("escrow", true);
    const tx = (Number(j.status) === 1 && Date.now() / 1000 > Number(j.deadline))
      ? await esc.refundExpired(BigInt(jobId), GAS) : await esc.cancel(BigInt(jobId), GAS);
    await this._wait(tx); return { jobId: String(jobId), tx: tx.hash };
  }
}

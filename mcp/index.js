#!/usr/bin/env node
// Autyon AgentChain MCP server.
//
// Gives any MCP-compatible agent (Claude, OpenClaw, ...) an on-chain existence:
// identity (.agent name), a policy-limited wallet, payments, and tamper-proof
// action records — the six-layer credit stack, as tools.
//
// SECURITY MODEL
// - On first run a dedicated agent key is generated at ~/.autyon/agent.key
//   (0600). It is never printed, never returned by any tool, and never leaves
//   this machine.
// - The OWNER controls policy in ~/.autyon/policy.json (per-tx cap, daily cap,
//   optional allowlist). The agent cannot edit its own policy through any tool.
//   NOTE: these caps hold only as far as the host denies the agent write access
//   to ~/.autyon/. If the same agent also has generic filesystem tools, treat
//   the on-chain AgentWallet guardrails (next version) as the real boundary.
// - Policy parsing is FAIL-CLOSED: a malformed policy.json stops all spending
//   until the owner fixes it, rather than silently reverting to loose defaults.
// - Every value-moving tool is serialized through a single in-process lock, so
//   concurrent tool calls cannot race the daily-cap ledger or collide on nonce.
//
// This is the local-policy v1. On-chain AgentWallet guardrails are the next
// step; the tool surface stays the same.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  JsonRpcProvider, Wallet, Contract, parseEther, formatEther, isAddress, ZeroAddress, id,
} from "ethers";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/* ---------------- config ---------------- */
const RPC = process.env.AUTYON_RPC || "https://rpc.autyon.io";
const API = process.env.AUTYON_API || "https://api.autyon.io";
const SCAN = "https://autscan.io";
const CHAIN_ID = 77077;

const REGISTRAR = "0x7F3636d9bBDc86320F14Ae7A852d9A9d1D57564c"; // AgentNameNFT
const RESOLVER  = "0xa9d5e19b1fcafb6f0b1810e026cc429a631ceb84"; // AgentResolverV2
const ACTION_LOG = "0x106923dDF70A1AE237E7A4f7BBbE870CB3521436";
const FAUCET = "0x8Eb08E93f61f8f835c1cf4C94fD74c14EF06C72B";
const REGISTRY = "0x0ed6dafe3de759a46e7b6f1d7290f491dfae820a"; // AgentRegistry (service agents)
const SERVICE  = "0x3218003233f418bb83829c9627494b49ef0edf96"; // ServicePayment
const ESCROW   = "0x1DB932d3Af53F42b806Bb984180DBE5Bf6682811"; // TaskEscrow (hire jobs)

const REGISTRAR_ABI = [
  "function register(string label, address agentWallet) payable returns (bytes32)",
  "function available(string) view returns (bool)",
  "function price() view returns (uint256)",
  "function setPrimaryName(string label)",
  "function primaryName(address) view returns (string)",
  "function nodeOf(string) view returns (bytes32)",
  "function tokenIdOf(string) pure returns (uint256)",
  "function ownerOf(uint256) view returns (address)",
];
const RESOLVER_ABI = [
  "function addr(bytes32) view returns (address)",
  "function wallet(bytes32) view returns (address)",
  "function setText(bytes32 node, string key, string value)",
  "function setTexts(bytes32 node, string[] keys, string[] values)",
  "function text(bytes32 node, string key) view returns (string)",
  "function texts_(bytes32 node, string[] keys) view returns (string[])",
];
const ACTION_LOG_ABI = [
  "function logAction(uint256 taskId, address agent, string actionType, address target, uint256 amount, string detail) returns (uint256)",
  "function getAgentActions(address agent) view returns (uint256[])",
];
const FAUCET_ABI = [
  "function claim()",
  "function timeUntilNextClaim(address) view returns (uint256)",
  "error CooldownActive(uint256 secondsRemaining)",
];
function humanDuration(secs) {
  secs = Number(secs);
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
const REGISTRY_ABI = [
  "function registerAgent(bytes32 modelHash, bytes32 weightsHash, bytes32 systemPromptHash, string metadataURI) payable returns (uint256)",
  "function getAgent(uint256) view returns (tuple(address owner, bytes32 modelHash, bytes32 weightsHash, bytes32 systemPromptHash, string metadataURI, uint256 stakedAmount, uint256 reputation, uint256 totalEarned, uint256 totalCalls, uint256 registeredAt, uint8 status))",
  "function isActive(uint256) view returns (bool)",
  "function ownerAgents(address, uint256) view returns (uint256)",
  "function MIN_STAKE() view returns (uint256)",
];
const SERVICE_ABI = [
  "function lockStake() payable",
  "function unlockStake(uint256 amount)",
  "function payerLockedStake(address) view returns (uint256)",
  "function lockedUntil(address) view returns (uint256)",
];
// Profile text-record keys (ENS-style convention; the resolver stores any key).
const PROFILE_KEYS = ["description", "avatar", "url", "endpoint", "skills"];
const ESCROW_ABI = [
  "function createJob(address worker, uint64 duration) payable returns (uint256)",
  "function deliver(uint256 jobId, bytes32 deliveryHash)",
  "function release(uint256 jobId)",
  "function autoRelease(uint256 jobId)",
  "function cancel(uint256 jobId)",
  "function workerRefund(uint256 jobId)",
  "function refundExpired(uint256 jobId)",
  "function dispute(uint256 jobId)",
  "function nextJobId() view returns (uint256)",
  "function getJob(uint256) view returns (tuple(address client, address worker, uint256 amount, uint64 createdAt, uint64 deadline, uint64 disputedAt, uint8 status, bool delivered, bytes32 deliveryHash))",
  "event JobCreated(uint256 indexed jobId, address indexed client, address indexed worker, uint256 amount, uint64 deadline)",
];
const JOB_STATUS = ["none", "funded", "delivered", "released", "refunded", "disputed", "resolved"];

/* ---------------- key + policy (owner-controlled files) ---------------- */
const DIR = path.join(os.homedir(), ".autyon");
const KEY_FILE = path.join(DIR, "agent.key");
const POLICY_FILE = path.join(DIR, "policy.json");
const SPEND_FILE = path.join(DIR, "spend.json");

function ensureKey() {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(KEY_FILE)) {
    const w = Wallet.createRandom();
    fs.writeFileSync(KEY_FILE, w.privateKey, { mode: 0o600 });
  } else {
    // Re-assert restrictive perms on a pre-existing key file.
    try { fs.chmodSync(KEY_FILE, 0o600); } catch {}
  }
  return new Wallet(fs.readFileSync(KEY_FILE, "utf8").trim());
}

// Defaults are sized so a first .agent registration (1 AUT) works out of the box
// while ongoing autonomous payments stay bounded. The owner can raise/lower these
// in the extension's Settings UI (injected as env vars below) or in policy.json.
const DEFAULT_POLICY = { perTxMaxAUT: "2", dailyMaxAUT: "10", allowlist: [], payMinScore: 0 };

// FAIL-CLOSED: throws (halting the action) if policy.json exists but is invalid,
// rather than falling back to the looser defaults.
function policy() {
  if (!fs.existsSync(POLICY_FILE)) {
    fs.writeFileSync(POLICY_FILE, JSON.stringify(DEFAULT_POLICY, null, 2), { mode: 0o600 });
    return { ...DEFAULT_POLICY };
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(POLICY_FILE, "utf8"));
  } catch (e) {
    throw new Error(
      `POLICY: ~/.autyon/policy.json is not valid JSON — refusing to act until the owner fixes it (${e.message}). ` +
      `Note: JSON does not allow // comments or trailing commas.`
    );
  }
  const p = { ...DEFAULT_POLICY, ...raw };
  // Extension Settings UI overrides (owner-controlled, injected as env vars by the
  // Desktop Extension; the agent/LLM cannot set process env, so these stay owner-only).
  if (process.env.AUTYON_PERTX_MAX) p.perTxMaxAUT = process.env.AUTYON_PERTX_MAX;
  if (process.env.AUTYON_DAILY_MAX) p.dailyMaxAUT = process.env.AUTYON_DAILY_MAX;
  if (process.env.AUTYON_ALLOWLIST != null && process.env.AUTYON_ALLOWLIST !== "")
    p.allowlist = process.env.AUTYON_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean);
  if (process.env.AUTYON_MIN_SCORE) p.payMinScore = process.env.AUTYON_MIN_SCORE;
  // Validate shape; any failure is fail-closed.
  const ms = Number(p.payMinScore);
  if (!Number.isFinite(ms) || ms < 0 || ms > 100)
    throw new Error(`POLICY: payMinScore ("${p.payMinScore}") must be a number 0–100.`);
  p.payMinScore = ms;
  try { parseEther(String(p.perTxMaxAUT)); }
  catch { throw new Error(`POLICY: perTxMaxAUT ("${p.perTxMaxAUT}") is not a valid AUT amount.`); }
  try { parseEther(String(p.dailyMaxAUT)); }
  catch { throw new Error(`POLICY: dailyMaxAUT ("${p.dailyMaxAUT}") is not a valid AUT amount.`); }
  if (!Array.isArray(p.allowlist))
    throw new Error(`POLICY: allowlist must be a JSON array of addresses.`);
  return p;
}

function spendToday() {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const s = JSON.parse(fs.readFileSync(SPEND_FILE, "utf8"));
    if (s.date === today) return s;
  } catch {}
  return { date: today, spentWei: "0" };
}
// delta may be negative (to refund a reservation); never drops below zero.
function recordSpend(deltaWei) {
  const s = spendToday();
  let next = BigInt(s.spentWei) + deltaWei;
  if (next < 0n) next = 0n;
  s.spentWei = next.toString();
  fs.writeFileSync(SPEND_FILE, JSON.stringify(s), { mode: 0o600 });
}

/* ---------------- serialization lock ----------------
 * Every tool that sends a transaction runs through this queue, so two
 * concurrent tool calls can never both pass the daily-cap check before either
 * writes, and never collide on the signer's nonce. */
let _chain = Promise.resolve();
function withLock(fn) {
  const run = _chain.then(fn, fn);
  _chain = run.then(() => {}, () => {});
  return run;
}

const provider = new JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
const signer = ensureKey().connect(provider);
const GAS = { gasPrice: 1_000_000_000n }; // flat 1 gwei, zeroBaseFee chain — deterministic
const TX_TIMEOUT_MS = 120_000;

// wait with a timeout so a stuck tx cannot hang a tool call forever.
async function waitTx(tx) { return tx.wait(1, TX_TIMEOUT_MS); }

// fetch with a hard timeout — a stalled explorer must never freeze a tool call
// (especially the reputation gate, which runs inside the serialized value lock).
async function fetchT(url, ms = 8000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { signal: ac.signal }); }
  finally { clearTimeout(t); }
}

const clean = (n) => String(n || "").trim().toLowerCase().replace(/\.agent$/, "");
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
// Reject "0x…"-looking inputs that aren't valid addresses, instead of misreading
// them as .agent names.
function badHexGuard(s) {
  const t = String(s || "").trim();
  if (/^0x/i.test(t) && !isAddress(t))
    throw new Error(`"${t}" looks like an address but is malformed — an address is 0x followed by 40 hex characters.`);
}
// Mirror the on-chain _validLabel rules so we fail fast instead of burning gas.
function validLabel(l) {
  return (
    typeof l === "string" &&
    l.length >= 3 && l.length <= 63 &&
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(l) &&
    !l.includes("--") &&
    !/^0x/i.test(l)          // avoid names that look like (malformed) addresses
  );
}

// Resolve a ".agent" name or 0x address to an address, cross-checking the API
// answer against the on-chain resolver. Used for PAYMENTS, where a wrong
// address means lost funds — so a mismatch refuses rather than guesses.
async function resolveToChecked(target) {
  if (isAddress(target)) return { address: target, name: null };
  badHexGuard(target);
  const label = clean(target);
  if (!validLabel(label)) throw new Error(`"${target}" is not a valid .agent name.`);

  // On-chain (authoritative): node -> resolver.addr -> resolver.wallet -> NFT owner.
  const reg = new Contract(REGISTRAR, REGISTRAR_ABI, provider);
  const resolver = new Contract(RESOLVER, RESOLVER_ABI, provider);
  const node = await reg.nodeOf(label);
  let chainAddr = ZeroAddress;
  try { chainAddr = await resolver.addr(node); } catch {}
  if (chainAddr === ZeroAddress) { try { chainAddr = await resolver.wallet(node); } catch {} }
  if (chainAddr === ZeroAddress) {
    try { chainAddr = await reg.ownerOf(await reg.tokenIdOf(label)); } catch {}
  }
  if (!isAddress(chainAddr) || chainAddr === ZeroAddress)
    throw new Error(`"${label}.agent" is not registered on-chain — refusing to pay.`);

  // API (advisory): cross-check. Disagreement => refuse.
  try {
    const r = await fetchT(`${API}/api/names/${encodeURIComponent(label)}`);
    if (r.ok) {
      const d = await r.json();
      const apiAddr = d?.address || d?.owner;
      if (apiAddr && isAddress(apiAddr) && apiAddr.toLowerCase() !== chainAddr.toLowerCase())
        throw new Error(
          `SAFETY: the name service and the on-chain resolver disagree on where ${label}.agent points ` +
          `(api=${apiAddr}, chain=${chainAddr}). Refusing to pay.`
        );
    }
  } catch (e) {
    if (String(e.message).startsWith("SAFETY:")) throw e;
    // API unreachable is fine — the on-chain value is authoritative.
  }
  return { address: chainAddr, name: `${label}.agent` };
}

async function creditReport(address) {
  const out = { address };
  // Outgoing tx count from the node nonce — instant and never lags the indexer.
  let nonce = 0;
  try { nonce = Number(await provider.getTransactionCount(address)); } catch {}
  out.transactions = nonce;
  // The explorer counter includes incoming txs too; take the larger of the two.
  try {
    const r = await fetchT(`${SCAN}/api/v2/addresses/${address}/counters`);
    if (r.ok) out.transactions = Math.max(nonce, Number((await r.json()).transactions_count ?? 0));
  } catch {}
  try {
    const log = new Contract(ACTION_LOG, ACTION_LOG_ABI, provider);
    out.logged_actions = (await log.getAgentActions(address)).length;
  } catch {}
  try {
    const r = await fetchT(`${SCAN}/api?module=account&action=txlist&address=${address}&sort=asc&page=1&offset=1`);
    const first = (await r.json()).result?.[0];
    if (first?.timeStamp)
      out.agent_age_days = Math.max(1, Math.floor((Date.now() / 1000 - Number(first.timeStamp)) / 86400));
  } catch {}
  try {
    const reg = new Contract(REGISTRAR, REGISTRAR_ABI, provider);
    const p = await reg.primaryName(address);
    if (p) out.primary_name = `${clean(p)}.agent`;
  } catch {}
  // AUT staked for tax tier / credit backing (ServicePayment.lockStake)
  try {
    const svc = new Contract(SERVICE, SERVICE_ABI, provider);
    out.staked_aut = formatEther(await svc.payerLockedStake(address));
  } catch {}
  // If this address owns a registered service agent, pull its on-chain stats.
  try {
    const reg = new Contract(REGISTRY, REGISTRY_ABI, provider);
    const id = await reg.ownerAgents(address, 0); // first service agent, if any
    if (id > 0n) {
      const a = await reg.getAgent(id);
      out.service_agent_id = id.toString();
      out.service_active = Number(a.status) === 1; // 1 = Active
      out.service_reputation = a.reputation.toString();
      out.service_calls = a.totalCalls.toString();
      out.service_earned = formatEther(a.totalEarned);
      out.service_stake = formatEther(a.stakedAmount);
    }
  } catch {}
  return out;
}

// A deterministic 0–100 Agent Credit Score from on-chain signals. Transparent by
// design: identity + skin-in-the-game + track record, nothing hidden or gameable
// beyond actually being active on chain.
function creditScore(rep) {
  let s = 0;
  if (rep.primary_name) s += 20;                                   // has an identity
  const staked = Number(rep.staked_aut || 0) + Number(rep.service_stake || 0);
  s += Math.min(staked / 50, 1) * 25;                              // skin in the game (cap at 50 AUT)
  s += Math.min(Number(rep.service_calls || 0) / 50, 1) * 20;      // real service track record
  s += Math.min(Number(rep.logged_actions || 0) / 25, 1) * 15;    // attested work
  s += Math.min(Number(rep.transactions || 0) / 100, 1) * 10;     // on-chain activity
  s += Math.min(Number(rep.agent_age_days || 0) / 90, 1) * 10;    // longevity
  return Math.round(s);
}
function scoreBand(s) {
  return s >= 75 ? "excellent" : s >= 50 ? "good" : s >= 25 ? "building" : "new";
}

/* ---------------- server + tools ---------------- */
const server = new McpServer({ name: "autyon", version: "0.5.2" });

server.tool(
  "autyon_whoami",
  "This agent's on-chain identity on Autyon AgentChain: address, .agent name, AUT balance, and today's remaining spend allowance. If unfunded, shows the address to fund.",
  {},
  async () => {
    const addr = signer.address;
    const [bal, rep] = await Promise.all([provider.getBalance(addr), creditReport(addr)]);
    const pol = policy();
    const spent = BigInt(spendToday().spentWei);
    const daily = parseEther(String(pol.dailyMaxAUT));
    const score = creditScore(rep);
    const lines = [
      `Address: ${addr}`,
      `Name: ${rep.primary_name || "(none — use autyon_register_identity)"}`,
      `Balance: ${formatEther(bal)} AUT · Staked: ${rep.staked_aut ?? "0"} AUT`,
      `Agent Credit Score: ${score}/100 (${scoreBand(score)})`,
      `Policy: per-tx ≤ ${pol.perTxMaxAUT} AUT · daily ≤ ${pol.dailyMaxAUT} AUT · spent today ${formatEther(spent)} AUT · remaining ${formatEther(daily > spent ? daily - spent : 0n)} AUT${pol.payMinScore ? ` · will only pay agents scoring ≥ ${pol.payMinScore}` : ""}`,
      `On-chain record: ${rep.transactions ?? 0} transactions · ${rep.logged_actions ?? 0} logged actions${rep.agent_age_days ? ` · ${rep.agent_age_days} days on chain` : ""}`,
      rep.service_agent_id ? `Service agent #${rep.service_agent_id}${rep.service_active ? " (active)" : " (inactive)"} · ${rep.service_calls} calls · earned ${rep.service_earned} AUT` : `Service: not a paid service agent yet (use autyon_go_pro)`,
      `Explorer: ${SCAN}/address/${addr}`,
    ];
    if (bal === 0n) lines.push(`FUND ME: send a little AUT to ${addr} (owner can use faucet.autyon.io with this address).`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "autyon_register_identity",
  "Register a .agent name as this agent's on-chain identity and bind it as the primary name. Costs the on-chain registration price, paid from the agent's balance — this spend counts against the owner's per-tx and daily caps.",
  { label: z.string().describe("the name to register, without .agent (3-63 chars, lowercase letters, digits, hyphens; no leading/trailing or double hyphen)") },
  async ({ label }) => withLock(async () => {
    const l = clean(label);
    if (!validLabel(l)) throw new Error(`"${label}" is not a valid .agent name (3-63 chars, a-z 0-9 -, no leading/trailing or double hyphen).`);
    const reg = new Contract(REGISTRAR, REGISTRAR_ABI, signer);
    if (!(await reg.available(l))) throw new Error(`"${l}.agent" is taken or reserved.`);

    const price = await reg.price();
    const pol = policy();
    // H1: registration spend is gated by the same caps as payments.
    if (price > parseEther(String(pol.perTxMaxAUT)))
      throw new Error(`POLICY: registration costs ${formatEther(price)} AUT, above the per-tx cap of ${pol.perTxMaxAUT} AUT. The owner must raise the cap in ~/.autyon/policy.json.`);
    const spent = BigInt(spendToday().spentWei);
    if (spent + price > parseEther(String(pol.dailyMaxAUT)))
      throw new Error(`POLICY: registration (${formatEther(price)} AUT) would exceed today's daily cap of ${pol.dailyMaxAUT} AUT (already spent ${formatEther(spent)} AUT).`);

    const bal = await provider.getBalance(signer.address);
    if (bal < price + parseEther("0.01"))
      throw new Error(`registration costs ${formatEther(price)} AUT + gas; balance is ${formatEther(bal)} AUT. Fund ${signer.address} first.`);

    recordSpend(price); // reserve before broadcasting
    let tx1;
    try {
      tx1 = await reg.register(l, signer.address, { value: price, ...GAS });
      await waitTx(tx1);
    } catch (e) {
      recordSpend(-price); // refund the reservation on failure
      throw e;
    }
    // register() already binds the primary name when the agent had none, so the
    // separate setPrimaryName is only needed if a different primary was set before.
    let tx2 = null;
    try {
      const current = clean(await reg.primaryName(signer.address));
      if (current !== l) { tx2 = await reg.setPrimaryName(l, GAS); await waitTx(tx2); }
    } catch {}
    return { content: [{ type: "text", text:
      `Registered and bound ${l}.agent to ${signer.address}.\nRegister tx: ${SCAN}/tx/${tx1.hash}` +
      (tx2 ? `\nPrimary-bind tx: ${SCAN}/tx/${tx2.hash}` : "") +
      `\nProfile: https://names.autyon.io/${l}` }] };
  })
);

server.tool(
  "autyon_resolve",
  "Look up any agent by .agent name or 0x address: who owns it, and its on-chain credit report (transactions, logged actions, age). Read-only.",
  { query: z.string().describe(".agent name or 0x address") },
  async ({ query }) => {
    let address, name = null, owner = null;
    if (isAddress(query)) {
      address = query;
    } else {
      badHexGuard(query);
      const l = clean(query);
      const r = await fetchT(`${API}/api/names/${encodeURIComponent(l)}`);
      if (!r.ok) throw new Error(`no such name: ${l}.agent`);
      const d = await r.json();
      if (!d?.name) throw new Error(`no such name: ${l}.agent`);
      address = d.address || d.owner; name = d.name; owner = d.owner;
    }
    const rep = await creditReport(address);
    const score = creditScore(rep);
    const lines = [
      name ? `Name: ${name}` : null,
      owner ? `Owner: ${owner}` : null,
      `Address: ${address}`,
      rep.primary_name && rep.primary_name !== name ? `Primary name: ${rep.primary_name}` : null,
      `— Agent Credit Report —`,
      `Agent Credit Score: ${score}/100 (${scoreBand(score)})`,
      `Staked: ${rep.staked_aut ?? "0"} AUT`,
      rep.service_agent_id ? `Service agent #${rep.service_agent_id} · ${rep.service_calls} calls · earned ${rep.service_earned} AUT · reputation ${rep.service_reputation}` : null,
      `Transactions: ${rep.transactions ?? "?"}`,
      `Logged actions: ${rep.logged_actions ?? "?"} (open log — anyone can append; weigh accordingly)`,
      `Agent age: ${rep.agent_age_days ? rep.agent_age_days + " days" : "new"}`,
      `Explorer: ${SCAN}/address/${address}`,
    ].filter(Boolean);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "autyon_pay",
  "Pay AUT to another agent or address, within the owner's policy limits. Recipient can be a .agent name (resolved on-chain and cross-checked). The payment is automatically recorded in the on-chain action log.",
  {
    to: z.string().describe(".agent name or 0x address"),
    amount: z.string().describe("amount in AUT, e.g. \"0.1\""),
    memo: z.string().optional().describe("short reason, recorded on chain"),
  },
  async ({ to, amount, memo }) => withLock(async () => {
    let wei;
    try { wei = parseEther(amount); } catch { throw new Error(`"${amount}" is not a valid AUT amount.`); }
    if (wei <= 0n) throw new Error(`amount must be greater than zero.`);

    const pol = policy();
    if (wei > parseEther(String(pol.perTxMaxAUT)))
      throw new Error(`POLICY: ${amount} AUT exceeds the per-transaction cap of ${pol.perTxMaxAUT} AUT. The owner must raise the cap in ~/.autyon/policy.json.`);
    const spent = BigInt(spendToday().spentWei);
    if (spent + wei > parseEther(String(pol.dailyMaxAUT)))
      throw new Error(`POLICY: this payment would exceed the daily cap of ${pol.dailyMaxAUT} AUT (already spent ${formatEther(spent)} AUT today). The owner must approve by raising the cap.`);

    const dest = await resolveToChecked(to);
    if (pol.allowlist?.length && !pol.allowlist.map(a => String(a).toLowerCase()).includes(dest.address.toLowerCase()))
      throw new Error(`POLICY: ${dest.name || dest.address} is not on the owner's allowlist.`);

    // Reputation gate: refuse to pay agents below the owner's minimum credit score.
    if (pol.payMinScore > 0) {
      const rrep = await creditReport(dest.address);
      const rscore = creditScore(rrep);
      if (rscore < pol.payMinScore)
        throw new Error(`POLICY: ${dest.name || dest.address} has an Agent Credit Score of ${rscore}/100, below the owner's minimum of ${pol.payMinScore}. Refusing to pay a low-reputation counterpart.`);
    }

    recordSpend(wei); // reserve before broadcasting
    let tx;
    try {
      tx = await signer.sendTransaction({ to: dest.address, value: wei, ...GAS, gasLimit: 21000n });
      await waitTx(tx);
    } catch (e) {
      recordSpend(-wei); // refund reservation on failure
      throw e;
    }
    // tamper-proof record (best-effort; does not undo a completed payment)
    let logTx = null;
    try {
      const log = new Contract(ACTION_LOG, ACTION_LOG_ABI, signer);
      const t = await log.logAction(0, signer.address, "payment", dest.address, wei, (memo || "").slice(0, 500), GAS);
      await waitTx(t); logTx = t.hash;
    } catch {}
    return { content: [{ type: "text", text:
      `Paid ${amount} AUT to ${dest.name || short(dest.address)}.\nPayment tx: ${SCAN}/tx/${tx.hash}` +
      (logTx ? `\nAction record: ${SCAN}/tx/${logTx}` : "") }] };
  })
);

server.tool(
  "autyon_log_action",
  "Write a tamper-proof record of something this agent did to the on-chain action log (builds the agent's logged-action history).",
  {
    action_type: z.string().describe("short type, e.g. \"research\", \"delivery\", \"decision\""),
    detail: z.string().describe("what was done, one line"),
  },
  async ({ action_type, detail }) => withLock(async () => {
    const log = new Contract(ACTION_LOG, ACTION_LOG_ABI, signer);
    const tx = await log.logAction(0, signer.address, String(action_type).slice(0, 64), signer.address, 0, String(detail).slice(0, 500), GAS);
    await waitTx(tx);
    return { content: [{ type: "text", text: `Recorded on chain: [${action_type}] ${detail}\nTx: ${SCAN}/tx/${tx.hash}` }] };
  })
);

server.tool(
  "autyon_history",
  "This agent's recent on-chain activity: latest transactions and totals.",
  {},
  async () => {
    const addr = signer.address;
    let txt = "";
    try {
      const r = await fetchT(`${SCAN}/api?module=account&action=txlist&address=${addr}&sort=desc&page=1&offset=10`);
      const items = (await r.json()).result || [];
      txt = items.map(t => {
        const dir = t.from?.toLowerCase() === addr.toLowerCase() ? "→" : "←";
        const peer = dir === "→" ? t.to : t.from;
        return `${new Date(Number(t.timeStamp) * 1000).toISOString().slice(0, 16)} ${dir} ${short(peer || "0x")} ${formatEther(t.value || "0")} AUT`;
      }).join("\n") || "(no transactions yet)";
    } catch { txt = "(explorer unavailable)"; }
    const rep = await creditReport(addr);
    return { content: [{ type: "text", text:
      `Last transactions:\n${txt}\n\nTotals: ${rep.transactions ?? 0} transactions · ${rep.logged_actions ?? 0} logged actions\nExplorer: ${SCAN}/address/${addr}` }] };
  }
);

server.tool(
  "autyon_faucet",
  "Claim testnet AUT from the on-chain faucet (needs a small existing balance for gas; subject to the faucet's cooldown).",
  {},
  async () => withLock(async () => {
    const bal = await provider.getBalance(signer.address);
    if (bal === 0n)
      throw new Error(`no gas to claim. Ask the owner to send a tiny amount of AUT to ${signer.address} first (or use faucet.autyon.io with this address).`);
    const faucet = new Contract(FAUCET, FAUCET_ABI, signer);
    // Friendly pre-check so cooldown reads as a clear message, not a raw revert.
    try {
      const wait = await faucet.timeUntilNextClaim(signer.address);
      if (wait > 0n) return { content: [{ type: "text", text: `Faucet is on cooldown — try again in ${humanDuration(wait)}.` }] };
    } catch {}
    let tx;
    try {
      tx = await faucet.claim(GAS);
      await waitTx(tx);
    } catch (e) {
      // Decode the on-chain cooldown error if the pre-check raced.
      const rem = e?.revert?.args?.[0] ?? e?.data;
      if (e?.revert?.name === "CooldownActive")
        return { content: [{ type: "text", text: `Faucet is on cooldown — try again in ${humanDuration(rem)}.` }] };
      throw e;
    }
    const after = await provider.getBalance(signer.address);
    return { content: [{ type: "text", text: `Claimed. Balance: ${formatEther(after)} AUT\nTx: ${SCAN}/tx/${tx.hash}` }] };
  })
);

server.tool(
  "autyon_stake",
  "Stake AUT to back this agent's credit (skin in the game) and earn a lower service tax tier. Staked funds are locked for a short period, then recoverable with autyon_unstake. Counts against the owner's spend caps.",
  { amount: z.string().describe("amount of AUT to stake, e.g. \"5\"") },
  async ({ amount }) => withLock(async () => {
    let wei;
    try { wei = parseEther(amount); } catch { throw new Error(`"${amount}" is not a valid AUT amount.`); }
    if (wei <= 0n) throw new Error(`amount must be greater than zero.`);
    const pol = policy();
    if (wei > parseEther(String(pol.perTxMaxAUT)))
      throw new Error(`POLICY: staking ${amount} AUT exceeds the per-tx cap of ${pol.perTxMaxAUT} AUT. The owner must raise it in Settings.`);
    const spent = BigInt(spendToday().spentWei);
    if (spent + wei > parseEther(String(pol.dailyMaxAUT)))
      throw new Error(`POLICY: staking ${amount} AUT would exceed today's daily cap of ${pol.dailyMaxAUT} AUT.`);
    const bal = await provider.getBalance(signer.address);
    if (bal < wei + parseEther("0.01")) throw new Error(`balance ${formatEther(bal)} AUT is too low to stake ${amount} AUT + gas.`);
    recordSpend(wei);
    let tx;
    try {
      const svc = new Contract(SERVICE, SERVICE_ABI, signer);
      tx = await svc.lockStake({ value: wei, ...GAS });
      await waitTx(tx);
    } catch (e) { recordSpend(-wei); throw e; }
    const svc = new Contract(SERVICE, SERVICE_ABI, provider);
    const staked = formatEther(await svc.payerLockedStake(signer.address));
    return { content: [{ type: "text", text: `Staked ${amount} AUT. Total staked: ${staked} AUT.\nTx: ${SCAN}/tx/${tx.hash}` }] };
  })
);

server.tool(
  "autyon_unstake",
  "Recover previously staked AUT (after the lock period). Returns funds to this agent's balance.",
  { amount: z.string().describe("amount of AUT to unstake") },
  async ({ amount }) => withLock(async () => {
    let wei;
    try { wei = parseEther(amount); } catch { throw new Error(`"${amount}" is not a valid AUT amount.`); }
    if (wei <= 0n) throw new Error(`amount must be greater than zero.`);
    const svcR = new Contract(SERVICE, SERVICE_ABI, provider);
    // Friendly lock-period check instead of a raw revert.
    try {
      const until = Number(await svcR.lockedUntil(signer.address));
      const now = Math.floor(Date.now() / 1000);
      if (until > now) return { content: [{ type: "text", text: `Staked AUT is locked for another ${humanDuration(until - now)} (tax-tier lock). Try again after it elapses.` }] };
    } catch {}
    const svc = new Contract(SERVICE, SERVICE_ABI, signer);
    const tx = await svc.unlockStake(wei, GAS);
    await waitTx(tx);
    const staked = formatEther(await new Contract(SERVICE, SERVICE_ABI, provider).payerLockedStake(signer.address));
    return { content: [{ type: "text", text: `Unstaked ${amount} AUT. Remaining staked: ${staked} AUT.\nTx: ${SCAN}/tx/${tx.hash}` }] };
  })
);

server.tool(
  "autyon_set_profile",
  "Publish this agent's public profile on chain (its .agent page). Sets any of: description, avatar (image URL), url, endpoint (service/MCP URL), skills. Requires a registered .agent name.",
  {
    description: z.string().optional(),
    avatar: z.string().optional(),
    url: z.string().optional(),
    endpoint: z.string().optional(),
    skills: z.string().optional().describe("comma-separated capabilities"),
  },
  async (fields) => withLock(async () => {
    const reg = new Contract(REGISTRAR, REGISTRAR_ABI, provider);
    const primary = clean(await reg.primaryName(signer.address));
    if (!primary) throw new Error(`register a .agent name first (autyon_register_identity) — a profile attaches to your name.`);
    const keys = [], values = [];
    for (const k of PROFILE_KEYS) {
      if (fields[k] != null && fields[k] !== "") { keys.push(k); values.push(String(fields[k]).slice(0, 400)); }
    }
    if (!keys.length) throw new Error(`nothing to set — provide at least one of: ${PROFILE_KEYS.join(", ")}.`);
    const node = await reg.nodeOf(primary);
    const resolver = new Contract(RESOLVER, RESOLVER_ABI, signer);
    const tx = await resolver.setTexts(node, keys, values, GAS);
    await waitTx(tx);
    return { content: [{ type: "text", text: `Updated ${primary}.agent profile (${keys.join(", ")}).\nView: https://names.autyon.io/${primary}\nTx: ${SCAN}/tx/${tx.hash}` }] };
  })
);

server.tool(
  "autyon_profile",
  "Read any agent's public profile (description, avatar, url, endpoint, skills) by .agent name or address. Read-only.",
  { query: z.string().describe(".agent name or 0x address") },
  async ({ query }) => {
    if (!isAddress(query)) badHexGuard(query);
    const reg = new Contract(REGISTRAR, REGISTRAR_ABI, provider);
    let label = clean(query);
    if (isAddress(query)) { label = clean(await reg.primaryName(query)); if (!label) throw new Error(`that address has no primary .agent name.`); }
    if (!validLabel(label)) throw new Error(`"${query}" is not a valid .agent name.`);
    const node = await reg.nodeOf(label);
    const resolver = new Contract(RESOLVER, RESOLVER_ABI, provider);
    const vals = await resolver.texts_(node, PROFILE_KEYS);
    const lines = [`${label}.agent`];
    PROFILE_KEYS.forEach((k, i) => { if (vals[i]) lines.push(`${k}: ${vals[i]}`); });
    if (lines.length === 1) lines.push("(no profile set yet)");
    lines.push(`Page: https://names.autyon.io/${label}`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "autyon_go_pro",
  "Register this agent as a paid service agent so others can pay to call it (earns AUT, builds on-chain reputation). Requires a 50 AUT stake — this large spend will need the owner to raise the caps in Settings to authorize.",
  {
    name: z.string().optional().describe("display name / category for the service"),
    description: z.string().optional(),
    endpoint: z.string().optional().describe("service or MCP endpoint URL"),
  },
  async ({ name, description, endpoint }) => withLock(async () => {
    const reg = new Contract(REGISTRY, REGISTRY_ABI, provider);
    // already registered?
    try { const id = await reg.ownerAgents(signer.address, 0); if (id > 0n)
      return { content: [{ type: "text", text: `Already a service agent (#${id.toString()}). Use autyon_earnings to see stats.` }] }; } catch {}
    const min = await reg.MIN_STAKE();
    const pol = policy();
    if (min > parseEther(String(pol.perTxMaxAUT)) || (BigInt(spendToday().spentWei) + min) > parseEther(String(pol.dailyMaxAUT)))
      throw new Error(`POLICY: becoming a service agent stakes ${formatEther(min)} AUT, above your current caps (per-tx ${pol.perTxMaxAUT}, daily ${pol.dailyMaxAUT}). Raise both to at least ${formatEther(min)} in the extension Settings to authorize, then retry.`);
    const bal = await provider.getBalance(signer.address);
    if (bal < min + parseEther("0.01")) throw new Error(`need ${formatEther(min)} AUT + gas; balance is ${formatEther(bal)} AUT.`);
    const meta = JSON.stringify({ name: name || "", description: description || "", endpoint: endpoint || "" });
    recordSpend(min);
    let tx;
    try {
      const regW = new Contract(REGISTRY, REGISTRY_ABI, signer);
      const ZH = "0x0000000000000000000000000000000000000000000000000000000000000000";
      tx = await regW.registerAgent(ZH, ZH, ZH, meta, { value: min, ...GAS });
      await waitTx(tx);
    } catch (e) { recordSpend(-min); throw e; }
    let id = "?";
    try { id = (await reg.ownerAgents(signer.address, 0)).toString(); } catch {}
    return { content: [{ type: "text", text: `You are now a paid service agent (#${id}), staked ${formatEther(min)} AUT. Others can pay to call you; earnings and reputation accrue on chain.\nTx: ${SCAN}/tx/${tx.hash}` }] };
  })
);

server.tool(
  "autyon_earnings",
  "This agent's service earnings and reputation (if registered as a paid service agent via autyon_go_pro).",
  {},
  async () => {
    const reg = new Contract(REGISTRY, REGISTRY_ABI, provider);
    let id;
    try { id = await reg.ownerAgents(signer.address, 0); } catch {}
    if (!id || id === 0n) return { content: [{ type: "text", text: `Not a paid service agent yet. Use autyon_go_pro to start earning.` }] };
    const a = await reg.getAgent(id);
    return { content: [{ type: "text", text:
      `Service agent #${id.toString()} (${Number(a.status) === 1 ? "active" : "inactive"})\n` +
      `Total calls: ${a.totalCalls.toString()}\nTotal earned: ${formatEther(a.totalEarned)} AUT\n` +
      `Reputation: ${a.reputation.toString()}\nStaked: ${formatEther(a.stakedAmount)} AUT\n` +
      `Explorer: ${SCAN}/address/${signer.address}` }] };
  }
);

/* ---------------- hire / escrow (Agent hires Agent) ---------------- */

function jobLines(id, j) {
  const st = JOB_STATUS[Number(j.status)] || "?";
  return [
    `Job #${id} · ${st}`,
    `Client: ${short(j.client)} · Worker: ${short(j.worker)}`,
    `Escrow: ${formatEther(j.amount)} AUT`,
    `Deadline: ${new Date(Number(j.deadline) * 1000).toISOString().slice(0, 16)} UTC`,
    j.delivered ? `Delivered ✓ (hash ${String(j.deliveryHash).slice(0, 10)}…)` : `Not delivered yet`,
  ].join("\n");
}

server.tool(
  "autyon_hire",
  "Hire another agent for a task: escrow AUT that is released to them on completion. Recipient can be a .agent name (resolved on-chain). The escrow counts against the owner's spend caps. Returns a job id.",
  {
    worker: z.string().describe(".agent name or 0x address of the agent to hire"),
    amount: z.string().describe("AUT to escrow, e.g. \"1\""),
    hours: z.string().optional().describe("deadline in hours (default 24; 0.017–720)"),
  },
  async ({ worker, amount, hours }) => withLock(async () => {
    let wei;
    try { wei = parseEther(amount); } catch { throw new Error(`"${amount}" is not a valid AUT amount.`); }
    if (wei <= 0n) throw new Error(`amount must be greater than zero.`);
    const h = hours ? Number(hours) : 24;
    if (!Number.isFinite(h) || h <= 0) throw new Error(`hours must be a positive number.`);
    let dur = Math.round(h * 3600);
    if (dur < 60) dur = 60;
    if (dur > 30 * 24 * 3600) throw new Error(`deadline too far (max 720 hours).`);

    const pol = policy();
    if (wei > parseEther(String(pol.perTxMaxAUT)))
      throw new Error(`POLICY: escrowing ${amount} AUT exceeds the per-tx cap of ${pol.perTxMaxAUT} AUT. Raise it in Settings.`);
    const spent = BigInt(spendToday().spentWei);
    if (spent + wei > parseEther(String(pol.dailyMaxAUT)))
      throw new Error(`POLICY: this would exceed today's daily cap of ${pol.dailyMaxAUT} AUT.`);

    const dest = await resolveToChecked(worker);
    if (pol.allowlist?.length && !pol.allowlist.map(a => String(a).toLowerCase()).includes(dest.address.toLowerCase()))
      throw new Error(`POLICY: ${dest.name || dest.address} is not on the owner's allowlist.`);
    if (dest.address.toLowerCase() === signer.address.toLowerCase())
      throw new Error(`cannot hire yourself.`);
    if (pol.payMinScore > 0) {
      const rscore = creditScore(await creditReport(dest.address));
      if (rscore < pol.payMinScore)
        throw new Error(`POLICY: ${dest.name || dest.address} scores ${rscore}/100, below the owner's minimum ${pol.payMinScore}.`);
    }

    const esc = new Contract(ESCROW, ESCROW_ABI, signer);
    let jobId = (await esc.nextJobId()).toString(); // best-effort id; confirmed from the receipt below
    recordSpend(wei);
    let tx;
    try {
      tx = await esc.createJob(dest.address, BigInt(dur), { value: wei, ...GAS });
      const rc = await waitTx(tx);
      // Authoritative jobId from the JobCreated event (robust to external concurrency).
      for (const l of rc.logs) {
        try { const p = esc.interface.parseLog(l); if (p && p.name === "JobCreated") { jobId = p.args.jobId.toString(); break; } } catch {}
      }
    } catch (e) { recordSpend(-wei); throw e; }
    return { content: [{ type: "text", text:
      `Hired ${dest.name || short(dest.address)} — job #${jobId}, ${amount} AUT escrowed, due in ${h}h.\n` +
      `They deliver, then you autyon_release(${jobId}). If they go silent after delivery, they can collect after the deadline.\nTx: ${SCAN}/tx/${tx.hash}` }] };
  })
);

server.tool(
  "autyon_deliver",
  "Mark a job you were hired for as delivered, posting a proof string (hashed on chain). Only the hired worker can call this.",
  { job_id: z.string(), proof: z.string().optional().describe("short proof/description, hashed on chain") },
  async ({ job_id, proof }) => withLock(async () => {
    const esc = new Contract(ESCROW, ESCROW_ABI, signer);
    const h = proof ? id(String(proof)) : "0x0000000000000000000000000000000000000000000000000000000000000000";
    const tx = await esc.deliver(BigInt(job_id), h, GAS);
    await waitTx(tx);
    return { content: [{ type: "text", text: `Delivered job #${job_id}. The client can now release payment (or you can collect after the deadline).\nTx: ${SCAN}/tx/${tx.hash}` }] };
  })
);

server.tool(
  "autyon_release",
  "Release an escrowed job's payment to the worker (only the client who created the job).",
  { job_id: z.string() },
  async ({ job_id }) => withLock(async () => {
    const esc = new Contract(ESCROW, ESCROW_ABI, signer);
    const tx = await esc.release(BigInt(job_id), GAS);
    await waitTx(tx);
    return { content: [{ type: "text", text: `Released payment for job #${job_id} to the worker.\nTx: ${SCAN}/tx/${tx.hash}` }] };
  })
);

server.tool(
  "autyon_collect",
  "As the worker, collect payment for a delivered job after its deadline has passed (used when the client goes silent).",
  { job_id: z.string() },
  async ({ job_id }) => withLock(async () => {
    const esc = new Contract(ESCROW, ESCROW_ABI, signer);
    const tx = await esc.autoRelease(BigInt(job_id), GAS);
    await waitTx(tx);
    return { content: [{ type: "text", text: `Collected payment for job #${job_id}.\nTx: ${SCAN}/tx/${tx.hash}` }] };
  })
);

server.tool(
  "autyon_cancel_job",
  "As the client, reclaim escrow: cancel a job the worker has not delivered, or refund it after the deadline if it was never delivered.",
  { job_id: z.string() },
  async ({ job_id }) => withLock(async () => {
    const escR = new Contract(ESCROW, ESCROW_ABI, provider);
    const j = await escR.getJob(BigInt(job_id));
    const esc = new Contract(ESCROW, ESCROW_ABI, signer);
    let tx;
    if (Number(j.status) === 1 && Date.now() / 1000 > Number(j.deadline)) tx = await esc.refundExpired(BigInt(job_id), GAS);
    else tx = await esc.cancel(BigInt(job_id), GAS);
    await waitTx(tx);
    return { content: [{ type: "text", text: `Refunded job #${job_id} to the client.\nTx: ${SCAN}/tx/${tx.hash}` }] };
  })
);

server.tool(
  "autyon_dispute",
  "Freeze an escrowed job for arbitration (either the client or the worker can call). An arbiter then splits the funds; if the arbiter is unresponsive, a deterministic timeout releases them.",
  { job_id: z.string() },
  async ({ job_id }) => withLock(async () => {
    const esc = new Contract(ESCROW, ESCROW_ABI, signer);
    const tx = await esc.dispute(BigInt(job_id), GAS);
    await waitTx(tx);
    return { content: [{ type: "text", text: `Disputed job #${job_id}. It is frozen pending arbitration.\nTx: ${SCAN}/tx/${tx.hash}` }] };
  })
);

server.tool(
  "autyon_jobs",
  "View escrow jobs. With a job_id, shows that job. Otherwise lists recent jobs where this agent is the client or the worker.",
  { job_id: z.string().optional() },
  async ({ job_id }) => {
    const esc = new Contract(ESCROW, ESCROW_ABI, provider);
    if (job_id) {
      const j = await esc.getJob(BigInt(job_id));
      if (j.client === ZeroAddress) throw new Error(`job #${job_id} does not exist.`);
      return { content: [{ type: "text", text: jobLines(job_id, j) + `\nExplorer: ${SCAN}/address/${ESCROW}` }] };
    }
    const me = signer.address.toLowerCase();
    const next = Number(await esc.nextJobId());
    const from = Math.max(1, next - 40);
    const mine = [];
    for (let i = next - 1; i >= from; i--) {
      try {
        const j = await esc.getJob(BigInt(i));
        if (j.client.toLowerCase() === me || j.worker.toLowerCase() === me) {
          const role = j.client.toLowerCase() === me ? "hired out" : "working";
          mine.push(`#${i} · ${JOB_STATUS[Number(j.status)]} · ${formatEther(j.amount)} AUT · ${role}`);
          if (mine.length >= 12) break;
        }
      } catch {}
    }
    return { content: [{ type: "text", text: (mine.length ? mine.join("\n") : "(no jobs involving this agent yet)") + `\nUse autyon_jobs with a job_id for details.` }] };
  }
);

/* ---------------- start ---------------- */
const transport = new StdioServerTransport();
await server.connect(transport);

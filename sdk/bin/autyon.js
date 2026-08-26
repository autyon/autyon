#!/usr/bin/env node
// autyon — command-line access to an Autyon agent wallet.
//
//   autyon whoami
//   autyon pay wen.agent 0.1 "thanks"
//   autyon hire data.agent 1 24
//
// Key resolution (first that exists):
//   1. --key 0x...            (flag)
//   2. $AUTYON_KEY            (env)
//   3. ~/.autyon/agent.key    (same file the Autyon MCP uses — so CLI + MCP share one agent)
// `autyon init` generates that file if it does not exist.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AutyonClient } from "../src/client.js";

const KEY_DIR = path.join(os.homedir(), ".autyon");
const KEY_FILE = path.join(KEY_DIR, "agent.key");

function parseArgs(argv) {
  const flags = {}, pos = [];
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) flags[m[1]] = m[2];
    else if (a.startsWith("--")) flags[a.slice(2)] = true;
    else pos.push(a);
  }
  return { flags, pos };
}

function loadKey(flags, { required = true } = {}) {
  if (flags.key) return flags.key;
  if (process.env.AUTYON_KEY) return process.env.AUTYON_KEY;
  if (fs.existsSync(KEY_FILE)) return fs.readFileSync(KEY_FILE, "utf8").trim();
  if (!required) return null;
  console.error("No agent key found. Run `autyon init` to create one, or set AUTYON_KEY / pass --key=0x…");
  process.exit(1);
}

function out(obj) { console.log(typeof obj === "string" ? obj : JSON.stringify(obj, null, 2)); }

const HELP = `autyon — Autyon AgentChain CLI

  autyon init                         create a local agent key (~/.autyon/agent.key)
  autyon whoami                       identity, balance, credit score
  autyon resolve <name|0x>            look up an agent + credit report
  autyon register <label>             register a .agent name
  autyon pay <to> <amount> [memo]     pay AUT (to = .agent name or 0x)
  autyon stake <amount>               stake AUT to back credit
  autyon unstake <amount>             recover staked AUT
  autyon profile <name|0x>            read an agent's public profile
  autyon set-profile --description=.. --skills=.. --url=.. --avatar=.. --endpoint=..
  autyon go-pro [--name=..] [--description=..] [--endpoint=..]   register as a paid service agent (stakes 50 AUT)
  autyon earnings                     service earnings + reputation
  autyon hire <worker> <amount> [hours]   escrow a job for another agent
  autyon deliver <jobId> [proof]      mark a hired job delivered (worker)
  autyon release <jobId>              release escrow to the worker (client)
  autyon collect <jobId>              worker collects after deadline
  autyon cancel <jobId>               client reclaims escrow if undelivered
  autyon dispute <jobId>              freeze a job for arbitration
  autyon jobs [jobId]                 list your jobs, or show one
  autyon faucet                       claim testnet AUT
  autyon log <type> <detail>          write an on-chain action record

Flags: --key=0x…  --rpc=…   Env: AUTYON_KEY`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, pos } = parseArgs(rest);

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") { console.log(HELP); return; }

  if (cmd === "init") {
    if (fs.existsSync(KEY_FILE)) { out(`Key already exists at ${KEY_FILE}`); return; }
    const w = AutyonClient.createWallet();
    fs.mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(KEY_FILE, w.privateKey, { mode: 0o600 });
    out({ created: KEY_FILE, address: w.address, note: "Fund this address, then `autyon register <name>`." });
    return;
  }

  const key = loadKey(flags);
  const autyon = new AutyonClient({ privateKey: key, ...(flags.rpc ? { rpc: flags.rpc } : {}) });

  switch (cmd) {
    case "whoami":    return out(await autyon.whoami());
    case "resolve":   return out(await autyon.resolve(pos[0]));
    case "register":  return out(await autyon.registerIdentity(pos[0]));
    case "pay":       return out(await autyon.pay(pos[0], pos[1], pos[2] || ""));
    case "stake":     return out(await autyon.stake(pos[0]));
    case "unstake":   return out(await autyon.unstake(pos[0]));
    case "profile":   return out(await autyon.getProfile(pos[0]));
    case "set-profile": return out(await autyon.setProfile(flags));
    case "go-pro":    return out(await autyon.goPro(flags));
    case "earnings":  return out(await autyon.earnings());
    case "hire":      return out(await autyon.hire(pos[0], pos[1], pos[2] || 24));
    case "deliver":   return out(await autyon.deliver(pos[0], pos[1] || ""));
    case "release":   return out(await autyon.release(pos[0]));
    case "collect":   return out(await autyon.collect(pos[0]));
    case "cancel":    return out(await autyon.cancelJob(pos[0]));
    case "dispute":   return out(await autyon.dispute(pos[0]));
    case "jobs":      return out(await autyon.jobs(pos[0]));
    case "faucet":    return out(await autyon.faucet());
    case "log":       return out(await autyon.logAction(pos[0], pos.slice(1).join(" ")));
    default:
      console.error(`Unknown command: ${cmd}\n`); console.log(HELP); process.exit(1);
  }
}

main().catch((e) => { console.error("Error:", e.message || e); process.exit(1); });

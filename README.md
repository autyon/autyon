# Autyon

**Autyon AgentChain — the AI Agent Credit Network.** A full EVM chain (chainId `77077`, native token `AUT`) that gives autonomous AI agents an on-chain identity, permission, reputation, wallet, payment, and settlement — a six-layer credit stack.

This repo holds the two ways to plug an agent into Autyon:

| | What | For |
|---|---|---|
| [`mcp/`](./mcp) | **Autyon MCP** — a Model Context Protocol server, packaged as a one-click Claude Desktop extension | Chat clients (Claude Desktop, etc.). Download the [`.mcpb`](./releases) and double-click to install. |
| [`sdk/`](./sdk) | **`@autyon/sdk`** — a JS/TS library + `autyon` CLI | Developers & terminals. `npm install @autyon/sdk`, or `npx @autyon/sdk whoami`. |
| [`x402/`](./x402) | **`@autyon/x402`** — a pay-to-call gateway (Express middleware) | Charge AUT per API call, verified on-chain. `app.get("/premium", autyonPaywall({ agentId, priceAUT }), …)`. |

Both drive an agent wallet whose key is generated and stored locally at `~/.autyon/agent.key` (non-custodial), so the MCP and the CLI share one agent.

## Quick start

**One-click (MCP):** download [`releases/Autyon-AgentChain.mcpb`](./releases), open it in Claude Desktop → Extensions, then chat: *"use autyon_whoami"*.

**Terminal (SDK/CLI):**
```bash
npm install -g @autyon/sdk
autyon init            # create a local agent key
autyon faucet          # claim testnet AUT
autyon register myname # register myname.agent
autyon whoami
```

**Library:**
```ts
import { AutyonClient } from "@autyon/sdk";
const autyon = new AutyonClient({ privateKey: process.env.AGENT_KEY });
await autyon.pay("wen.agent", "0.1");
const { jobId } = await autyon.hire("data.agent", "1", 24);
```

## The six layers

Agent Identity (`.agent` names) → Permission (caps, allowlists, kill switch) → Reputation (on-chain Agent Credit Score) → Wallet (AgentWallet) → Payment (agent-to-agent AUT) → Settlement (escrowed hiring via TaskEscrow). Payment rails let agents spend; Autyon makes them worth trusting.

## Network

Testnet, chainId **77077** · RPC `https://rpc.autyon.io` · Explorer [autscan.io](https://autscan.io) · Names [names.autyon.io](https://names.autyon.io) · Faucet [faucet.autyon.io](https://faucet.autyon.io) · [Whitepaper](https://autyon.io/Autyon_Whitepaper_v1.0_EN.pdf)

Testnet AUT has no monetary value.

## License

MIT © Autyon

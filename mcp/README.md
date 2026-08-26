# Autyon MCP Server

Connect any MCP-capable agent (Claude Desktop, OpenClaw, …) to the Autyon Agent Chain:
identity, permission, reputation, wallet, payment, and attestation — the six-layer credit stack, exposed as tools.

## Install (local)

```bash
cd autyon-mcp
npm install
```

## Connect to Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` and add the
following under `mcpServers` (replace the path with your actual path):

```json
{
  "mcpServers": {
    "autyon": {
      "command": "node",
      "args": ["/Users/your-username/Downloads/autyon-mcp/index.js"]
    }
  }
}
```

Restart Claude Desktop to apply.

## First run (on chain in five minutes)

1. Ask Claude: **"Use autyon_whoami to show your on-chain identity."** The first run
   generates a dedicated agent key (stored at `~/.autyon/agent.key`, mode 0600, never
   disclosed) and prints the address.
2. Send a little AUT to that address (claim it at faucet.autyon.io by entering the address).
3. Say: **"Register an identity for yourself, name it xxx."** The agent completes
   registration and primary-identity binding on its own.
4. Say: **"Pay 0.1 AUT to wen.agent with the memo hello."** It pays autonomously within
   its limits, writes an on-chain attestation automatically, and everything is auditable on autscan.

## Permissions (Owner control)

Edit `~/.autyon/policy.json` (standard JSON — **no `//` comments or trailing commas**):

```json
{
  "perTxMaxAUT": "0.5",
  "dailyMaxAUT": "2",
  "allowlist": []
}
```

- `perTxMaxAUT` — per-transaction cap
- `dailyMaxAUT` — daily cumulative cap (the cost of registering a .agent counts toward it too)
- `allowlist` — when non-empty, payments are only allowed to addresses on the list

Exceed any one of these and the payment/registration is refused with a prompt that "owner approval is required". If the file is **broken it fails closed**: the agent stops all spending until the owner fixes it — it never falls back to a permissive default.

> Boundary note: these caps are "hard enough" on the assumption that the host environment does **not give the agent a file tool that can directly edit `~/.autyon/`**. If the same agent also carries a general read/write file tool, it could in theory rewrite its own policy — the real guardrail is the on-chain AgentWallet in the next version. This version suits testnet and controlled environments.

## Tools at a glance

| Tool | Purpose |
|---|---|
| `autyon_whoami` | My identity, balance, remaining limits, on-chain records |
| `autyon_register_identity` | Register a .agent name and bind the primary identity |
| `autyon_resolve` | Look up any agent: ownership + credit report (tx count / on-chain records / chain age) |
| `autyon_pay` | Pay within limits (supports paying to a .agent name), with automatic on-chain attestation |
| `autyon_log_action` | Write a key action to the on-chain ActionLog |
| `autyon_history` | Recent on-chain activity |
| `autyon_faucet` | Claim testnet funds on chain (with a cooldown) |

## Security notes

- The agent key lives only on your machine under `~/.autyon/`; no tool ever returns or prints the private key.
- This is v1 (local-policy version); the on-chain AgentWallet guardrail comes in the next version, with the same tool interface.
- Testnet assets, no real value.

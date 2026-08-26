// contracts.js — Autyon Testnet deployed addresses + minimal ABIs.
// chainId 77077. All source-verified on https://autscan.io.

export const CHAIN_ID = 77077;
export const DEFAULT_RPC = "https://rpc.autyon.io";
export const DEFAULT_API = "https://api.autyon.io";
export const SCAN = "https://autscan.io";

export const ADDR = {
  registrar: "0x7F3636d9bBDc86320F14Ae7A852d9A9d1D57564c", // AgentNameNFT (.agent registrar)
  resolver:  "0xa9d5e19b1fcafb6f0b1810e026cc429a631ceb84", // AgentResolverV2
  actionLog: "0x106923dDF70A1AE237E7A4f7BBbE870CB3521436", // AgentActionLog
  faucet:    "0x8Eb08E93f61f8f835c1cf4C94fD74c14EF06C72B", // AutyonFaucet
  registry:  "0x0ed6dafe3de759a46e7b6f1d7290f491dfae820a", // AgentRegistry (service agents)
  service:   "0x3218003233f418bb83829c9627494b49ef0edf96", // ServicePayment
  escrow:    "0x1DB932d3Af53F42b806Bb984180DBE5Bf6682811", // TaskEscrow (hiring)
};

export const ABI = {
  registrar: [
    "function register(string label, address agentWallet) payable returns (bytes32)",
    "function available(string) view returns (bool)",
    "function price() view returns (uint256)",
    "function setPrimaryName(string label)",
    "function primaryName(address) view returns (string)",
    "function nodeOf(string) view returns (bytes32)",
    "function tokenIdOf(string) pure returns (uint256)",
    "function ownerOf(uint256) view returns (address)",
  ],
  resolver: [
    "function addr(bytes32) view returns (address)",
    "function wallet(bytes32) view returns (address)",
    "function setText(bytes32 node, string key, string value)",
    "function setTexts(bytes32 node, string[] keys, string[] values)",
    "function text(bytes32 node, string key) view returns (string)",
    "function texts_(bytes32 node, string[] keys) view returns (string[])",
  ],
  actionLog: [
    "function logAction(uint256 taskId, address agent, string actionType, address target, uint256 amount, string detail) returns (uint256)",
    "function getAgentActions(address agent) view returns (uint256[])",
  ],
  faucet: [
    "function claim()",
    "function timeUntilNextClaim(address) view returns (uint256)",
    "error CooldownActive(uint256 secondsRemaining)",
  ],
  registry: [
    "function registerAgent(bytes32 modelHash, bytes32 weightsHash, bytes32 systemPromptHash, string metadataURI) payable returns (uint256)",
    "function getAgent(uint256) view returns (tuple(address owner, bytes32 modelHash, bytes32 weightsHash, bytes32 systemPromptHash, string metadataURI, uint256 stakedAmount, uint256 reputation, uint256 totalEarned, uint256 totalCalls, uint256 registeredAt, uint8 status))",
    "function isActive(uint256) view returns (bool)",
    "function ownerAgents(address, uint256) view returns (uint256)",
    "function MIN_STAKE() view returns (uint256)",
  ],
  service: [
    "function lockStake() payable",
    "function unlockStake(uint256 amount)",
    "function payerLockedStake(address) view returns (uint256)",
    "function lockedUntil(address) view returns (uint256)",
    "function payAgent(uint256 agentId, address[3] referrers, bytes32 requestId) payable",
    "event ServicePaid(uint256 indexed agentId, address indexed payer, address indexed agentOwner, uint256 grossAmount, uint256 taxAmount, uint256 referralAmount, uint256 netToAgent, bytes32 requestId)",
  ],
  escrow: [
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
  ],
};

export const JOB_STATUS = ["none", "funded", "delivered", "released", "refunded", "disputed", "resolved"];
export const PROFILE_KEYS = ["description", "avatar", "url", "endpoint", "skills"];

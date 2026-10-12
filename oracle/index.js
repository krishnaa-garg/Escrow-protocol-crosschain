import "dotenv/config";
import http from "node:http";
import { ethers } from "ethers";

/**
 * REAL CROSS-CHAIN RELAY (still centralized, no longer mocked)
 * ---------------------------------------------------------------
 * This is 1 process with 1 signing key, standing in for what a real bridge
 * would do with multiple independent watchers + threshold signatures — say
 * that in the demo, it's still true.
 *
 *   1. Scans the SOURCE-chain Escrow contract for TransferLocked events
 *   2. Submits a REAL transaction on the DESTINATION chain, calling
 *      Receiver.deliver() — a separate contract on a separate network
 *   3. Waits for that destination transaction to actually mine, and reads
 *      back whether it succeeded or genuinely reverted on-chain
 *   4. Calls confirmDelivery() or reportFailure() back on the source chain
 *      based on that real outcome
 *
 * Hosting notes (Render / any free PaaS):
 *   - This process also runs a tiny HTTP server on $PORT. Free web services
 *     must listen on a port, and the frontend pings GET /health to wake the
 *     service up (free instances sleep after ~15 min with no traffic).
 *   - Instead of a long-lived event subscription (which silently dies when
 *     the host sleeps or a websocket drops), it sweeps new blocks on a timer
 *     and remembers the last block it scanned. After waking up it catches up
 *     on every lock it missed while asleep.
 */

const {
  SOURCE_RPC_URL,
  SOURCE_CHAIN_ID,
  ESCROW_ADDRESS,
  DEST_RPC_URL,
  DEST_CHAIN_ID,
  RECEIVER_ADDRESS,
  ORACLE_PRIVATE_KEY,
  START_BLOCK,
} = process.env;

const PORT = Number(process.env.PORT || process.env.ORACLE_PORT || 8080);
const POLL_MS = Number(process.env.POLL_MS || 15000);
// How far back to look on startup if START_BLOCK isn't set.
const BACKFILL_BLOCKS = Number(process.env.BACKFILL_BLOCKS || 2000);
// Max block range per eth_getLogs call. Drops to 10 automatically if the RPC
// rejects bigger ranges (e.g. Alchemy's free tier).
let logRange = Number(process.env.LOG_RANGE || 500);

const missing = [];
if (!SOURCE_RPC_URL) missing.push("SOURCE_RPC_URL");
if (!ESCROW_ADDRESS) missing.push("ESCROW_ADDRESS");
if (!ORACLE_PRIVATE_KEY) missing.push("ORACLE_PRIVATE_KEY");
if (!DEST_RPC_URL) missing.push("DEST_RPC_URL");
if (!RECEIVER_ADDRESS) missing.push("RECEIVER_ADDRESS");
if (missing.length) {
  console.error(
    `Missing required env vars: ${missing.join(", ")}. See oracle/.env.example ` +
      "(the Receiver contract must be deployed on the destination chain first, see contracts/scripts/deployReceiver.js)."
  );
  process.exit(1);
}

const ESCROW_ABI = [
  "event TransferLocked(uint256 indexed transferId, address indexed sender, address indexed recipient, address token, uint256 amount, uint256 destinationChainId, uint256 timeoutSeconds)",
  "function confirmDelivery(uint256 transferId) external",
  "function reportFailure(uint256 transferId) external",
  "function isOracle(address) external view returns (bool)",
  "function getTransfer(uint256 transferId) external view returns (tuple(address sender, address recipient, address token, uint256 amount, uint256 destinationChainId, uint256 createdAt, uint256 timeoutSeconds, uint8 status))",
];

const RECEIVER_ABI = [
  "function deliver(uint256 transferId, address recipient, uint256 amount, uint256 sourceChainId) external",
  "function wasDelivered(uint256 transferId) external view returns (bool)",
  "function isRelayer(address) external view returns (bool)",
];

// ethers' JsonRpcProvider only speaks http(s) — handing it a wss:// URL fails
// with "unsupported protocol wss". Accept either kind of URL.
function makeProvider(url, chainId) {
  const network = chainId ? Number(chainId) : undefined;
  // cacheTimeout -1: never reuse a cached nonce between back-to-back txs.
  const opts = network ? { staticNetwork: true, cacheTimeout: -1 } : { cacheTimeout: -1 };
  if (/^wss?:\/\//i.test(url)) {
    const p = new ethers.WebSocketProvider(url, network, opts);
    // If the socket drops, exit so the host restarts us cleanly.
    p.websocket?.addEventListener?.("close", () => {
      console.error("[oracle] websocket closed, exiting so the host restarts the service");
      process.exit(1);
    });
    return p;
  }
  return new ethers.JsonRpcProvider(url, network, opts);
}

const sourceProvider = makeProvider(SOURCE_RPC_URL, SOURCE_CHAIN_ID);
const sourceWallet = new ethers.Wallet(ORACLE_PRIVATE_KEY, sourceProvider);
const escrow = new ethers.Contract(ESCROW_ADDRESS, ESCROW_ABI, sourceWallet);

const destProvider = makeProvider(DEST_RPC_URL, DEST_CHAIN_ID);
const destWallet = new ethers.Wallet(ORACLE_PRIVATE_KEY, destProvider);
const receiver = new ethers.Contract(RECEIVER_ADDRESS, RECEIVER_ABI, destWallet);

const STATUS = { None: 0, Locked: 1, Confirmed: 2, Refunded: 3 };
const inFlight = new Set();
// Locks that hit a relayer-side problem (no gas, RPC down). Retried every sweep.
const retryQueue = new Map();

// State reported by GET /health, so you can see what's wrong from a browser.
const state = {
  startedAt: new Date().toISOString(),
  wallet: sourceWallet.address,
  setupProblems: [],
  lastScannedBlock: null,
  lastSweepAt: null,
  lastSweepError: null,
  handled: 0,
  retrying: [],
  lastResults: [], // most recent 10 outcomes
};

function log(...args) {
  console.log(`[oracle ${new Date().toISOString()}]`, ...args);
}

function record(entry) {
  state.lastResults.unshift({ at: new Date().toISOString(), ...entry });
  state.lastResults.length = Math.min(state.lastResults.length, 10);
}

function errMsg(err) {
  return err?.shortMessage || err?.reason || err?.message || String(err);
}

async function checkDestination(transferId, transfer) {
  try {
    // If an earlier run already delivered but crashed before confirming on the
    // source chain, don't call deliver() again (it would revert as a double
    // delivery and we'd wrongly refund).
    if (await receiver.wasDelivered(transferId)) {
      return { success: true, destTxHash: "(already delivered earlier)" };
    }
    const tx = await receiver.deliver(
      transferId,
      transfer.recipient,
      transfer.amount,
      SOURCE_CHAIN_ID ? Number(SOURCE_CHAIN_ID) : 0
    );
    log(`Destination tx submitted for #${transferId}: ${tx.hash} (waiting for confirmation on dest chain)`);
    const receipt = await tx.wait();

    if (receipt.status === 1) {
      return { success: true, destTxHash: tx.hash };
    }
    return { success: false, reason: `destination transaction failed (status ${receipt.status})`, destTxHash: tx.hash };
  } catch (err) {
    const reason = errMsg(err);
    // Out of gas money / RPC trouble is OUR problem, not a failed delivery.
    // Don't refund the user for it — leave the transfer Locked and retry on
    // the next sweep (the user can still self-refund after the timeout).
    if (/insufficient funds|could not detect network|timeout|ECONN|429|rate limit/i.test(reason)) {
      throw new Error(`relayer problem on destination chain, will retry: ${reason}`);
    }
    return { success: false, reason: `destination rejected: ${reason}` };
  }
}

async function handleLock(transferId, transfer) {
  const key = transferId.toString();
  if (inFlight.has(key)) return;
  inFlight.add(key);

  log(`Lock #${key}: ${transfer.sender} -> ${transfer.recipient}, amount=${transfer.amount.toString()}`);

  try {
    const result = await checkDestination(transferId, transfer);

    const current = await escrow.getTransfer(transferId);
    if (Number(current.status) !== STATUS.Locked) {
      log(`Transfer #${key} no longer Locked (status=${current.status}), skipping callback`);
      return;
    }

    if (result.success) {
      log(`Destination delivery confirmed for #${key} (dest tx: ${result.destTxHash}). Confirming on source chain...`);
      const tx = await escrow.confirmDelivery(transferId);
      await tx.wait();
      log(`#${key} confirmed, source tx: ${tx.hash}`);
      record({ transferId: key, outcome: "confirmed", sourceTx: tx.hash, destTx: result.destTxHash });
    } else {
      log(`Destination delivery failed for #${key}: ${result.reason}. Reporting failure on source chain...`);
      const tx = await escrow.reportFailure(transferId);
      await tx.wait();
      log(`#${key} refunded, source tx: ${tx.hash}`);
      record({ transferId: key, outcome: "refunded", reason: result.reason, sourceTx: tx.hash });
    }
    state.handled++;
    retryQueue.delete(key);
  } catch (err) {
    retryQueue.set(key, { transferId, transfer });
    log(`Error handling transfer #${key}:`, errMsg(err));
    record({ transferId: key, outcome: "error (will retry)", reason: errMsg(err) });
  } finally {
    inFlight.delete(key);
  }
}

async function getLocks(from, to) {
  const filter = escrow.filters.TransferLocked();
  try {
    return await escrow.queryFilter(filter, from, to);
  } catch (err) {
    if (to - from + 1 > 10 && logRange > 10) {
      log(`RPC rejected a ${to - from + 1}-block log query (${errMsg(err)}); switching to 10-block chunks`);
      logRange = 10;
      return null; // caller re-chunks
    }
    throw err;
  }
}

let sweeping = false;
async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    for (const [key, { transferId, transfer }] of retryQueue) {
      const current = await escrow.getTransfer(transferId);
      if (Number(current.status) === STATUS.Locked) await handleLock(transferId, transfer);
      else retryQueue.delete(key);
    }

    const latest = await sourceProvider.getBlockNumber();
    let from = state.lastScannedBlock === null ? latest : state.lastScannedBlock + 1;

    while (from <= latest) {
      const to = Math.min(latest, from + logRange - 1);
      const events = await getLocks(from, to);
      if (events === null) continue; // range shrank, retry same `from`

      for (const event of events) {
        const { transferId, sender, recipient, token, amount, destinationChainId, timeoutSeconds } = event.args;
        const current = await escrow.getTransfer(transferId);
        if (Number(current.status) === STATUS.Locked) {
          // Sequential on purpose: one signing key, avoid nonce collisions.
          await handleLock(transferId, { sender, recipient, token, amount, destinationChainId, timeoutSeconds });
        }
      }
      state.lastScannedBlock = to;
      from = to + 1;
    }
    state.retrying = [...retryQueue.keys()];
    state.lastSweepAt = new Date().toISOString();
    state.lastSweepError = null;
  } catch (err) {
    state.lastSweepError = errMsg(err);
    log("Sweep error (will retry):", state.lastSweepError);
  } finally {
    sweeping = false;
  }
}

async function checkSetup() {
  const problems = [];
  const fmt = (b) => `${ethers.formatEther(b)} ETH`;
  try {
    const [srcNet, dstNet] = await Promise.all([sourceProvider.getNetwork(), destProvider.getNetwork()]);
    log(`Connected: source chain ${srcNet.chainId}, destination chain ${dstNet.chainId}`);
  } catch (err) {
    problems.push(`Cannot reach an RPC: ${errMsg(err)}`);
  }
  try {
    const [srcBal, dstBal] = await Promise.all([
      sourceProvider.getBalance(sourceWallet.address),
      destProvider.getBalance(sourceWallet.address),
    ]);
    state.balances = { source: fmt(srcBal), destination: fmt(dstBal) };
    if (srcBal === 0n) problems.push("Oracle wallet has 0 balance on the SOURCE chain — it can't pay gas for confirmDelivery/reportFailure.");
    if (dstBal === 0n) problems.push("Oracle wallet has 0 balance on the DESTINATION chain — it can't pay gas for Receiver.deliver().");
  } catch (err) {
    problems.push(`Could not read wallet balances: ${errMsg(err)}`);
  }
  try {
    if (!(await escrow.isOracle(sourceWallet.address))) {
      problems.push(`Escrow at ${ESCROW_ADDRESS} does not trust ${sourceWallet.address} as an oracle — call setOracle(${sourceWallet.address}, true) from the owner wallet, or fix ORACLE_PRIVATE_KEY.`);
    }
  } catch (err) {
    problems.push(`Could not read Escrow.isOracle (wrong ESCROW_ADDRESS or wrong source chain?): ${errMsg(err)}`);
  }
  try {
    if (!(await receiver.isRelayer(destWallet.address))) {
      problems.push(`Receiver at ${RECEIVER_ADDRESS} does not trust ${destWallet.address} as a relayer — call setRelayer(${destWallet.address}, true) from the owner wallet.`);
    }
  } catch (err) {
    problems.push(`Could not read Receiver.isRelayer (wrong RECEIVER_ADDRESS or wrong destination chain?): ${errMsg(err)}`);
  }
  state.setupProblems = problems;
  for (const p of problems) log(`SETUP PROBLEM: ${p}`);
  return problems;
}

function startHttpServer() {
  let lastWakeSweep = 0;
  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json");
    const path = (req.url || "/").split("?")[0];
    if (path === "/" || path === "/health") {
      // A ping from the frontend right after a lock: catch up immediately.
      if (Date.now() - lastWakeSweep > 5000) {
        lastWakeSweep = Date.now();
        sweep();
      }
      res.end(JSON.stringify({ ok: state.setupProblems.length === 0, ...state }, null, 2));
      return;
    }
    if (path === "/check-setup") {
      await checkSetup();
      res.end(JSON.stringify({ ok: state.setupProblems.length === 0, ...state }, null, 2));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  server.listen(PORT, () => log(`Health endpoint listening on port ${PORT} (GET /health)`));
}

async function main() {
  log(`Oracle/relayer wallet: ${sourceWallet.address}`);
  log(`Source: Escrow at ${ESCROW_ADDRESS}`);
  log(`Destination: Receiver at ${RECEIVER_ADDRESS}`);

  startHttpServer();
  await checkSetup();

  try {
    const latest = await sourceProvider.getBlockNumber();
    const fromBlock = START_BLOCK ? Number(START_BLOCK) : Math.max(0, latest - BACKFILL_BLOCKS);
    state.lastScannedBlock = fromBlock - 1;
    log(`Backfilling TransferLocked events from block ${fromBlock} to ${latest}...`);
  } catch (err) {
    log(`Could not read the source chain's block number yet: ${errMsg(err)}`);
  }

  await sweep();
  setInterval(sweep, POLL_MS);
  log(`Listening for new locks every ${POLL_MS / 1000}s...`);
}

main().catch((err) => {
  console.error("Fatal oracle error:", err);
  process.exit(1);
});

import "dotenv/config";
import { ethers } from "ethers";

/**
 * REAL CROSS-CHAIN RELAY (still centralized, no longer mocked)
 * ---------------------------------------------------------------
 * This is 1 process with 1 signing key, standing in for what a real bridge
 * would do with multiple independent watchers + threshold signatures — say
 * that in the demo, it's still true.
 *
 * What changed from the earlier mocked version: "did delivery succeed" is
 * no longer decided by a JS string comparison against a hardcoded address.
 * Instead:
 *   1. Watches the SOURCE-chain Escrow contract for TransferLocked events
 *   2. Submits a REAL transaction on the DESTINATION chain, calling
 *      Receiver.deliver() — a separate contract on a separate network
 *   3. Waits for that destination transaction to actually mine, and reads
 *      back whether it succeeded or genuinely reverted on-chain
 *   4. Calls confirmDelivery() or reportFailure() back on the source chain
 *      based on that real outcome
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

if (!SOURCE_RPC_URL || !ESCROW_ADDRESS || !ORACLE_PRIVATE_KEY) {
  console.error(
    "Missing required env vars. Need SOURCE_RPC_URL, ESCROW_ADDRESS, ORACLE_PRIVATE_KEY (see .env.example)."
  );
  process.exit(1);
}
if (!DEST_RPC_URL || !RECEIVER_ADDRESS) {
  console.error(
    "Missing required env vars for the destination chain. Need DEST_RPC_URL and RECEIVER_ADDRESS " +
      "(deploy Receiver.sol there first, see contracts/scripts/deployReceiver.js)."
  );
  process.exit(1);
}

const ESCROW_ABI = [
  "event TransferLocked(uint256 indexed transferId, address indexed sender, address indexed recipient, address token, uint256 amount, uint256 destinationChainId, uint256 timeoutSeconds)",
  "function confirmDelivery(uint256 transferId) external",
  "function reportFailure(uint256 transferId) external",
  "function getTransfer(uint256 transferId) external view returns (tuple(address sender, address recipient, address token, uint256 amount, uint256 destinationChainId, uint256 createdAt, uint256 timeoutSeconds, uint8 status))",
];

const RECEIVER_ABI = [
  "function deliver(uint256 transferId, address recipient, uint256 amount, uint256 sourceChainId) external",
  "function wasDelivered(uint256 transferId) external view returns (bool)",
];

const sourceProvider = new ethers.JsonRpcProvider(SOURCE_RPC_URL, SOURCE_CHAIN_ID ? Number(SOURCE_CHAIN_ID) : undefined);
const sourceWallet = new ethers.Wallet(ORACLE_PRIVATE_KEY, sourceProvider);
const escrow = new ethers.Contract(ESCROW_ADDRESS, ESCROW_ABI, sourceWallet);

const destProvider = new ethers.JsonRpcProvider(DEST_RPC_URL, DEST_CHAIN_ID ? Number(DEST_CHAIN_ID) : undefined);
const destWallet = new ethers.Wallet(ORACLE_PRIVATE_KEY, destProvider);
const receiver = new ethers.Contract(RECEIVER_ADDRESS, RECEIVER_ABI, destWallet);

const STATUS = { None: 0, Locked: 1, Confirmed: 2, Refunded: 3 };
const inFlight = new Set();

function log(...args) {
  console.log(`[oracle ${new Date().toISOString()}]`, ...args);
}

async function checkDestination(transferId, transfer) {
  try {
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
    const reason = err.shortMessage || err.reason || err.message || String(err);
    return { success: false, reason: `destination rejected: ${reason}` };
  }
}

async function handleLock(transferId, transfer) {
  if (inFlight.has(transferId.toString())) return;
  inFlight.add(transferId.toString());

  log(`New lock #${transferId}: ${transfer.sender} -> ${transfer.recipient}, amount=${transfer.amount.toString()}`);

  try {
    const result = await checkDestination(transferId, transfer);

    const current = await escrow.getTransfer(transferId);
    if (Number(current.status) !== STATUS.Locked) {
      log(`Transfer #${transferId} no longer Locked (status=${current.status}), skipping callback`);
      return;
    }

    if (result.success) {
      log(`Destination delivery confirmed for #${transferId} (dest tx: ${result.destTxHash}). Confirming on source chain...`);
      const tx = await escrow.confirmDelivery(transferId);
      await tx.wait();
      log(`#${transferId} confirmed, source tx: ${tx.hash}`);
    } else {
      log(`Destination delivery failed for #${transferId}: ${result.reason}. Reporting failure on source chain...`);
      const tx = await escrow.reportFailure(transferId);
      await tx.wait();
      log(`#${transferId} refunded, source tx: ${tx.hash}`);
    }
  } catch (err) {
    log(`Error handling transfer #${transferId}:`, err.message || err);
  } finally {
    inFlight.delete(transferId.toString());
  }
}

async function main() {
  log(`Oracle/relayer wallet: ${sourceWallet.address}`);
  log(`Source: Escrow at ${ESCROW_ADDRESS} on ${SOURCE_RPC_URL}`);
  log(`Destination: Receiver at ${RECEIVER_ADDRESS} on ${DEST_RPC_URL}`);

  const sourceNetwork = await sourceProvider.getNetwork();
  const destNetwork = await destProvider.getNetwork();
  log(`Connected to source chain id ${sourceNetwork.chainId}, destination chain id ${destNetwork.chainId}`);

  escrow.on("TransferLocked", (transferId, sender, recipient, token, amount, destinationChainId, timeoutSeconds) => {
    handleLock(transferId, { sender, recipient, token, amount, destinationChainId, timeoutSeconds });
  });

  try {
    const fromBlock = START_BLOCK ? Number(START_BLOCK) : Math.max(0, (await sourceProvider.getBlockNumber()) - 5000);
    log(`Backfilling TransferLocked events from block ${fromBlock}...`);

    const filter = escrow.filters.TransferLocked();
    const pastEvents = await escrow.queryFilter(filter, fromBlock, "latest");

    for (const event of pastEvents) {
      const { transferId, sender, recipient, token, amount, destinationChainId, timeoutSeconds } = event.args;
      const current = await escrow.getTransfer(transferId);
      if (Number(current.status) === STATUS.Locked) {
        handleLock(transferId, { sender, recipient, token, amount, destinationChainId, timeoutSeconds });
      }
    }
  } catch (err) {
    log(`Backfill skipped (non-critical): ${err.message || err}`);
  }

  log("Backfill complete. Listening for new locks... (Ctrl+C to stop)");
}

main().catch((err) => {
  console.error("Fatal oracle error:", err);
  process.exit(1);
});

import "dotenv/config";

/**
 * Pre-flight wrong-network heuristic
 * -----------------------------------
 * Given an address and the chain the user is about to send on, ask: does
 * this address look like it "belongs" on a different chain than the one
 * selected? That's the single most common cross-chain mistake (e.g. pasting
 * an address you've only ever used on Polygon, then sending on Base).
 *
 * This is a heuristic, not proof of anything — it cannot know the user's
 * intent, and a brand-new address will always come back "unknown". Frame it
 * to users as a warning to double check, never as a guarantee.
 */

// Etherscan V2: as of August 2025, Etherscan retired the separate per-site
// V1 APIs (etherscan.io/api, basescan.org/api, polygonscan.org/api, etc).
// Everything now goes through ONE endpoint (api.etherscan.io/v2/api) with a
// `chainid` query param to pick the network, and ONE API key works across
// all of them — no need for separate Basescan/Polygonscan keys anymore.
const ETHERSCAN_V2_BASE = "https://api.etherscan.io/v2/api";

const CHAINS = {
  sepolia: {
    label: "Ethereum Sepolia",
    chainId: 11155111,
  },
  baseSepolia: {
    label: "Base Sepolia",
    chainId: 84532,
  },
  polygonAmoy: {
    label: "Polygon Amoy",
    chainId: 80002,
  },
};

const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || "";

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.json();
}

/**
 * Does this address have at least one transaction on the given chain?
 * Checks BOTH normal transactions (this address directly sent/received as
 * the primary transaction) AND internal transactions (this address received
 * funds via a contract's internal transfer, e.g. an escrow payout). An
 * address that has only ever passively received a contract payout would
 * otherwise look identical to a brand-new, never-used wallet if we only
 * checked normal transactions.
 */
async function hasActivity(chainKey) {
  const chain = CHAINS[chainKey];

  async function fetchTxCount(action, address) {
    const url = `${ETHERSCAN_V2_BASE}?chainid=${chain.chainId}&module=account&action=${action}&address=${address}&startblock=0&endblock=99999999&page=1&offset=1&sort=asc&apikey=${ETHERSCAN_API_KEY}`;
    const data = await fetchJson(url);
    // A rate-limited / errored request comes back as {status:"0", result:"<error text>"}
    // — a STRING, not an array. Without this check, that string was silently
    // read as "no transactions found" (Array.isArray(string) === false),
    // producing a confident-looking but wrong "no activity" result instead
    // of an honest "couldn't determine".
    if (!Array.isArray(data.result)) {
      console.error(`${action} check unexpected response for ${chainKey}:`, JSON.stringify(data).slice(0, 200));
      return null;
    }
    return data.result.length > 0;
  }

  return async function (address) {
    try {
      const normal = await fetchTxCount("txlist", address);
      if (normal === true) return true; // short-circuit — no need for the second call
      if (normal === null) return null;

      await new Promise((resolve) => setTimeout(resolve, 350));

      const internal = await fetchTxCount("txlistinternal", address);
      if (internal === null) return null;

      return internal === true;
    } catch (err) {
      console.error(`activity check failed for ${chainKey}:`, err.message);
      return null; // null = "couldn't determine", distinct from false
    }
  };
}

/** Is there contract bytecode deployed at this address on the given chain? */
async function hasContractCode(chainKey) {
  const chain = CHAINS[chainKey];
  return async function (address) {
    const url = `${ETHERSCAN_V2_BASE}?chainid=${chain.chainId}&module=proxy&action=eth_getCode&address=${address}&tag=latest&apikey=${ETHERSCAN_API_KEY}`;
    try {
      const data = await fetchJson(url);
      // eth_getCode via the proxy module returns the code directly as `result`
      // on success (no separate status field for `proxy` calls), but error
      // responses (bad/missing key, rate limit) come back as a JSON-RPC style
      // error object instead of a "0x..." hex string. Guard against treating
      // an error message as if it were bytecode.
      if (data.error) {
        console.error(`code check error for ${chainKey}:`, data.error.message || data.error);
        return null;
      }
      if (typeof data.result !== "string" || !data.result.startsWith("0x")) {
        console.error(`code check unexpected response for ${chainKey}:`, JSON.stringify(data).slice(0, 200));
        return null;
      }
      return data.result !== "0x" && data.result.length > 2;
    } catch (err) {
      console.error(`code check failed for ${chainKey}:`, err.message);
      return null;
    }
  };
}

/**
 * @param {string} address - address the user is about to send to
 * @param {string} selectedChainKey - key into CHAINS the user has selected to send on
 * @returns {Promise<{riskLevel: 'high'|'low'|'neutral'|'unknown', message: string, perChain: object}>}
 */
export async function checkAddress(address, selectedChainKey) {
  if (!CHAINS[selectedChainKey]) {
    throw new Error(`Unknown chain key: ${selectedChainKey}. Expected one of ${Object.keys(CHAINS).join(", ")}`);
  }

  const chainKeys = Object.keys(CHAINS);
  const perChain = {};

  // Etherscan's free tier allows only 3 requests/second. We need
  // chainKeys.length * 2 requests total (activity + contract check per
  // chain) — firing them all via Promise.all at once easily exceeds that
  // limit and causes rate-limit errors. Instead, run them one at a time
  // with a small delay between each, trading a bit of speed for reliability.
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  for (const key of chainKeys) {
    const activity = await (await hasActivity(key))(address);
    await delay(350);
    const isContract = await (await hasContractCode(key))(address);
    await delay(350);
    perChain[key] = { activity, isContract, label: CHAINS[key].label };
  }

  const selected = perChain[selectedChainKey];
  const otherKeys = chainKeys.filter((k) => k !== selectedChainKey);
  const activeElsewhere = otherKeys.filter((k) => perChain[k].activity === true);
  const activeHere = selected.activity === true;
  const anyDeterminationFailed = Object.values(perChain).some(
    (c) => c.activity === null || c.isContract === null
  );

  let riskLevel;
  let message;

  if (selected.isContract) {
    riskLevel = "high";
    message = `This address has contract bytecode on ${selected.label}. Sending an EOA-style transfer to a contract address can permanently lose funds if it doesn't implement a receive/fallback that handles it — double check this is really the address you mean to use.`;
  } else if (activeHere) {
    riskLevel = "low";
    message = `This address has prior transaction history on ${selected.label}. Looks consistent with the chain you've selected.`;
  } else if (!activeHere && activeElsewhere.length > 0) {
    riskLevel = "high";
    const elsewhereLabels = activeElsewhere.map((k) => perChain[k].label).join(", ");
    message = `This address has no history on ${selected.label}, but does have history on ${elsewhereLabels}. This looks like it might be an address you've used on a different chain — sending here could go to a wallet the recipient doesn't control on this network, or funds could become hard to recover. Consider routing this through escrow, or double-check the address and chain.`;
  } else {
    riskLevel = "neutral";
    message = `No prior activity found for this address on any of the chains we checked. Could be a brand-new wallet — we simply don't have enough history to warn either way.`;
  }

  if (anyDeterminationFailed) {
    message += " (Note: one or more explorer API checks failed or rate-limited, so this read may be incomplete.)";
  }

  return { riskLevel, message, perChain };
}

export { CHAINS };

# Cross-Chain Safe Transfer

Pre-flight wrong-network warning + opt-in escrow routing for cross-chain transfers.

**What this is:** a system that (1) warns you before you send to an address that looks
like it belongs on a different chain, and (2) lets you optionally route a transfer
through an escrow contract that only releases funds once a confirmation service verifies
delivery, with an automatic refund on timeout or failure.

**What this is not:** a system that can recover funds already sent directly, outside of
this escrow, to the wrong place. Nothing can do that — it's not a gap in the
engineering, it's how blockchains work. Say that line early in any pitch or demo.

## Repo layout

```
contracts/    Solidity Escrow contract + Hardhat tests + deploy script
oracle/       Off-chain confirmation service (Node.js, mocked/centralized)
preflight/    Wrong-network heuristic, exposed as a small HTTP API
frontend/     React + Vite + wagmi/RainbowKit UI
```

Each folder is its own independent Node project — no monorepo tooling, just `cd` in and
`npm install`.

---

## 0. Prerequisites

- **Node.js 18+** and npm
- **MetaMask** (or any WalletConnect-compatible wallet) in your browser
- Test funds on whichever 2 testnets you pick (recommendation: **Sepolia + Base
  Sepolia** — most reliable public faucets right now):
  - Sepolia faucet: `https://www.alchemy.com/faucets/ethereum-sepolia` or
    `https://sepoliafaucet.com`
  - Base Sepolia faucet: `https://www.alchemy.com/faucets/base-sepolia`
  - Polygon Amoy faucet: `https://faucet.polygon.technology` (if you use the 3rd chain)
- Free API keys, one each from:
  - `https://etherscan.io/apis` (also covers Sepolia)
  - `https://basescan.org/apis` (also covers Base Sepolia)
  - `https://polygonscan.com/apis` (also covers Polygon Amoy, only if using it)
- Free WalletConnect project id from `https://cloud.walletconnect.com`
- An RPC endpoint per chain — easiest is a free Alchemy or Infura account, one app per
  testnet. Grab both the **HTTPS** and **WSS** URLs for whichever chain you deploy the
  Escrow contract on (the oracle service wants the WSS one).

Pick **2 of the 3 testnets** (Sepolia, Base Sepolia, Polygon Amoy) for your actual demo.
Supporting all three multiplies setup and debugging time for no real demo value — the
frontend and preflight service already list all three, just leave the third
unconfigured (its address fields blank) if you skip it.

---

## 1. Smart contracts (`contracts/`)

```bash
cd contracts
npm install
cp .env.example .env   # if you don't have one — see below for the vars it needs
```

Create `contracts/.env`:

```
SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY
BASE_SEPOLIA_RPC_URL=https://base-sepolia.g.alchemy.com/v2/YOUR_KEY
POLYGON_AMOY_RPC_URL=https://polygon-amoy.g.alchemy.com/v2/YOUR_KEY

DEPLOYER_PRIVATE_KEY=0xyour_testnet_only_deployer_key
ORACLE_ADDRESS=0xthe_wallet_your_oracle_service_will_sign_with

ETHERSCAN_API_KEY=
BASESCAN_API_KEY=
POLYGONSCAN_API_KEY=
```

> `DEPLOYER_PRIVATE_KEY` and `ORACLE_ADDRESS` should be **testnet-only wallets you
> control**, never anything with real funds. The oracle wallet needs a little test ETH
> on the source chain to pay gas for `confirmDelivery`/`reportFailure` calls.

**Compile and test first — don't touch the frontend until these pass:**

```bash
npm run compile
npm test
```

You should see all tests pass, covering: lock → confirm → release, lock → timeout →
refund, oracle-only access control, and input validation. This is your Phase 1
checkpoint from the design doc.

**Deploy to your chosen testnet(s):**

```bash
npm run deploy:sepolia
# and/or
npm run deploy:baseSepolia
```

Copy the printed `Escrow deployed to: 0x...` address — you'll need it in both
`oracle/.env` and `frontend/.env`.

---

## 2. Oracle / confirmation service (`oracle/`)

This is the piece that watches for locks and calls back into the contract. It's
explicitly a mocked, centralized stand-in for a real bridge relay network — say so in
the demo.

```bash
cd ../oracle
npm install
cp .env.example .env
```

Fill in `oracle/.env` (see `oracle/.env.example` for all options):

```
SOURCE_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY       # HTTPS is fine (wss:// also works)
SOURCE_CHAIN_ID=11155111
ESCROW_ADDRESS=0x...       # Escrow, from the deploy step above
DEST_RPC_URL=https://base-sepolia.g.alchemy.com/v2/YOUR_KEY
DEST_CHAIN_ID=84532
RECEIVER_ADDRESS=0x...     # Receiver, from deployReceiver.js on the destination chain
ORACLE_PRIVATE_KEY=0x...   # matches ORACLE_ADDRESS above; needs test ETH on BOTH chains
```

Run it:

```bash
npm start
```

You should see `Listening for new locks...` and then, after any `lock()` call, a line
confirming or refunding it within ~15 seconds. Open `http://localhost:8080/health` to
see its state — any `setupProblems` (no gas, wallet not trusted by Escrow/Receiver,
wrong address) are listed there. This is your Phase 2
checkpoint — the full backend loop working with no human in it.

**Demoing the failure path:** any transfer locked with recipient
`0x000000000000000000000000000000000000dEaD` (or whatever you set
`FAIL_TEST_RECIPIENT` to) will be deliberately reported as failed by the oracle,
triggering an on-chain refund. That's your scripted "escrow catches a failure" demo
beat — no need to actually break anything on the destination chain live.

---

## 3. Pre-flight heuristic (`preflight/`)

```bash
cd ../preflight
npm install
cp .env.example .env
```

Fill in the three explorer API keys in `preflight/.env`, then run:

```bash
npm run dev
```

Sanity check it directly before wiring up the frontend:

```bash
curl "http://localhost:4001/check?address=0xSomeAddress&chain=sepolia"
```

You should get back JSON like:

```json
{
  "riskLevel": "high",
  "message": "This address has no history on Ethereum Sepolia, but does have history on Base Sepolia...",
  "perChain": { "sepolia": { "activity": false, "isContract": false, "label": "Ethereum Sepolia" }, ... }
}
```

This is your Phase 3 checkpoint — paste any real testnet address in, get a sensible
warning or clearance.

---

## 4. Frontend (`frontend/`)

```bash
cd ../frontend
npm install
cp .env.example .env
```

Fill in `frontend/.env`:

```
VITE_WALLETCONNECT_PROJECT_ID=your_walletconnect_project_id
VITE_PREFLIGHT_URL=http://localhost:4001
VITE_ESCROW_SEPOLIA=0x...
VITE_ESCROW_BASE_SEPOLIA=0x...
VITE_ESCROW_POLYGON_AMOY=0x...
```

Leave any chain's escrow address blank if you didn't deploy there — the app will just
disable the escrow button for that chain and tell you why.

```bash
npm run dev
```

Open `http://localhost:5173`, connect a wallet on one of your configured testnets, and
you should be able to:

1. Type an address → see the pre-flight beacon and message update
2. Choose "Send directly" (plain transfer, no protection) or "Route through escrow"
3. Watch the ledger panel poll on-chain status live: Locked → Confirming → Resolved

---

## Running everything together for a live demo

Open four terminals:

```bash
# terminal 1
cd oracle && npm start

# terminal 2
cd preflight && npm run dev

# terminal 3
cd frontend && npm run dev

# terminal 4 — keep free for hardhat console / manual checks if something needs poking
```

Before you go live:

- **Pre-fund every wallet you'll use in the demo.** Don't rely on a faucet working live.
- **Script the three scenes** exactly as in Phase 5 of the design doc: (a) a direct
  send gone wrong, (b) the same send prevented by the pre-flight warning, (c) an
  escrow transfer that deliberately fails and gets refunded live.
- **Record a backup video** of the full flow working end to end, in case testnet RPCs
  lag or a faucet is dry on the day. This is the single highest-leverage thing on this
  list.
- Open with the framing line, unprompted, early:

  > "This system prevents future wrong-network mistakes and protects transfers routed
  > through our escrow — it does not and cannot recover funds already sent directly
  > outside our system. That's a fundamental property of how blockchains work, not a
  > gap in our engineering."

---

## Troubleshooting

- **Oracle never confirms:** open its `/health` URL and read `setupProblems`. The usual
  causes are: the oracle wallet ran out of test ETH on one of the two chains, the
  wallet behind `ORACLE_PRIVATE_KEY` isn't the one Escrow (`setOracle`) or Receiver
  (`setRelayer`) trusts, or the service isn't running at all (it's not part of the
  Vercel deploy — see "Deploying" below).
- **Preflight always returns "unknown":** you're likely rate-limited or missing an API
  key for that chain's explorer — check the service's console logs, it prints the
  underlying fetch error.
- **Frontend shows "No Escrow address configured":** the corresponding
  `VITE_ESCROW_*` env var is empty — deploy to that chain or leave it out of your demo.
- **wagmi/RainbowKit version drift:** these libraries move fast; if `npm install`
  pulls in a breaking newer minor version, pin the exact versions from
  `frontend/package.json` with `npm install <pkg>@<version>`.

---

## Deploying (Vercel + Render free tier)

Only `frontend/` runs on Vercel. `preflight/` and `oracle/` are separate Node services
that must be hosted somewhere else, e.g. Render.

| Piece | Where | Notes |
|---|---|---|
| `frontend/` | Vercel, root directory `frontend` | env vars: everything in `frontend/.env.example` |
| `preflight/` | Render **Web Service**, root `preflight`, start `npm run dev` | put its URL in Vercel as `VITE_PREFLIGHT_URL` |
| `oracle/` | Render **Web Service**, root `oracle`, build `npm install`, start `npm start` | env vars from `oracle/.env.example`; put its URL in Vercel as `VITE_ORACLE_URL` |

The oracle is a background job, not an API — the frontend never calls it for data. It's
deployed as a Web Service (not a Background Worker, which Render doesn't offer free)
and exposes `/health` so the host sees an open port and so the frontend can wake it.
Free web services sleep after ~15 min idle; the frontend pings `/health` on page load
and after every lock, and on wake the oracle scans back over recent blocks so no lock
is missed. Escrow's on-chain timeout refund still protects users if it's down.

After changing any `VITE_*` variable in Vercel, **redeploy** — Vite bakes them in at
build time.

## Team split (3–4 people)

| Person | Owns | Depends on |
|---|---|---|
| A | `contracts/` (Phase 1) | — |
| B | `oracle/` (Phase 2) | A's function signatures, agreed Day 1 |
| C | `preflight/` (Phase 3) | — (fully independent, start Day 1) |
| D / shared | `frontend/` (Phase 4) | A + C's basic versions working |

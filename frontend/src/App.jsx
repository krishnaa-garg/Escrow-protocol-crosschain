import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import {
  useAccount,
  useChainId,
  useSwitchChain,
  useWriteContract,
  useWaitForTransactionReceipt,
  useReadContract,
  useSendTransaction,
  usePublicClient,
  useBalance,
} from "wagmi";
import { parseEther, isAddress, decodeEventLog } from "viem";
import { sepolia, baseSepolia, polygonAmoy } from "wagmi/chains";
import { escrowAbi, escrowAddresses, preflightChainKey, STATUS_LABELS } from "./contracts.js";

const CHAINS = [sepolia, baseSepolia, polygonAmoy];
const PREFLIGHT_URL = import.meta.env.VITE_PREFLIGHT_URL || "http://localhost:4001";
const LEDGER_KEY = "cross-chain-escrow-ledger";

// --- Semantic signal palette. Only meaning, never decoration. -------
const FILL = {
  good: "bg-signalGood text-signalGood",
  warn: "bg-signalWarn text-signalWarn",
  bad: "bg-signalBad text-signalBad",
  info: "bg-signalInfo text-signalInfo",
  unknown: "bg-inkTertiary text-inkTertiary",
};
const GLOW = {
  good: "shadow-glowGood",
  warn: "shadow-glowWarn",
  bad: "shadow-glowBad",
  info: "shadow-glowInfo",
  unknown: "shadow-glowUnknown",
};
const SIZE = { sm: "h-2 w-2", md: "h-3 w-3", lg: "h-4 w-4" };

// Maps preflight risk levels onto the signal palette.
const RISK_TO_SIGNAL = {
  low: "good",
  high: "bad",
  neutral: "warn",
  unknown: "unknown",
};

// --- Signal beacon: the one recurring motif. Color + pulse state carry
// the meaning; nothing else in the UI competes for attention with it. ---
function Beacon({ level, pulsing = false, size = "md" }) {
  const key = FILL[level] ? level : "unknown";
  return (
    <span className={`inline-flex items-center justify-center rounded-full ${GLOW[key]}`}>
      <span
        className={`inline-block rounded-full ${SIZE[size]} ${FILL[key]} ${
          pulsing ? "beacon-pulse" : ""
        }`}
      />
    </span>
  );
}

function short(addr) {
  if (!addr) return "";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function loadLedger() {
  try {
    const raw = localStorage.getItem(LEDGER_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveLedger(entries) {
  localStorage.setItem(LEDGER_KEY, JSON.stringify(entries));
}
// --- Visual primitives -------------------------------------------------

// Recurring visual motif alongside the beacon: three frosted orbs.
function BackgroundOrbs() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
    >
      <div className="orb orb-a" />
      <div className="orb orb-b" />
      <div className="orb orb-c" />
    </div>
  );
}

function BrandMark() {
  return (
    <span
      aria-hidden="true"
      className="brand-mark inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-card"
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 12a9 9 0 0 1 15.364-6.364L21 8" />
        <path d="M21 3v5h-5" />
        <path d="M21 12a9 9 0 0 1-15.364 6.364L3 16" />
        <path d="M3 21v-5h5" />
      </svg>
    </span>
  );
}

// Glassmorphic wallet button; keeps RainbowKit's connect modal + theming.
function GlassConnectButton() {
  return (
    <ConnectButton.Custom>
      {({ account, chain, openAccountModal, openChainModal, openConnectModal, mounted }) => {
        const ready = mounted;
        const connected = ready && account && chain;
        return (
          <div
            aria-hidden={!ready}
            className={ready ? "" : "pointer-events-none select-none opacity-0"}
          >
            {(() => {
              if (!connected) {
                return (
                  <button onClick={openConnectModal} className="glass-button-primary">
                    Connect wallet
                  </button>
                );
              }
              if (chain.unsupported) {
                return (
                  <button onClick={openChainModal} className="glass-button-secondary">
                    <span className="inline-block h-2 w-2 rounded-full bg-signalWarn shadow-glowWarn" />
                    Wrong network
                  </button>
                );
              }
              return (
                <div className="flex items-center gap-2.5">
                  <button
                    onClick={openChainModal}
                    className="glass-chip"
                    aria-label={`switch network · currently ${chain.name}`}
                  >
                    <span className="inline-block h-2 w-2 rounded-full bg-signalGood shadow-glowGood" />
                    {chain.name}
                  </button>
                  <button onClick={openAccountModal} className="glass-button-secondary py-2.5 text-xs">
                    {account.displayName}
                  </button>
                </div>
              );
            })()}
          </div>
        );
      }}
    </ConnectButton.Custom>
  );
}

// --- Progress rail for a single transfer's real lifecycle. Numbering here
// is legitimate: Locked -> Confirming -> Released/Refunded is an actual
// ordered process, not decoration. ---
function StatusRail({ statusIndex }) {
  const steps = ["Locked", "Confirming", "Resolved"];
  const activeIndex = statusIndex === 1 ? 1 : statusIndex >= 2 ? 2 : 0;
  return (
    <div className="flex items-center gap-1.5" role="img" aria-label={steps[activeIndex] || "Pending"}>
      {steps.map((step, i) => (
        <span
          key={step}
          className={`inline-block h-1.5 rounded-full transition-all duration-500 ${
            i <= activeIndex ? "w-6 bg-accentBlue/80 shadow-glowInfo" : "w-6 bg-glass-strong"
          }`}
        />
      ))}
    </div>
  );
}

function TransferRow({ entry, chain }) {
  const address = escrowAddresses[chain.id];
  const { data: onchain } = useReadContract({
    address,
    abi: escrowAbi,
    functionName: "getTransfer",
    args: [BigInt(entry.transferId)],
    chainId: chain.id,
    query: { refetchInterval: 5000, enabled: Boolean(address) },
  });

  const status = onchain ? Number(onchain.status) : 1;
  const statusLabel = STATUS_LABELS[status] || "Locked";
  const level = status === 2 ? "good" : status === 3 ? "warn" : "info";

  return (
    <div className="glass-card flex items-center justify-between gap-4 px-5 py-4">
      <div className="flex items-center gap-3.5 min-w-0">
        <Beacon level={level} pulsing={status === 1} />
        <div className="min-w-0">
          <div className="font-mono text-sm text-ink truncate">
            #{entry.transferId} <span className="text-inkTertiary">→</span> {short(entry.recipient)}
          </div>
          <div className="mt-0.5 text-xs font-mono text-inkSecondary">
            {entry.amount} ETH · {chain.name}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <StatusRail statusIndex={status} />
        <span className="w-20 text-right font-display text-[11px] font-medium uppercase tracking-[0.14em] text-inkSecondary">
          {statusLabel}
        </span>
      </div>
    </div>
  );
}
// --- One-time onboarding walkthrough: 4 dismissible slides shown after the
// first successful wallet connection. Completion is tracked with a single
// localStorage boolean, so it stays gone per browser — not per wallet address.
// No wallet_switchEthereumChain / wallet_addEthereumChain here on purpose: an
// unsupported network is flagged and the user switches manually in their wallet.
const ONBOARDING_KEY = "onboarding_complete";
const SUPPORTED_NETWORK_IDS = new Set([11155111, 84532]); // Sepolia, Base Sepolia

function completeOnboarding() {
  localStorage.setItem(ONBOARDING_KEY, "1");
}

function OnboardingWalkthrough({ chainId, chainName, showFaucet, onClose }) {
  const supported = SUPPORTED_NETWORK_IDS.has(chainId);
  const total = showFaucet ? 4 : 3;
  const [step, setStep] = useState(0);

  const steps = [
    {
      title: "Network check",
      body: (
        <>
          <p>
            Your wallet is on <span className="font-mono text-signalInfo">{chainName}</span>.
          </p>
          {supported ? (
            <p className="text-signalGood">
              This network is supported — you're all set to send.
            </p>
          ) : (
            <p className="text-signalWarn">
              This network isn't supported. Crypter works on <b className="text-ink">Sepolia</b> and{" "}
              <b className="text-ink">Base Sepolia</b>. Switch networks manually in your wallet and come back
              here.
            </p>
          )}
        </>
      ),
    },
    {
      title: "What the risk check means",
      body: (
        <p>
          Risk warnings are a <b className="text-ink">heuristic</b> based on comparing a recipient's activity
          across chains — they are <b className="text-ink">not proof</b>, and they <b className="text-ink">never block a
          transaction</b>. Treat a warning as a prompt to double-check, not a hard stop.
        </p>
      ),
    },
    {
      title: "Direct vs. escrow",
      body: (
        <div className="space-y-2.5">
          <p>
            <b className="text-ink">Direct</b> — sends immediately and is{" "}
            <b className="text-ink">irreversible</b>.
          </p>
          <p>
            <b className="text-ink">Escrow</b> — locks funds until a confirmation service
            verifies delivery, with an <b className="text-ink">automatic refund</b> on
            failure or timeout.
          </p>
        </div>
      ),
    },
    {
      title: "Get test funds",
      body: (
        <div className="space-y-3">
          <p>Your wallet has no balance on the active chain. Grab test ETH first:</p>
          <ul className="space-y-1.5">
            <li>
              <a
                className="text-signalInfo underline underline-offset-2"
                href="https://www.alchemy.com/faucets/ethereum-sepolia"
                target="_blank"
                rel="noreferrer"
              >
                Sepolia faucet →
              </a>
            </li>
            <li>
              <a
                className="text-signalInfo underline underline-offset-2"
                href="https://www.alchemy.com/faucets/base-sepolia"
                target="_blank"
                rel="noreferrer"
              >
                Base Sepolia faucet →
              </a>
            </li>
          </ul>
        </div>
      ),
    },
  ];

  function handleNext() {
    if (step === 2 && !showFaucet) return onClose(); // skip faucet step, finish
    if (step >= total - 1) return onClose(); // made it through the last step
    setStep((s) => s + 1);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/65 backdrop-blur-modal p-4">
      <div className="glass-panel w-full max-w-md p-7 space-y-6 shadow-glass">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5" aria-label="Step progress">
            {Array.from({ length: total }).map((_, i) => (
              <span
                key={i}
                className={`inline-block h-1.5 w-6 rounded-full transition-colors duration-300 ${
                  i <= step ? "bg-accentBlue shadow-glowInfo" : "bg-glass-strong"
                }`}
              />
            ))}
          </div>
          {/* Visible Skip on every step: exits immediately, never reappears. */}
          <button onClick={onClose} className="glass-button-ghost text-xs font-mono uppercase tracking-widest">
            Skip
          </button>
        </div>

        <div>
          <h2 className="font-display text-lg font-semibold tracking-tight text-ink">
            {steps[step].title}
          </h2>
          <div className="mt-3 space-y-2.5 text-sm leading-relaxed text-inkSecondary">
            {steps[step].body}
          </div>
        </div>

        <button onClick={handleNext} className="glass-button-primary w-full">
          {step >= total - 1 ? "Done" : "Next"}
        </button>

        <p className="text-center space-y-1">
          <button
            onClick={onClose}
            className="text-xs font-mono text-inkTertiary hover:text-ink transition"
          >
            Skip walkthrough
          </button>
        </p>
      </div>
    </div>
  );
}
export default function App() {
  const { address: account, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const currentChain = CHAINS.find((c) => c.id === chainId) || CHAINS[0];

  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("0.01");
  const [timeoutMinutes, setTimeoutMinutes] = useState(10);
  const [check, setCheck] = useState(null); // { riskLevel, message } | null
  const [checking, setChecking] = useState(false);
  const [ledger, setLedger] = useState(loadLedger);

  // --- Onboarding: show the walkthrough exactly once, right after the first
  // wallet connection, unless onboarding_complete is already set. Uses a ref to
  // catch the disconnected -> connected transition (a reload with the wallet
  // already connected doesn't count as a "first connection"). Because completion
  // is a single localStorage boolean, a second wallet address in the same
  // browser never re-triggers it. ---
  const [showWalkthrough, setShowWalkthrough] = useState(false);
  const wasConnected = useRef(false);

  useEffect(() => {
    if (!isConnected) {
      wasConnected.current = false;
      return;
    }
    if (wasConnected.current) return; // not a fresh connection
    wasConnected.current = true;
    if (localStorage.getItem(ONBOARDING_KEY) === "1") return; // already onboarded
    setShowWalkthrough(true);
  }, [isConnected]);

  // Faucet step only shows if the wallet has zero balance on the active chain.
  const { data: balanceData } = useBalance({ address: account, chainId });
  const hasZeroBalance = balanceData ? balanceData.value === 0n : false;
  const walkthroughChainName =
    CHAINS.find((c) => c.id === chainId)?.name || `Chain #${chainId}`;

  const { writeContractAsync, isPending: isLocking } = useWriteContract();
  const { sendTransactionAsync, isPending: isSendingDirect } = useSendTransaction();
  const publicClient = usePublicClient({ chainId: currentChain.id });

  useEffect(() => saveLedger(ledger), [ledger]);

  const runPreflight = useCallback(async () => {
    if (!isAddress(recipient)) {
      setCheck(null);
      return;
    }
    const chainKey = preflightChainKey[currentChain.id];
    setChecking(true);
    try {
      const res = await fetch(`${PREFLIGHT_URL}/check?address=${recipient}&chain=${chainKey}`);
      const data = await res.json();
      setCheck(res.ok ? data : { riskLevel: "unknown", message: data.error || "Pre-flight check failed." });
    } catch (err) {
      setCheck({ riskLevel: "unknown", message: "Could not reach the pre-flight service — is it running?" });
    } finally {
      setChecking(false);
    }
  }, [recipient, currentChain.id]);

  useEffect(() => {
    const t = setTimeout(runPreflight, 500); // debounce
    return () => clearTimeout(t);
  }, [runPreflight]);

  const escrowAddress = escrowAddresses[currentChain.id];
  const canTransact = isConnected && isAddress(recipient) && Number(amount) > 0;

  async function handleSendDirect() {
    await sendTransactionAsync({ to: recipient, value: parseEther(amount) });
  }

  async function handleSendViaEscrow() {
    const txHash = await writeContractAsync({
      address: escrowAddress,
      abi: escrowAbi,
      functionName: "lock",
      args: [
        BigInt(currentChain.id), // destinationChainId — same-chain demo; swap in real dest id if bridging
        recipient,
        "0x0000000000000000000000000000000000000000",
        parseEther(amount),
        BigInt(timeoutMinutes * 60),
      ],
      value: parseEther(amount),
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    let realTransferId = null;
    for (const logEntry of receipt.logs) {
      if (logEntry.address.toLowerCase() !== escrowAddress.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({
          abi: escrowAbi,
          data: logEntry.data,
          topics: logEntry.topics,
        });
        if (decoded.eventName === "TransferLocked") {
          realTransferId = Number(decoded.args.transferId);
          break;
        }
      } catch {
        // Not the event we're looking for (or not decodable with this ABI) — skip.
      }
    }

    if (realTransferId === null) {
      console.error("Could not find TransferLocked event in receipt — ledger entry may be inaccurate.");
      return;
    }

    setLedger((prev) => [
      ...prev,
      { transferId: realTransferId, recipient, amount, chainId: currentChain.id, txHash },
    ]);
  }

  return (
    <div className="relative min-h-screen text-ink font-body overflow-x-clip">
      <BackgroundOrbs />

      <div className="relative z-10 flex flex-col">
        <header className="mx-auto w-full max-w-6xl px-4 pt-6 sm:px-6">
          <div className="glass-toolbar flex items-center justify-between gap-4 px-5 py-4 sm:px-6">
            <div className="flex items-center gap-3.5 min-w-0">
              <BrandMark />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2.5">
                  <h1 className="font-display text-lg font-semibold tracking-tight text-ink">
                    Crypter
                  </h1>
                  <span className="glass-chip !px-2.5 !py-1 text-[10px] font-mono uppercase tracking-widest text-inkTertiary">
                    Testnet
                  </span>
                </div>
                <p className="truncate text-xs text-inkTertiary">
                  Cross-chain escrow · not financial advice
                </p>
              </div>
            </div>
            <GlassConnectButton />
          </div>
        </header>

        <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
          <div className="grid items-start gap-5 lg:grid-cols-5">
            {/* SEND PANEL */}
            <section className="glass-panel p-6 sm:p-7 space-y-5 lg:col-span-2">
              <div>
                <h2 className="eyebrow">Send</h2>
                <p className="mt-2 text-xs leading-relaxed text-inkSecondary">
                  Prevents wrong-network mistakes and protects transfers you route
                  through escrow. It cannot recover funds already sent directly
                  outside this system — that's a property of how blockchains work.
                </p>
              </div>

              <div className="space-y-1.5">
                <label className="label" htmlFor="chain">Chain</label>
                <select
                  id="chain"
                  className="glass-control glass-select"
                  value={currentChain.id}
                  onChange={(e) => switchChain?.({ chainId: Number(e.target.value) })}
                >
                  {CHAINS.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <label className="label" htmlFor="recipient">Recipient address</label>
                <input
                  id="recipient"
                  className="glass-control"
                  placeholder="0x…"
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value.trim())}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="label" htmlFor="amount">Amount (ETH)</label>
                  <input
                    id="amount"
                    className="glass-control"
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="label" htmlFor="timeout">Escrow timeout (min)</label>
                  <input
                    id="timeout"
                    className="glass-control"
                    type="number"
                    min={5}
                    value={timeoutMinutes}
                    onChange={(e) => setTimeoutMinutes(Number(e.target.value))}
                  />
                </div>
              </div>

              {/* Pre-flight warning */}
              {recipient && (
                <div className="glass-callout">
                  <Beacon
                    level={checking ? "info" : RISK_TO_SIGNAL[check?.riskLevel] || "unknown"}
                    pulsing={checking}
                    size="sm"
                  />
                  <p className="text-xs leading-relaxed text-inkSecondary">
                    {checking
                      ? "Checking address history across supported chains…"
                      : check?.message || "Enter an address to run the pre-flight check."}
                  </p>
                </div>
              )}

              <div className="flex gap-3 pt-1">
                <button
                  disabled={!canTransact || isSendingDirect}
                  onClick={handleSendDirect}
                  className="glass-button-secondary flex-1"
                >
                  {isSendingDirect ? "Sending…" : "Send directly"}
                </button>
                <button
                  disabled={!canTransact || isLocking || !escrowAddress}
                  onClick={handleSendViaEscrow}
                  className="glass-button-primary flex-1"
                >
                  {isLocking ? "Locking…" : "Route through escrow"}
                </button>
              </div>
              {!escrowAddress && (
                <p className="text-xs text-signalWarn">
                  No Escrow address configured for {currentChain.name} — set VITE_ESCROW_* in frontend/.env after deploying.
                </p>
              )}
            </section>
{/* LEDGER PANEL */}
            <section className="glass-panel p-6 sm:p-7 lg:col-span-3 flex flex-col space-y-5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="eyebrow">Transfer ledger</h2>
                <span className="glass-chip">
                  {ledger.length} escrow {ledger.length === 1 ? "transfer" : "transfers"}
                </span>
              </div>

              {ledger.length === 0 ? (
                <div className="glass-empty">
                  <p className="text-xs text-inkTertiary text-center">
                    Transfers routed through escrow will appear here, live.
                  </p>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {ledger
                    .slice()
                    .reverse()
                    .map((entry) => (
                      <TransferRow
                        key={entry.transferId}
                        entry={entry}
                        chain={CHAINS.find((c) => c.id === entry.chainId) || currentChain}
                      />
                    ))}
                </div>
              )}
            </section>
          </div>

          <footer className="mt-8 pb-6 text-center">
            <p className="text-[11px] text-inkTertiary">
              Testnet only — never mainnet. Don't send real funds through this demo.
            </p>
          </footer>
        </main>
      </div>

      {showWalkthrough && (
        <OnboardingWalkthrough
          chainId={chainId}
          chainName={walkthroughChainName}
          showFaucet={hasZeroBalance}
          onClose={() => {
            completeOnboarding();
            setShowWalkthrough(false);
          }}
        />
      )}
    </div>
  );
}
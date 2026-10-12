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
import { parseEther, formatEther, isAddress, decodeEventLog } from "viem";
import { sepolia, baseSepolia, polygonAmoy } from "wagmi/chains";
import { escrowAbi, escrowAddresses, preflightChainKey, STATUS_LABELS } from "./contracts.js";

const CHAINS = [sepolia, baseSepolia, polygonAmoy];
const PREFLIGHT_URL = import.meta.env.VITE_PREFLIGHT_URL || "http://localhost:4001";
// The oracle has no API the UI depends on — this URL is only pinged so a
// free-tier host (Render etc.) that went to sleep wakes up and processes locks.
const ORACLE_URL = import.meta.env.VITE_ORACLE_URL || "";
function wakeOracle() {
  if (!ORACLE_URL) return;
  fetch(`${ORACLE_URL.replace(/\/$/, "")}/health`).catch(() => {});
}
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

// Renders a raw useBalance result as a compact, human-friendly token value.
function formatBalance(balance) {
  if (!balance) return null;
  const n = Number(balance.formatted);
  if (!Number.isFinite(n)) return null;
  const amount = n === 0 ? "0" : n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return `${amount} ${balance.symbol}`;
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

/* The origami owl glyph — shared by both faces of the 3D coin. */
/* The origami owl glyph — shared by both faces of the 3D coin.
   Low-poly folded-paper head: lit planes upper-left, shadow planes
   right/underside, deep-set diamond eyes, two-tone folded beak. */
function OwlGlyph() {
  return (
    <svg
      width="38"
      height="38"
      viewBox="0 0 24 24"
      fill="none"
    >
      {/* Base sheet — whole head silhouette in mid tone (fills facet seams) */}
      <path
        d="M12 1.6 L9.3 3.4 L5.2 1.2 L3.4 5.2 L2 10.6 L2.8 14.8 L4.6 18.2 L8.6 20.8 L12 21.8 L15.4 20.8 L19.4 18.2 L21.2 14.8 L22 10.6 L20.6 5.2 L18.8 1.2 L14.7 3.4 Z"
        fill="#dbe3f2"
        stroke="#040406"
        strokeWidth="0.85"
        strokeLinejoin="round"
      />
      {/* ── Lit planes (light source upper-left) ── */}
      <path d="M12 1.6 L9.3 3.4 L12 7.4 Z" fill="#f9fbff" />
      <path d="M9.3 3.4 L6.6 7.2 L9.8 9.4 L12 7.4 Z" fill="#f1f5fc" />
      <path d="M6.6 7.2 L9.8 9.4 L10.4 13.2 L7.2 13.8 L4.8 11 Z" fill="#e9eef8" />
      {/* ── Mid planes ── */}
      <path d="M12 1.6 L14.7 3.4 L12 7.4 Z" fill="#e6ecf8" />
      <path d="M14.7 3.4 L17.4 7.2 L14.2 9.4 L12 7.4 Z" fill="#dde5f3" />
      <path d="M3.4 5.2 L6.6 7.2 L4.8 11 L2 10.6 Z" fill="#d0daec" />
      {/* ── Shadow planes (right side + underside turn away from light) ── */}
      <path d="M20.6 5.2 L22 10.6 L19.2 11 L17.4 7.2 Z" fill="#b9c5de" />
      <path d="M22 10.6 L21.2 14.8 L19.4 18.2 L17 14.6 L19.2 11 Z" fill="#c2cde5" />
      <path d="M2 10.6 L4.8 11 L6.8 14.6 L4.6 18.2 L2.8 14.8 Z" fill="#cbd6eb" />
      {/* Ear tufts — folded back planes */}
      <path d="M5.2 1.2 L3.4 5.2 L9.3 3.4 Z" fill="#c3cfe8" />
      <path d="M18.8 1.2 L14.7 3.4 L20.6 5.2 Z" fill="#aebcdc" />
      {/* Under-beak chin plane */}
      <path d="M8.6 20.8 L12 21.8 L15.4 20.8 L12 16.8 Z" fill="#e4eaf6" />
      {/* ── Eyes: socket shadows, folded diamond pupils, glints ── */}
      <path d="M4.5 11.1 L7.2 9.1 L9.9 11.1 L7.2 13.1 Z" fill="#a9b7d6" opacity="0.6" />
      <path d="M14.1 11.1 L16.8 9.1 L19.5 11.1 L16.8 13.1 Z" fill="#a9b7d6" opacity="0.6" />
      <path d="M5.2 11.2 L7.2 9.7 L9.2 11.2 L7.2 12.7 Z" fill="#0a0c12" />
      <path d="M14.8 11.2 L16.8 9.7 L18.8 11.2 L16.8 12.7 Z" fill="#0a0c12" />
      <circle cx="8" cy="10.6" r="0.6" fill="#eef2f8" />
      <circle cx="17.6" cy="10.6" r="0.6" fill="#eef2f8" />
      {/* ── Beak: two-tone folded diamond (lit left, shadowed right) ── */}
      <path d="M12 12.6 L12 16.4 L9.9 13.9 Z" fill="#b455ec" />
      <path d="M12 12.6 L14.1 13.9 L12 16.4 Z" fill="#9840d9" />
      <path
        d="M12 12.6 L14.1 13.9 L12 16.4 L9.9 13.9 Z"
        stroke="#040406"
        strokeWidth="0.7"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

// 3D brand mark — two owl heads glued back-to-back inside a preserve-3d
// wrapper, so a spin reads as a solid sculpture instead of a flat decal.
// It spins on its VERTICAL axis only while a transaction is in flight
// (`spinning`): starts at send, stops when the tx settles.
function BrandMark({ spinning = false }) {
  return (
    <span
      aria-hidden="true"
      className={`brand-mark-3d inline-flex h-16 w-16 shrink-0 items-center justify-center${
        spinning ? " brand-spin" : ""
      }`}
    >
      <span className="brand-face">
        <OwlGlyph />
      </span>
      <span className="brand-face brand-back">
        <OwlGlyph />
      </span>
    </span>
  );
}

// Glassmorphic wallet button; keeps RainbowKit's connect modal + theming.
function GlassConnectButton({ balance }) {
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
                  {balance && (
                    <span
                      className="glass-chip font-mono"
                      aria-label={`${balance} on ${chain.name}`}
                    >
                      {balance}
                    </span>
                  )}
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

// --- Ledger rows. Click a row to expand an on-chain receipt: where the money
// went (sender -> escrow, escrow -> recipient/sender) with a link to each of
// the two money-moving transactions on the chain's block explorer. Everything
// is read straight from the chain through the wallet RPC, no explorer API. ---

const REFUND_REASONS = {
  "oracle-reported-failure": "Delivery was rejected on the destination chain",
  "timeout-elapsed": "Timeout passed without a confirmation",
};

function explorerUrl(chain, kind, value) {
  const base = chain.blockExplorers?.default?.url;
  return base ? `${base}/${kind}/${value}` : null;
}

function formatTime(seconds) {
  if (!seconds) return "—";
  return new Date(Number(seconds) * 1000).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatEth(wei, digits = 6) {
  if (wei === undefined || wei === null) return "—";
  const n = Number(formatEther(wei));
  return `${n === 0 ? "0" : n.toLocaleString("en-US", { maximumFractionDigits: digits })} ETH`;
}

// Finds the TransferConfirmed / TransferRefunded event for one transfer.
// Searches forward from the lock block in chunks, shrinking the chunk if the
// RPC rejects large ranges (public endpoints often cap eth_getLogs).
async function findResolution(client, address, transferId, fromBlock) {
  const [confirmedEvent, refundedEvent] = ["TransferConfirmed", "TransferRefunded"].map((name) =>
    escrowAbi.find((item) => item.type === "event" && item.name === name)
  );
  const latest = await client.getBlockNumber();
  let start = fromBlock;
  let step = 5000n;
  for (let calls = 0; start <= latest && calls < 80; calls++) {
    const end = start + step - 1n > latest ? latest : start + step - 1n;
    try {
      const [confirmed, refunded] = await Promise.all([
        client.getLogs({ address, event: confirmedEvent, args: { transferId }, fromBlock: start, toBlock: end }),
        client.getLogs({ address, event: refundedEvent, args: { transferId }, fromBlock: start, toBlock: end }),
      ]);
      const log = confirmed[0] || refunded[0];
      if (log) return log;
      start = end + 1n;
    } catch (err) {
      if (step <= 10n) throw err;
      step = step / 10n;
    }
  }
  return null;
}

function TxLink({ href, hash }) {
  if (!href) return <span className="font-mono text-inkTertiary">{short(hash)}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 font-mono text-signalInfo hover:underline whitespace-nowrap"
    >
      {short(hash)}
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
      </svg>
    </a>
  );
}

function FlowStep({ title, route, time, link, note, level, pulsing }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex items-start gap-3 min-w-0">
        <span className="mt-1.5"><Beacon level={level} pulsing={pulsing} size="sm" /></span>
        <div className="min-w-0">
          <div className="text-sm text-ink">{title}</div>
          <div className="mt-0.5 font-mono text-xs text-inkSecondary truncate">{route}</div>
          {note && <div className="mt-0.5 text-xs text-inkTertiary">{note}</div>}
        </div>
      </div>
      <div className="shrink-0 text-right text-xs">
        {link}
        <div className="mt-0.5 text-inkTertiary">{time}</div>
      </div>
    </div>
  );
}

function Detail({ label, value }) {
  return (
    <div className="min-w-0">
      <div className="label">{label}</div>
      <div className="mt-1 font-mono text-xs text-ink truncate">{value}</div>
    </div>
  );
}

function TransferDetails({ entry, chain, onchain, status }) {
  const address = escrowAddresses[chain.id];
  const client = usePublicClient({ chainId: chain.id });
  const [lock, setLock] = useState(null); // { blockNumber, fee }
  const [resolution, setResolution] = useState(null); // { hash, time, refunded, reason }
  const [error, setError] = useState("");

  // The deposit (lock) transaction: block and gas fee.
  useEffect(() => {
    let cancelled = false;
    if (!client || !entry.txHash) return;
    client
      .getTransactionReceipt({ hash: entry.txHash })
      .then((r) => {
        if (!cancelled) setLock({ blockNumber: r.blockNumber, fee: r.gasUsed * r.effectiveGasPrice });
      })
      .catch(() => !cancelled && setError("Couldn't load the deposit transaction from the network."));
    return () => {
      cancelled = true;
    };
  }, [client, entry.txHash]);

  // The payout (release or refund) transaction, once the transfer is resolved.
  useEffect(() => {
    let cancelled = false;
    if (!client || !address || !lock || status < 2 || resolution) return;
    (async () => {
      try {
        const log = await findResolution(client, address, BigInt(entry.transferId), lock.blockNumber);
        if (!log || cancelled) return;
        const block = await client.getBlock({ blockNumber: log.blockNumber });
        if (cancelled) return;
        setResolution({
          hash: log.transactionHash,
          time: block.timestamp,
          refunded: log.eventName === "TransferRefunded",
          reason: log.args?.reason,
        });
      } catch {
        if (!cancelled) setError("Couldn't find the payout transaction yet. Try again in a moment.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, address, lock, status, resolution, entry.transferId]);

  const sender = onchain?.sender;
  const recipient = onchain?.recipient || entry.recipient;
  const createdAt = onchain?.createdAt;
  const timeout = onchain?.timeoutSeconds;
  const refundableAt = createdAt && timeout ? createdAt + timeout : null;

  let payout;
  if (status === 2 || status === 3) {
    const refunded = status === 3;
    payout = (
      <FlowStep
        level={refunded ? "warn" : "good"}
        title={refunded ? "Refunded to sender" : "Released to recipient"}
        route={`Escrow → ${short(refunded ? sender : recipient)}`}
        note={refunded ? REFUND_REASONS[resolution?.reason] || resolution?.reason : null}
        time={resolution ? formatTime(resolution.time) : "Looking up…"}
        link={resolution ? <TxLink hash={resolution.hash} href={explorerUrl(chain, "tx", resolution.hash)} /> : null}
      />
    );
  } else {
    payout = (
      <FlowStep
        level="info"
        pulsing
        title="Waiting for the oracle"
        route={`Escrow → ${short(recipient)}`}
        note={refundableAt ? `If nothing happens, the sender can claim a refund after ${formatTime(refundableAt)}.` : null}
        time=""
        link={null}
      />
    );
  }

  return (
    <div className="mt-4 border-t border-glassHairline pt-4 space-y-4" onClick={(e) => e.stopPropagation()}>
      <div className="space-y-3">
        <FlowStep
          level="info"
          title="Deposited into escrow"
          route={`${short(sender) || "Sender"} → Escrow`}
          time={formatTime(createdAt)}
          link={entry.txHash ? <TxLink hash={entry.txHash} href={explorerUrl(chain, "tx", entry.txHash)} /> : null}
        />
        {payout}
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        <Detail label="Amount" value={onchain ? formatEth(onchain.amount) : `${entry.amount} ETH`} />
        <Detail label="Deposit gas fee" value={lock ? formatEth(lock.fee, 8) : "…"} />
        <Detail label="Deposit block" value={lock ? lock.blockNumber.toLocaleString() : "…"} />
        <Detail label="From" value={short(sender) || "…"} />
        <Detail label="To" value={short(recipient)} />
        <Detail label="Timeout" value={timeout ? `${Number(timeout) / 60} min` : "…"} />
      </div>

      {error && <p className="text-xs text-signalWarn">{error}</p>}
    </div>
  );
}

function TransferRow({ entry, chain }) {
  const address = escrowAddresses[chain.id];
  const [open, setOpen] = useState(false);
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
    <div className="glass-card px-5 py-4">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-4 text-left"
      >
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
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className={`h-4 w-4 text-inkTertiary transition-transform duration-300 ${open ? "rotate-180" : ""}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </div>
      </button>
      {open && <TransferDetails entry={entry} chain={chain} onchain={onchain} status={status} />}
    </div>
  );
}
// --- Direct (non-escrow) sends in the ledger: a plain wallet transfer with
// no lifecycle, so just pending -> sent/failed, plus a one-step receipt. ---
function DirectRow({ entry, chain }) {
  const [open, setOpen] = useState(false);
  const client = usePublicClient({ chainId: chain.id });
  const { data: receipt, isError } = useWaitForTransactionReceipt({ hash: entry.txHash, chainId: chain.id });
  const [sentAt, setSentAt] = useState(null);

  useEffect(() => {
    let cancelled = false;
    if (!open || !receipt || !client || sentAt) return;
    client
      .getBlock({ blockNumber: receipt.blockNumber })
      .then((b) => !cancelled && setSentAt(b.timestamp))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, receipt, client, sentAt]);

  const failed = isError || receipt?.status === "reverted";
  const statusLabel = !receipt && !isError ? "Sending" : failed ? "Failed" : "Sent";
  const level = failed ? "bad" : receipt ? "unknown" : "info";
  const from = receipt?.from || entry.from;

  return (
    <div className="glass-card px-5 py-4">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-4 text-left"
      >
        <div className="flex items-center gap-3.5 min-w-0">
          <Beacon level={level} pulsing={!receipt && !isError} />
          <div className="min-w-0">
            <div className="font-mono text-sm text-ink truncate">
              <span className="text-inkTertiary">→</span> {short(entry.recipient)}
            </div>
            <div className="mt-0.5 text-xs font-mono text-inkSecondary">
              {entry.amount} ETH · {chain.name}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="glass-chip !px-2.5 !py-1 text-[10px] font-mono uppercase tracking-widest text-inkTertiary">
            Direct
          </span>
          <span className="w-20 text-right font-display text-[11px] font-medium uppercase tracking-[0.14em] text-inkSecondary">
            {statusLabel}
          </span>
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className={`h-4 w-4 text-inkTertiary transition-transform duration-300 ${open ? "rotate-180" : ""}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </div>
      </button>

      {open && (
        <div className="mt-4 border-t border-glassHairline pt-4 space-y-4" onClick={(e) => e.stopPropagation()}>
          <FlowStep
            level={failed ? "bad" : "unknown"}
            pulsing={!receipt && !isError}
            title={failed ? "Direct send failed" : receipt ? "Sent directly" : "Waiting for the network"}
            route={`${short(from) || "Your wallet"} → ${short(entry.recipient)}`}
            note={
              failed
                ? "The transaction was rejected, so no funds moved."
                : "No escrow protection. This can't be refunded."
            }
            time={sentAt ? formatTime(sentAt) : ""}
            link={<TxLink hash={entry.txHash} href={explorerUrl(chain, "tx", entry.txHash)} />}
          />
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
            <Detail label="Amount" value={`${entry.amount} ETH`} />
            <Detail label="Gas fee" value={receipt ? formatEth(receipt.gasUsed * receipt.effectiveGasPrice, 8) : "…"} />
            <Detail label="Block" value={receipt ? receipt.blockNumber.toLocaleString() : "…"} />
            <Detail label="From" value={short(from) || "…"} />
            <Detail label="To" value={short(entry.recipient)} />
            <Detail label="Protection" value="None" />
          </div>
        </div>
      )}
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
  // True from the moment any send starts until it fully settles — this
  // drives the 3D logo spin (transaction start -> transaction end).
  const [txInFlight, setTxInFlight] = useState(false);

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
  const walletBalance = formatBalance(balanceData);
  const walkthroughChainName =
    CHAINS.find((c) => c.id === chainId)?.name || `Chain #${chainId}`;

  const { writeContractAsync, isPending: isLocking } = useWriteContract();
  const { sendTransactionAsync, isPending: isSendingDirect } = useSendTransaction();
  const publicClient = usePublicClient({ chainId: currentChain.id });

  useEffect(() => saveLedger(ledger), [ledger]);

  // Wake the oracle as soon as someone opens the app, so it's warm by the
  // time they lock a transfer (free instances take ~1 min to start).
  useEffect(() => wakeOracle(), []);

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
    setTxInFlight(true);
    try {
      const txHash = await sendTransactionAsync({ to: recipient, value: parseEther(amount) });
      setLedger((prev) => [
        ...prev,
        { kind: "direct", txHash, recipient, amount, chainId: currentChain.id, from: account },
      ]);
    } finally {
      setTxInFlight(false);
    }
  }

  async function handleSendViaEscrow() {
    setTxInFlight(true);
    try {
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
      wakeOracle(); // makes the oracle sweep for this lock right away

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
    } finally {
      setTxInFlight(false);
    }
  }

  return (
    <div className="relative min-h-screen text-ink font-body overflow-x-clip">
      <BackgroundOrbs />

      <div className="relative z-10 flex flex-col">
        <header className="mx-auto w-full max-w-6xl px-4 pt-6 sm:px-6">
          <div className="glass-toolbar flex items-center justify-between gap-4 px-5 py-4 sm:px-6">
            <div className="flex items-center gap-3.5 min-w-0">
              <BrandMark spinning={txInFlight} />
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
            <GlassConnectButton balance={walletBalance} />
          </div>
        </header>

        <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
          <div className="grid items-start gap-5 lg:grid-cols-5">
            {/* SEND PANEL */}
            <section className="glass-panel p-6 sm:p-7 space-y-5 lg:col-span-2">
              <div>
                <h2 className="eyebrow">Send</h2>
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
                  {(() => {
                    const escrowCount = ledger.filter((e) => e.kind !== "direct").length;
                    const plural = (n) => (n === 1 ? "transfer" : "transfers");
                    return escrowCount === ledger.length
                      ? `${escrowCount} escrow ${plural(escrowCount)}`
                      : `${ledger.length} ${plural(ledger.length)} · ${escrowCount} escrow`;
                  })()}
                </span>
              </div>

              {ledger.length === 0 ? (
                <div className="glass-empty">
                  <p className="text-xs text-inkTertiary text-center">
                    Your transfers will appear here, live.
                  </p>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {ledger
                    .slice()
                    .reverse()
                    .map((entry) => {
                      const chain = CHAINS.find((c) => c.id === entry.chainId) || currentChain;
                      return entry.kind === "direct" ? (
                        <DirectRow key={entry.txHash} entry={entry} chain={chain} />
                      ) : (
                        <TransferRow key={`escrow-${entry.transferId}`} entry={entry} chain={chain} />
                      );
                    })}
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
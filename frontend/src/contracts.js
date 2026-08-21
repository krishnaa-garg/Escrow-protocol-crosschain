export const escrowAbi = [
  {
    type: "function",
    name: "lock",
    stateMutability: "payable",
    inputs: [
      { name: "destinationChainId", type: "uint256" },
      { name: "recipient", type: "address" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "timeoutSeconds", type: "uint256" },
    ],
    outputs: [{ name: "transferId", type: "uint256" }],
  },
  {
    type: "function",
    name: "getTransfer",
    stateMutability: "view",
    inputs: [{ name: "transferId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "sender", type: "address" },
          { name: "recipient", type: "address" },
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "destinationChainId", type: "uint256" },
          { name: "createdAt", type: "uint256" },
          { name: "timeoutSeconds", type: "uint256" },
          { name: "status", type: "uint8" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "refundOnTimeout",
    stateMutability: "nonpayable",
    inputs: [{ name: "transferId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "event",
    name: "TransferLocked",
    inputs: [
      { name: "transferId", type: "uint256", indexed: true },
      { name: "sender", type: "address", indexed: true },
      { name: "recipient", type: "address", indexed: true },
      { name: "token", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
      { name: "destinationChainId", type: "uint256", indexed: false },
      { name: "timeoutSeconds", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "TransferConfirmed",
    inputs: [
      { name: "transferId", type: "uint256", indexed: true },
      { name: "recipient", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "TransferRefunded",
    inputs: [
      { name: "transferId", type: "uint256", indexed: true },
      { name: "sender", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "reason", type: "string", indexed: false },
    ],
  },
];

// Fill these in after running the Hardhat deploy script on each testnet.
export const escrowAddresses = {
  11155111: import.meta.env.VITE_ESCROW_SEPOLIA || "",
  84532: import.meta.env.VITE_ESCROW_BASE_SEPOLIA || "",
  80002: import.meta.env.VITE_ESCROW_POLYGON_AMOY || "",
};

// Maps wagmi chain ids to the key the preflight service expects
export const preflightChainKey = {
  11155111: "sepolia",
  84532: "baseSepolia",
  80002: "polygonAmoy",
};

export const STATUS_LABELS = ["None", "Locked", "Confirmed", "Refunded"];

import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { sepolia, baseSepolia, polygonAmoy } from "wagmi/chains";

// Get a free WalletConnect Cloud project id at https://cloud.walletconnect.com
// and put it in frontend/.env as VITE_WALLETCONNECT_PROJECT_ID
const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || "REPLACE_ME";

export const config = getDefaultConfig({
  appName: "Crypter",
  projectId,
  chains: [sepolia, baseSepolia, polygonAmoy],
  ssr: false,
});

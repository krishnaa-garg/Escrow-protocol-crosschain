import React from "react";
import ReactDOM from "react-dom/client";
import "@rainbow-me/rainbowkit/styles.css";
import { WagmiProvider } from "wagmi";
import { RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { config } from "./wagmi.js";
import App from "./App.jsx";
import "./index.css";

const queryClient = new QueryClient();

const beaconTheme = darkTheme({
  // Mirrors the accent-blue token (:root --st-accent-blue). Kept as a literal
  // hex here because RainbowKit needs a concrete color string for its contrast
  // math — it can't resolve CSS custom properties.
  accentColor: "#5AC8FA",
  accentColorForeground: "#040406",
  borderRadius: "medium",
  fontStack: "system",
});

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={beaconTheme}>
          <App />
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>
);

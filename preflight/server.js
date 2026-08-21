import "dotenv/config";
import express from "express";
import cors from "cors";
import { checkAddress, CHAINS } from "./heuristic.js";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PREFLIGHT_PORT || 4001;

app.get("/health", (_req, res) => res.json({ ok: true, chains: Object.keys(CHAINS) }));

// GET /check?address=0x...&chain=baseSepolia
app.get("/check", async (req, res) => {
  const { address, chain } = req.query;

  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return res.status(400).json({ error: "Provide a valid `address` query param (0x-prefixed, 40 hex chars)." });
  }
  if (!chain || !CHAINS[chain]) {
    return res.status(400).json({ error: `Provide a valid \`chain\` query param: one of ${Object.keys(CHAINS).join(", ")}` });
  }

  try {
    const result = await checkAddress(address, chain);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Pre-flight check failed", detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Pre-flight heuristic service listening on http://localhost:${PORT}`);
});



import express from "express";
import { autyonPaywall } from "./paywall.js";

const app = express();

app.get(
  "/premium",
  autyonPaywall({ agentId: process.env.AGENT_ID || 1, priceAUT: process.env.PRICE_AUT || "0.1" }),
  (req, res) => {
    res.json({
      result: "Here is the premium answer only paying callers get.",
      paidWith: req.autyonPayment,
    });
  }
);

const PORT = process.env.PORT || 8402;
app.listen(PORT, () => console.log(`x402 demo → http://localhost:${PORT}/premium`));

import express from "express";
import cors from "cors";
import { reviewRouter } from "./routes/review.js";
import { classifierRouter } from "./routes/classifier.js";
import { auditRouter } from "./routes/audit.js";
import { healthRouter } from "./routes/health.js";
import { verdictSummaryRouter } from "./routes/verdicts.js";

const app = express();
const PORT = parseInt(process.env.DASHBOARD_PORT ?? "3001", 10);

app.use(cors());
app.use(express.json());

app.use("/api", reviewRouter);
app.use("/api", classifierRouter);
app.use("/api", auditRouter);
app.use("/api", healthRouter);
app.use("/api", verdictSummaryRouter);

app.listen(PORT, () => {
  console.log(`Dashboard API listening on http://localhost:${PORT}`);
});

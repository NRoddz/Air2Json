const path = require("path");
const express = require("express");
const dotenv = require("dotenv");
const { JobManager } = require("./jobManager");

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3000);
const projectRoot = path.join(__dirname, "..");

const manager = new JobManager({ projectRoot, env: process.env });

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(projectRoot, "public")));

function handleError(res, error, fallback = "Request failed.") {
  res.status(400).json({
    ok: false,
    error: error?.message || fallback,
  });
}

app.get("/health", (_, res) => {
  res.json({ ok: true });
});

app.get("/api/dashboard", async (_, res) => {
  try {
    const data = await manager.dashboard();
    res.json({ ok: true, ...data });
  } catch (error) {
    handleError(res, error, "Could not load dashboard.");
  }
});

app.get("/api/jobs", (_, res) => {
  res.json({ ok: true, jobs: manager.listJobs() });
});

app.get("/api/settings", (_, res) => {
  res.json({ ok: true, settings: manager.getSettings() });
});

app.put("/api/settings", async (req, res) => {
  try {
    const settings = await manager.updateSettings(req.body || {});
    res.json({ ok: true, settings });
  } catch (error) {
    handleError(res, error, "Could not update settings.");
  }
});

app.post("/api/jobs", async (req, res) => {
  try {
    const job = await manager.addJob(req.body || {});
    res.json({ ok: true, job });
  } catch (error) {
    handleError(res, error, "Could not create job.");
  }
});

app.put("/api/jobs/:jobId", async (req, res) => {
  try {
    const job = await manager.updateJob(req.params.jobId, req.body || {});
    res.json({ ok: true, job });
  } catch (error) {
    handleError(res, error, "Could not update job.");
  }
});

app.delete("/api/jobs/:jobId", async (req, res) => {
  try {
    await manager.deleteJob(req.params.jobId);
    res.json({ ok: true });
  } catch (error) {
    handleError(res, error, "Could not delete job.");
  }
});

app.post("/api/jobs/:jobId/preview", async (req, res) => {
  try {
    const preview = await manager.previewJob(req.params.jobId);
    res.json({ ok: true, ...preview });
  } catch (error) {
    handleError(res, error, "Preview failed.");
  }
});

app.post("/api/jobs/:jobId/run", async (req, res) => {
  try {
    const run = await manager.runJob(req.params.jobId, "manual");
    res.json({ ok: true, run });
  } catch (error) {
    handleError(res, error, "Run failed.");
  }
});

app.post("/api/jobs/run-all", async (_, res) => {
  try {
    const results = await manager.runAllEnabled("manual_batch");
    res.json({ ok: true, results });
  } catch (error) {
    handleError(res, error, "Batch run failed.");
  }
});

app.get("/api/jobs/:jobId/history", async (req, res) => {
  try {
    const history = manager.getJobHistory(req.params.jobId, 50);
    const snapshots = await manager.listSnapshots(req.params.jobId, 20);
    res.json({ ok: true, history, snapshots });
  } catch (error) {
    handleError(res, error, "Could not load job history.");
  }
});

app.post("/api/jobs/:jobId/rollback", async (req, res) => {
  try {
    const snapshot = String(req.body?.snapshot || "");
    const run = await manager.rollbackToSnapshot(req.params.jobId, snapshot);
    res.json({ ok: true, run });
  } catch (error) {
    handleError(res, error, "Rollback failed.");
  }
});

(async () => {
  try {
    await manager.init();
    app.listen(port, () => {
      console.log(`Server listening at http://localhost:${port}`);
    });
  } catch (error) {
    console.error(`Startup failed: ${error.message}`);
    process.exit(1);
  }
})();

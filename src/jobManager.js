const fs = require("fs/promises");
const path = require("path");
const cron = require("node-cron");
const { extractRowsFromAirtableHtml } = require("./airtableExtractor");
const {
  exportJobToJson,
  readJsonIfExists,
  writeFileAtomic,
  slugify,
} = require("./exporter");

function toPositiveInt(value, fallback, min = 1, max = 10000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.floor(parsed);
  return Math.min(max, Math.max(min, rounded));
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function buildDefaultSettingsFromEnv(env) {
  return {
    defaultCron: String(env.EXPORT_SCHEDULE_CRON || "0 17 * * *").trim(),
    defaultTimezone: String(env.EXPORT_SCHEDULE_TZ || "Europe/Madrid").trim(),
    maxSnapshotsPerJob: toPositiveInt(env.MAX_SNAPSHOTS_PER_JOB, 30),
    maxHistoryPerJob: toPositiveInt(env.MAX_HISTORY_PER_JOB, 80),
    autoRunOnStartup: toBoolean(env.AUTO_RUN_ON_STARTUP, false),
  };
}

function sanitizeSettings(input, defaults) {
  const next = {
    defaultCron: String(input?.defaultCron || defaults.defaultCron).trim(),
    defaultTimezone: String(input?.defaultTimezone || defaults.defaultTimezone).trim(),
    maxSnapshotsPerJob: toPositiveInt(
      input?.maxSnapshotsPerJob,
      defaults.maxSnapshotsPerJob
    ),
    maxHistoryPerJob: toPositiveInt(input?.maxHistoryPerJob, defaults.maxHistoryPerJob),
    autoRunOnStartup: toBoolean(
      input?.autoRunOnStartup,
      defaults.autoRunOnStartup
    ),
  };

  if (!cron.validate(next.defaultCron)) {
    throw new Error("Invalid default cron expression.");
  }

  return next;
}

function createDefaultJobFromEnv(projectRoot, env, settings) {
  const airtableUrl = env.AIRTABLE_PUBLIC_URL || "";
  const outputPath =
    env.OUTPUT_JSON_PATH ||
    path.join(projectRoot, "data", "jobs", "default", "current.json");

  return {
    id: "default",
    name: "Default Job",
    airtableUrl,
    outputPath,
    enabled: Boolean(airtableUrl),
    schedule: {
      enabled: toBoolean(env.EXPORT_SCHEDULE_ENABLED, false),
      cron: settings.defaultCron,
      timezone: settings.defaultTimezone,
    },
  };
}

function sanitizeJob(input, options = {}) {
  const fallbackId = options.fallbackId || null;
  const defaults = options.defaults;

  const idRaw = String(input.id || fallbackId || slugify(input.name || "job") || "job");
  const id = idRaw.replace(/[^a-zA-Z0-9-_]/g, "-").toLowerCase();

  const schedule = input.schedule || {};
  const cronValue = String(schedule.cron || defaults.defaultCron).trim();
  const timezone = String(schedule.timezone || defaults.defaultTimezone).trim();

  return {
    id,
    name: String(input.name || id).trim(),
    airtableUrl: String(input.airtableUrl || "").trim(),
    outputPath: String(input.outputPath || "").trim(),
    enabled: toBoolean(input.enabled, true),
    schedule: {
      enabled: toBoolean(schedule.enabled, false),
      cron: cronValue,
      timezone,
    },
  };
}

function compactRun(run) {
  return {
    runId: run.runId,
    status: run.status,
    trigger: run.trigger,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs,
    rows: run.rows,
    columns: run.columns,
    bytes: run.bytes,
    outputPath: run.outputPath,
    snapshotName: run.snapshotName,
    diff: run.diff,
    error: run.error,
  };
}

class JobManager {
  constructor({ projectRoot, env }) {
    this.projectRoot = projectRoot;
    this.env = env;

    this.configPath = path.resolve(
      env.JOBS_CONFIG_PATH || path.join(projectRoot, "config", "jobs.json")
    );
    this.statePath = path.resolve(
      env.JOBS_STATE_PATH || path.join(projectRoot, "data", "state", "runs.json")
    );
    this.snapshotRoot = path.resolve(
      env.SNAPSHOT_ROOT || path.join(projectRoot, "data", "snapshots")
    );

    this.defaultSettings = buildDefaultSettingsFromEnv(env);

    this.config = {
      schemaVersion: 2,
      settings: { ...this.defaultSettings },
      jobs: [],
    };
    this.state = { runsByJob: {} };

    this.runningByJob = new Map();
    this.schedulersByJob = new Map();
  }

  get settings() {
    return this.config.settings;
  }

  async init({ enableSchedulers = true } = {}) {
    await fs.mkdir(path.dirname(this.configPath), { recursive: true });
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    await fs.mkdir(this.snapshotRoot, { recursive: true });

    this.config = await this.loadOrCreateConfig();
    this.state = await this.loadOrCreateState();

    if (enableSchedulers) {
      this.refreshSchedulers();
      if (this.settings.autoRunOnStartup) {
        this.runAllEnabled("startup").catch((error) => {
          console.error(`[startup] batch run failed: ${error.message}`);
        });
      }
    }
  }

  async loadOrCreateConfig() {
    try {
      const raw = await fs.readFile(this.configPath, "utf8");
      const parsed = JSON.parse(raw);

      const settings = sanitizeSettings(parsed.settings || {}, this.defaultSettings);
      const jobs = Array.isArray(parsed.jobs)
        ? parsed.jobs.map((job) => sanitizeJob(job, { fallbackId: job.id, defaults: settings }))
        : [];

      if (!jobs.length && this.env.AIRTABLE_PUBLIC_URL) {
        jobs.push(createDefaultJobFromEnv(this.projectRoot, this.env, settings));
      }

      const next = { schemaVersion: 2, settings, jobs };
      await writeFileAtomic(this.configPath, `${JSON.stringify(next, null, 2)}\n`);
      return next;
    } catch {
      const settings = { ...this.defaultSettings };
      const jobs = this.env.AIRTABLE_PUBLIC_URL
        ? [createDefaultJobFromEnv(this.projectRoot, this.env, settings)]
        : [];

      const next = { schemaVersion: 2, settings, jobs };
      await writeFileAtomic(this.configPath, `${JSON.stringify(next, null, 2)}\n`);
      return next;
    }
  }

  async loadOrCreateState() {
    try {
      const raw = await fs.readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") {
        throw new Error("Invalid state file");
      }
      return {
        runsByJob: parsed.runsByJob || {},
      };
    } catch {
      const initial = { runsByJob: {} };
      await writeFileAtomic(this.statePath, `${JSON.stringify(initial, null, 2)}\n`);
      return initial;
    }
  }

  async persistConfig() {
    await writeFileAtomic(this.configPath, `${JSON.stringify(this.config, null, 2)}\n`);
  }

  async persistState() {
    await writeFileAtomic(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  getSettings() {
    return { ...this.settings };
  }

  async updateSettings(input) {
    const next = sanitizeSettings(input, this.defaultSettings);

    this.config.settings = next;

    for (const jobId of Object.keys(this.state.runsByJob)) {
      this.state.runsByJob[jobId] = (this.state.runsByJob[jobId] || []).slice(
        0,
        next.maxHistoryPerJob
      );
    }

    await this.persistConfig();
    await this.persistState();
    return this.getSettings();
  }

  getJobById(jobId) {
    return this.config.jobs.find((job) => job.id === jobId);
  }

  listJobs() {
    return this.config.jobs.map((job) => {
      const runs = this.state.runsByJob[job.id] || [];
      return {
        ...job,
        running: this.runningByJob.get(job.id) === true,
        schedulerActive: this.schedulersByJob.has(job.id),
        lastRun: runs[0] || null,
      };
    });
  }

  async listSnapshots(jobId, limit = 12) {
    const snapshotDir = path.resolve(this.snapshotRoot, jobId);
    try {
      const entries = await fs.readdir(snapshotDir);
      return entries
        .filter((entry) => entry.endsWith(".json"))
        .sort()
        .reverse()
        .slice(0, limit)
        .map((name) => ({
          name,
          path: path.join(snapshotDir, name),
        }));
    } catch {
      return [];
    }
  }

  getJobHistory(jobId, limit = 30) {
    const runs = this.state.runsByJob[jobId] || [];
    return runs.slice(0, limit);
  }

  async previewJob(jobId) {
    const job = this.getJobById(jobId);
    if (!job) throw new Error("Job not found.");
    if (!job.airtableUrl) throw new Error("Job is missing Airtable URL.");

    const { headers, rows } = await extractRowsFromAirtableHtml(job.airtableUrl);
    const sampleRecords = rows.slice(0, 4).map((row) => {
      const record = {};
      headers.forEach((header, index) => {
        record[header] = row[index] ?? "";
      });
      return record;
    });

    return {
      columns: headers.length,
      rows: rows.length,
      headers,
      sampleRecords,
    };
  }

  async addJob(input) {
    const job = sanitizeJob(input, { defaults: this.settings });
    if (!job.name) throw new Error("Job name is required.");
    if (!job.airtableUrl) throw new Error("Airtable URL is required.");
    if (!job.outputPath) throw new Error("Output path is required.");
    if (this.getJobById(job.id)) {
      throw new Error(`Job with id '${job.id}' already exists.`);
    }
    if (job.schedule.enabled && !cron.validate(job.schedule.cron)) {
      throw new Error("Invalid cron expression.");
    }

    this.config.jobs.push(job);
    await this.persistConfig();
    this.refreshSchedulers();
    return job;
  }

  async updateJob(jobId, input) {
    const existing = this.getJobById(jobId);
    if (!existing) throw new Error("Job not found.");

    const merged = sanitizeJob(
      { ...existing, ...input, id: jobId },
      { fallbackId: jobId, defaults: this.settings }
    );

    if (merged.schedule.enabled && !cron.validate(merged.schedule.cron)) {
      throw new Error("Invalid cron expression.");
    }

    this.config.jobs = this.config.jobs.map((job) => (job.id === jobId ? merged : job));
    await this.persistConfig();
    this.refreshSchedulers();
    return merged;
  }

  async deleteJob(jobId) {
    if (!this.getJobById(jobId)) throw new Error("Job not found.");
    this.config.jobs = this.config.jobs.filter((job) => job.id !== jobId);
    delete this.state.runsByJob[jobId];
    await this.persistConfig();
    await this.persistState();

    const scheduler = this.schedulersByJob.get(jobId);
    if (scheduler) {
      scheduler.task.stop();
      this.schedulersByJob.delete(jobId);
    }
  }

  refreshSchedulers() {
    for (const [jobId, scheduler] of this.schedulersByJob.entries()) {
      const job = this.getJobById(jobId);
      const shouldStop =
        !job ||
        !job.enabled ||
        !job.schedule.enabled ||
        !cron.validate(job.schedule.cron) ||
        scheduler.cron !== job.schedule.cron ||
        scheduler.timezone !== job.schedule.timezone;

      if (shouldStop) {
        scheduler.task.stop();
        this.schedulersByJob.delete(jobId);
      }
    }

    for (const job of this.config.jobs) {
      if (!job.enabled || !job.schedule.enabled) continue;
      if (!cron.validate(job.schedule.cron)) continue;
      if (this.schedulersByJob.has(job.id)) continue;

      const task = cron.schedule(
        job.schedule.cron,
        async () => {
          try {
            await this.runJob(job.id, "schedule");
            console.log(`[scheduler:${job.id}] run complete`);
          } catch (error) {
            console.error(`[scheduler:${job.id}] run failed: ${error.message}`);
          }
        },
        { timezone: job.schedule.timezone }
      );

      this.schedulersByJob.set(job.id, {
        task,
        cron: job.schedule.cron,
        timezone: job.schedule.timezone,
      });
    }
  }

  async appendRun(jobId, runRecord) {
    const maxHistory = this.settings.maxHistoryPerJob;
    const existing = this.state.runsByJob[jobId] || [];
    const next = [runRecord, ...existing].slice(0, maxHistory);
    this.state.runsByJob[jobId] = next;
    await this.persistState();
  }

  async runJob(jobId, trigger = "manual") {
    const job = this.getJobById(jobId);
    if (!job) throw new Error("Job not found.");
    if (!job.airtableUrl) throw new Error("Job Airtable URL is missing.");
    if (!job.outputPath) throw new Error("Job output path is missing.");

    if (this.runningByJob.get(jobId)) {
      throw new Error("This job is already running.");
    }

    this.runningByJob.set(jobId, true);
    const runId = `${jobId}-${Date.now()}`;
    const started = Date.now();
    const startedAt = new Date(started).toISOString();

    try {
      const result = await exportJobToJson({
        job,
        snapshotRoot: this.snapshotRoot,
        maxSnapshots: this.settings.maxSnapshotsPerJob,
      });

      const finishedAt = new Date().toISOString();
      const runRecord = compactRun({
        runId,
        status: "success",
        trigger,
        startedAt,
        finishedAt,
        durationMs: Date.now() - started,
        rows: result.rows,
        columns: result.columns,
        bytes: result.bytes,
        outputPath: result.outputPath,
        snapshotName: result.snapshotName,
        diff: result.diff,
      });
      await this.appendRun(jobId, runRecord);
      return runRecord;
    } catch (error) {
      const finishedAt = new Date().toISOString();
      const runRecord = compactRun({
        runId,
        status: "error",
        trigger,
        startedAt,
        finishedAt,
        durationMs: Date.now() - started,
        rows: 0,
        columns: 0,
        bytes: 0,
        outputPath: job.outputPath,
        snapshotName: null,
        diff: null,
        error: error.message || "Run failed.",
      });
      await this.appendRun(jobId, runRecord);
      throw error;
    } finally {
      this.runningByJob.set(jobId, false);
    }
  }

  async runAllEnabled(trigger = "manual_batch") {
    const enabledJobs = this.config.jobs.filter((job) => job.enabled);
    const results = [];
    for (const job of enabledJobs) {
      try {
        const run = await this.runJob(job.id, trigger);
        results.push({ jobId: job.id, ok: true, run });
      } catch (error) {
        results.push({ jobId: job.id, ok: false, error: error.message });
      }
    }
    return results;
  }

  async rollbackToSnapshot(jobId, snapshotName) {
    const job = this.getJobById(jobId);
    if (!job) throw new Error("Job not found.");

    const safeName = path.basename(snapshotName || "");
    if (!safeName.endsWith(".json")) {
      throw new Error("Invalid snapshot file.");
    }

    const snapshotPath = path.resolve(this.snapshotRoot, jobId, safeName);
    const payload = await readJsonIfExists(snapshotPath);
    if (!payload) {
      throw new Error("Snapshot not found.");
    }

    const pretty = `${JSON.stringify(payload, null, 2)}\n`;
    await writeFileAtomic(job.outputPath, pretty);

    const runRecord = compactRun({
      runId: `${jobId}-rollback-${Date.now()}`,
      status: "success",
      trigger: "rollback",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 0,
      rows: payload?.meta?.counts?.records || payload?.records?.length || 0,
      columns: payload?.meta?.counts?.columns || 0,
      bytes: Buffer.byteLength(pretty, "utf8"),
      outputPath: path.resolve(job.outputPath),
      snapshotName: safeName,
      diff: null,
    });

    await this.appendRun(jobId, runRecord);
    return runRecord;
  }

  async dashboard(limitPerJob = 10) {
    const jobs = this.listJobs();
    const withDetails = [];

    for (const job of jobs) {
      const history = this.getJobHistory(job.id, limitPerJob);
      const snapshots = await this.listSnapshots(job.id, 8);
      withDetails.push({
        ...job,
        history,
        snapshots,
      });
    }

    const runs = withDetails.flatMap((job) => job.history);
    const succeeded = runs.filter((run) => run.status === "success").length;
    const failed = runs.filter((run) => run.status === "error").length;

    return {
      generatedAt: new Date().toISOString(),
      settings: this.getSettings(),
      totals: {
        jobs: jobs.length,
        activeSchedulers: jobs.filter((job) => job.schedulerActive).length,
        runningNow: jobs.filter((job) => job.running).length,
        recentSuccessRuns: succeeded,
        recentFailedRuns: failed,
      },
      jobs: withDetails,
      paths: {
        configPath: this.configPath,
        statePath: this.statePath,
        snapshotRoot: this.snapshotRoot,
      },
    };
  }
}

module.exports = { JobManager };

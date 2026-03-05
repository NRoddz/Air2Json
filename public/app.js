const consoleEl = document.getElementById("console");
const statsGrid = document.getElementById("statsGrid");
const jobsList = document.getElementById("jobsList");
const runAllBtn = document.getElementById("runAllBtn");
const refreshBtn = document.getElementById("refreshBtn");
const jobForm = document.getElementById("jobForm");
const jobNameInput = document.getElementById("jobName");
const jobOutputInput = document.getElementById("jobOutput");
const jobIdPreviewInput = document.getElementById("jobIdPreview");
const jobFilterInput = document.getElementById("jobFilter");
const settingsForm = document.getElementById("settingsForm");
const editDialog = document.getElementById("editDialog");
const editJobForm = document.getElementById("editJobForm");
const closeEditBtn = document.getElementById("closeEditBtn");

let dashboard = null;
let jobFilter = "";
let lastAutoOutputPath = "";
let lastKnownDefaultCron = "";
let lastKnownDefaultTimezone = "";

function setConsole(payload) {
  const stamp = new Date().toISOString();
  const nextContent =
    typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  consoleEl.textContent =
    `[${stamp}]\n${nextContent}`;
}

async function api(path, method = "GET", body = null) {
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.error || "Request failed.");
  }
  return data;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function defaultOutputPathForId(jobId) {
  return `data/jobs/${jobId || "job"}/current.json`;
}

function updateCreateFormDerivedFields({ forceOutputPath = false } = {}) {
  const suggestedId = slugify(jobNameInput.value.trim()) || "job";
  jobIdPreviewInput.value = suggestedId;

  const suggestedPath = defaultOutputPathForId(suggestedId);
  const outputIsAuto =
    !jobOutputInput.value.trim() || jobOutputInput.value.trim() === lastAutoOutputPath;

  if (forceOutputPath || outputIsAuto) {
    jobOutputInput.value = suggestedPath;
    lastAutoOutputPath = suggestedPath;
  }
}

function formatDiff(diff) {
  if (!diff) return "-";
  return `+${diff.added} ~${diff.updated} -${diff.removed}`;
}

function formatRunTime(iso) {
  if (!iso) return "-";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function setSettingInputs(settings) {
  const defaultCron = settings.defaultCron || "0 17 * * *";
  const defaultTimezone = settings.defaultTimezone || "Europe/Madrid";

  document.getElementById("settingsDefaultCron").value = settings.defaultCron || "0 17 * * *";
  document.getElementById("settingsDefaultTimezone").value =
    settings.defaultTimezone || "Europe/Madrid";
  document.getElementById("settingsMaxSnapshots").value =
    settings.maxSnapshotsPerJob || 30;
  document.getElementById("settingsMaxHistory").value =
    settings.maxHistoryPerJob || 80;
  document.getElementById("settingsAutoRun").checked = Boolean(
    settings.autoRunOnStartup
  );

  const jobCronEl = document.getElementById("jobCron");
  const jobTzEl = document.getElementById("jobTz");

  if (!jobCronEl.value || jobCronEl.value === lastKnownDefaultCron) {
    jobCronEl.value = defaultCron;
  }
  if (!jobTzEl.value || jobTzEl.value === lastKnownDefaultTimezone) {
    jobTzEl.value = defaultTimezone;
  }

  lastKnownDefaultCron = defaultCron;
  lastKnownDefaultTimezone = defaultTimezone;
  updateCreateFormDerivedFields();
}

function renderStats(data) {
  const totals = data?.totals || {};
  const items = [
    ["Jobs", totals.jobs || 0],
    ["Schedulers", totals.activeSchedulers || 0],
    ["Running now", totals.runningNow || 0],
    ["Recent success", totals.recentSuccessRuns || 0],
    ["Recent failed", totals.recentFailedRuns || 0],
  ];

  statsGrid.innerHTML = items
    .map(
      ([label, value]) =>
        `<article class="stat"><div class="label">${label}</div><div class="value">${escapeHtml(
          value
        )}</div></article>`
    )
    .join("");
}

function renderJobs(data) {
  const jobs = (data.jobs || []).filter((job) => {
    if (!jobFilter) return true;
    const haystack = `${job.name} ${job.id} ${job.outputPath}`.toLowerCase();
    return haystack.includes(jobFilter);
  });

  if (!jobs.length) {
    jobsList.innerHTML =
      "<p>No matching jobs. Adjust filter or create your first job on the left panel.</p>";
    return;
  }

  jobsList.innerHTML = jobs
    .map((job) => {
      const last = job.lastRun;
      const statusClass = !last
        ? ""
        : last.status === "success"
        ? "ok"
        : "err";
      const statusLabel = !last
        ? "No runs yet"
        : `${last.status.toUpperCase()} (${last.trigger})`;
      const recentRuns = (job.history || []).slice(0, 3);

      const snapshots = (job.snapshots || []).map((item) => item.name);
      const snapshotOptions = snapshots.length
        ? snapshots
            .map(
              (name) =>
                `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`
            )
            .join("")
        : `<option value="">No snapshots</option>`;

      return `
        <article class="job-card" data-job-id="${escapeHtml(job.id)}">
          <div class="job-head">
            <div>
              <h3 class="job-title">${escapeHtml(job.name)}</h3>
              <div class="chips">
                <span class="chip ${statusClass}">${escapeHtml(statusLabel)}</span>
                <span class="chip">Job ID: ${escapeHtml(job.id)}</span>
                <span class="chip">${job.enabled ? "Enabled" : "Disabled"}</span>
                <span class="chip">${job.schedule?.enabled ? "Scheduled" : "No schedule"}</span>
                <span class="chip">${job.running ? "Running now" : "Idle"}</span>
              </div>
            </div>
            <div class="chips">
              <button class="btn small ghost" data-action="edit">Edit</button>
              <button class="btn small ghost" data-action="toggle-enabled">Toggle</button>
              <button class="btn small danger" data-action="delete">Delete</button>
            </div>
          </div>

          <div class="job-meta">
            <div><span class="kv">Airtable:</span> ${escapeHtml(job.airtableUrl || "-")}</div>
            <div><span class="kv">Output:</span> ${escapeHtml(job.outputPath || "-")}</div>
            <div><span class="kv">Cron:</span> ${escapeHtml(job.schedule?.cron || "-")}</div>
            <div><span class="kv">Timezone:</span> ${escapeHtml(job.schedule?.timezone || "-")}</div>
            <div><span class="kv">Last rows:</span> ${escapeHtml(last?.rows ?? "-")}</div>
            <div><span class="kv">Last diff:</span> ${escapeHtml(formatDiff(last?.diff))}</div>
          </div>

          <div class="job-actions">
            <button class="btn small" data-action="run">Run now</button>
            <button class="btn small ghost" data-action="preview">Preview</button>
            <select data-role="snapshotSelect">${snapshotOptions}</select>
            <button class="btn small ghost" data-action="rollback">Rollback snapshot</button>
          </div>

          <div class="run-list">
            ${
              recentRuns.length
                ? recentRuns
                    .map(
                      (run) => `
                        <div class="run-item">
                          <span class="run-status ${run.status === "success" ? "ok" : "err"}">${escapeHtml(run.status)}</span>
                          <span>${escapeHtml(formatRunTime(run.finishedAt))}</span>
                          <span>${escapeHtml(`${run.rows || 0} rows`)}</span>
                          <span>${escapeHtml(formatDiff(run.diff))}</span>
                        </div>
                      `
                    )
                    .join("")
                : `<div class="run-empty">No run history yet.</div>`
            }
          </div>
        </article>
      `;
    })
    .join("");
}

function openEditDialog(job) {
  document.getElementById("editJobId").value = job.id;
  document.getElementById("editJobName").value = job.name || "";
  document.getElementById("editJobUrl").value = job.airtableUrl || "";
  document.getElementById("editJobOutput").value = job.outputPath || "";
  document.getElementById("editJobEnabled").checked = Boolean(job.enabled);
  document.getElementById("editJobScheduleEnabled").checked = Boolean(job.schedule?.enabled);
  document.getElementById("editJobCron").value = job.schedule?.cron || "";
  document.getElementById("editJobTz").value = job.schedule?.timezone || "";

  if (typeof editDialog.showModal === "function") {
    editDialog.showModal();
  }
}

function closeEditDialog() {
  if (typeof editDialog.close === "function") {
    editDialog.close();
  }
}

async function loadDashboard() {
  const data = await api("/api/dashboard");
  dashboard = data;
  renderStats(data);
  renderJobs(data);
  setSettingInputs(data.settings || {});
  if (!consoleEl.textContent || consoleEl.textContent === "Loading dashboard...") {
    setConsole({
      dashboardGeneratedAt: data.generatedAt,
      paths: data.paths,
      settings: data.settings,
    });
  }
}

async function handleRunAll() {
  setConsole("Running all enabled jobs...");
  const data = await api("/api/jobs/run-all", "POST");
  setConsole(data);
  await loadDashboard();
}

async function handleJobAction(button) {
  const action = button.getAttribute("data-action");
  const card = button.closest("[data-job-id]");
  const jobId = card?.getAttribute("data-job-id");
  if (!action || !jobId) return;

  const job = (dashboard?.jobs || []).find((item) => item.id === jobId);

  if (action === "edit") {
    if (job) openEditDialog(job);
    return;
  }

  if (action === "run") {
    setConsole(`Running job '${jobId}'...`);
    const data = await api(`/api/jobs/${jobId}/run`, "POST");
    setConsole(data);
    await loadDashboard();
    return;
  }

  if (action === "preview") {
    setConsole(`Previewing job '${jobId}'...`);
    const data = await api(`/api/jobs/${jobId}/preview`, "POST");
    setConsole(data);
    return;
  }

  if (action === "rollback") {
    const select = card.querySelector('[data-role="snapshotSelect"]');
    const snapshot = select?.value;
    if (!snapshot) {
      setConsole("No snapshot selected.");
      return;
    }
    setConsole(`Rolling back '${jobId}' to '${snapshot}'...`);
    const data = await api(`/api/jobs/${jobId}/rollback`, "POST", { snapshot });
    setConsole(data);
    await loadDashboard();
    return;
  }

  if (action === "toggle-enabled") {
    if (!job) return;
    const data = await api(`/api/jobs/${jobId}`, "PUT", {
      enabled: !job.enabled,
    });
    setConsole(data);
    await loadDashboard();
    return;
  }

  if (action === "delete") {
    if (!window.confirm(`Delete job '${jobId}'?`)) return;
    const data = await api(`/api/jobs/${jobId}`, "DELETE");
    setConsole(data);
    await loadDashboard();
  }
}

async function handleCreateJob(event) {
  event.preventDefault();
  const payload = {
    name: document.getElementById("jobName").value.trim(),
    airtableUrl: document.getElementById("jobUrl").value.trim(),
    outputPath: document.getElementById("jobOutput").value.trim(),
    enabled: document.getElementById("jobEnabled").checked,
    schedule: {
      enabled: document.getElementById("jobScheduleEnabled").checked,
      cron: document.getElementById("jobCron").value.trim(),
      timezone: document.getElementById("jobTz").value.trim(),
    },
  };

  setConsole("Creating job...");
  const data = await api("/api/jobs", "POST", payload);
  setConsole(data);
  jobForm.reset();
  document.getElementById("jobEnabled").checked = true;
  document.getElementById("jobScheduleEnabled").checked = true;
  updateCreateFormDerivedFields({ forceOutputPath: true });
  await loadDashboard();
}

async function handleUpdateSettings(event) {
  event.preventDefault();
  const payload = {
    defaultCron: document.getElementById("settingsDefaultCron").value.trim(),
    defaultTimezone: document
      .getElementById("settingsDefaultTimezone")
      .value.trim(),
    maxSnapshotsPerJob: Number(document.getElementById("settingsMaxSnapshots").value),
    maxHistoryPerJob: Number(document.getElementById("settingsMaxHistory").value),
    autoRunOnStartup: document.getElementById("settingsAutoRun").checked,
  };

  setConsole("Updating settings...");
  const data = await api("/api/settings", "PUT", payload);
  setConsole(data);
  await loadDashboard();
}

async function handleEditJob(event) {
  event.preventDefault();
  const jobId = document.getElementById("editJobId").value;
  const payload = {
    name: document.getElementById("editJobName").value.trim(),
    airtableUrl: document.getElementById("editJobUrl").value.trim(),
    outputPath: document.getElementById("editJobOutput").value.trim(),
    enabled: document.getElementById("editJobEnabled").checked,
    schedule: {
      enabled: document.getElementById("editJobScheduleEnabled").checked,
      cron: document.getElementById("editJobCron").value.trim(),
      timezone: document.getElementById("editJobTz").value.trim(),
    },
  };

  setConsole(`Updating job '${jobId}'...`);
  const data = await api(`/api/jobs/${jobId}`, "PUT", payload);
  setConsole(data);
  closeEditDialog();
  await loadDashboard();
}

runAllBtn.addEventListener("click", () => {
  handleRunAll().catch((error) => setConsole(`Run all failed: ${error.message}`));
});

refreshBtn.addEventListener("click", () => {
  loadDashboard().catch((error) => setConsole(`Refresh failed: ${error.message}`));
});

jobsList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  handleJobAction(button).catch((error) => {
    setConsole(`Action failed: ${error.message}`);
  });
});

jobForm.addEventListener("submit", (event) => {
  handleCreateJob(event).catch((error) => {
    setConsole(`Create failed: ${error.message}`);
  });
});

settingsForm.addEventListener("submit", (event) => {
  handleUpdateSettings(event).catch((error) => {
    setConsole(`Settings update failed: ${error.message}`);
  });
});

editJobForm.addEventListener("submit", (event) => {
  handleEditJob(event).catch((error) => {
    setConsole(`Edit failed: ${error.message}`);
  });
});

closeEditBtn.addEventListener("click", closeEditDialog);

jobNameInput.addEventListener("input", () => {
  updateCreateFormDerivedFields();
});

jobFilterInput.addEventListener("input", () => {
  jobFilter = jobFilterInput.value.trim().toLowerCase();
  if (dashboard) {
    renderJobs(dashboard);
  }
});

updateCreateFormDerivedFields({ forceOutputPath: true });

loadDashboard().catch((error) => {
  setConsole(`Startup failed: ${error.message}`);
});

setInterval(() => {
  loadDashboard().catch(() => {
    // keep UI responsive even if periodic refresh fails
  });
}, 60000);

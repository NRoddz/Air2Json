const path = require("path");
const dotenv = require("dotenv");
const { JobManager } = require("./jobManager");

dotenv.config();

async function main() {
  const projectRoot = path.join(__dirname, "..");
  const manager = new JobManager({ projectRoot, env: process.env });
  await manager.init({ enableSchedulers: false });

  const requestedJobId = process.env.EXPORT_JOB_ID;

  if (requestedJobId) {
    const run = await manager.runJob(requestedJobId, "cli");
    console.log(
      `[export] ${requestedJobId}: ${run.status} (${run.rows} rows, ${run.columns} columns)`
    );
    return;
  }

  const results = await manager.runAllEnabled("cli_batch");
  const failed = results.filter((result) => !result.ok);

  for (const result of results) {
    if (result.ok) {
      console.log(
        `[export] ${result.jobId}: success (${result.run.rows} rows, ${result.run.columns} columns)`
      );
    } else {
      console.log(`[export] ${result.jobId}: failed (${result.error})`);
    }
  }

  if (failed.length) {
    throw new Error(`${failed.length} job(s) failed`);
  }
}

main().catch((error) => {
  console.error(`[export] failed: ${error.message}`);
  process.exit(1);
});

const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { extractRowsFromAirtableHtml } = require("./airtableExtractor");

function normalizeHeader(header) {
  return String(header)
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((chunk, index) => {
      const lower = chunk.toLowerCase();
      if (index === 0) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join("");
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function normalizeDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  // Already ISO-like.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }

  // Supports dd/mm/yyyy or d/m/yyyy.
  const parts = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (parts) {
    const day = parts[1].padStart(2, "0");
    const month = parts[2].padStart(2, "0");
    const year = parts[3];
    return `${year}-${month}-${day}`;
  }

  return null;
}

function toRecord(headers, row) {
  const fields = {};
  const normalizedFields = {};

  for (let index = 0; index < headers.length; index += 1) {
    const key = headers[index];
    const value = String(row[index] ?? "").trim();
    fields[key] = value;
    normalizedFields[normalizeHeader(key)] = value;
  }

  const seed = `${fields["!Title"] || ""}|${fields["!Org"] || ""}|${fields["!Location"] || ""}|${fields["Vacancy Button"] || ""}`;
  const id = crypto.createHash("sha1").update(seed).digest("hex").slice(0, 16);

  const title = fields["!Title"] || normalizedFields.title || "";
  const organization = fields["!Org"] || normalizedFields.org || "";

  const tagsRaw = fields["!Problem area (filters)"] || "";
  const tags = tagsRaw
    ? tagsRaw
        .split(/\s*\|\s*|\s*,\s*/)
        .map((part) => part.trim())
        .filter(Boolean)
    : [];

  return {
    id,
    baseId: id,
    slug: slugify(`${title}-${organization}`) || id,
    title,
    organization,
    location: fields["!Location"] || normalizedFields.location || "",
    publishedAt: normalizeDate(fields["Date published"]),
    closesAt: normalizeDate(fields["!Date it closes"]),
    tags,
    links: {
      vacancy: fields["Vacancy Button"] || null,
      orgHomePage: fields["Org's home page"] || null,
      orgVacanciesPage: fields["Org's vacancies page"] || null,
      orgLogo: fields["Org's logo"] || null,
    },
    fields,
    normalizedFields,
  };
}

function buildCoverage(headers, rows) {
  return headers.map((name, index) => {
    let nonEmpty = 0;
    for (const row of rows) {
      if (String(row[index] ?? "").trim()) nonEmpty += 1;
    }
    return {
      name,
      key: normalizeHeader(name),
      nonEmpty,
      ratio: rows.length ? Number((nonEmpty / rows.length).toFixed(4)) : 0,
    };
  });
}

function buildPayload({ job, headers, rows, generatedAt }) {
  const records = rows.map((row) => toRecord(headers, row));
  const seen = new Map();
  for (const record of records) {
    const count = (seen.get(record.baseId) || 0) + 1;
    seen.set(record.baseId, count);
    if (count > 1) {
      record.id = `${record.baseId}-${count}`;
      record.slug = `${record.slug}-${count}`;
    }
    delete record.baseId;
  }
  return {
    meta: {
      schemaVersion: 2,
      generatedAt,
      source: job.airtableUrl,
      job: {
        id: job.id,
        name: job.name,
      },
      counts: {
        columns: headers.length,
        records: records.length,
      },
      columns: buildCoverage(headers, rows),
    },
    records,
  };
}

function hashRecord(record) {
  return crypto
    .createHash("sha1")
    .update(JSON.stringify(record.fields))
    .digest("hex");
}

function buildDiff(previousRecords, nextRecords) {
  const prevMap = new Map(previousRecords.map((record) => [record.id, hashRecord(record)]));
  const nextMap = new Map(nextRecords.map((record) => [record.id, hashRecord(record)]));

  let added = 0;
  let removed = 0;
  let updated = 0;
  let unchanged = 0;

  for (const [id, nextHash] of nextMap.entries()) {
    if (!prevMap.has(id)) {
      added += 1;
      continue;
    }
    if (prevMap.get(id) === nextHash) {
      unchanged += 1;
    } else {
      updated += 1;
    }
  }

  for (const id of prevMap.keys()) {
    if (!nextMap.has(id)) removed += 1;
  }

  return { added, removed, updated, unchanged };
}

async function readJsonIfExists(filePath) {
  try {
    const content = await fs.readFile(path.resolve(filePath), "utf8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function writeFileAtomic(targetPath, content) {
  const absolutePath = path.resolve(targetPath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });

  const tempPath = `${absolutePath}.tmp-${Date.now()}`;
  await fs.writeFile(tempPath, content, "utf8");
  await fs.rename(tempPath, absolutePath);
  return absolutePath;
}

async function trimSnapshots(snapshotDir, maxSnapshots) {
  if (!maxSnapshots || maxSnapshots < 1) return;

  const entries = await fs.readdir(snapshotDir);
  const jsonEntries = entries.filter((entry) => entry.endsWith(".json")).sort().reverse();
  const toDelete = jsonEntries.slice(maxSnapshots);
  for (const name of toDelete) {
    await fs.unlink(path.join(snapshotDir, name));
  }
}

async function exportJobToJson({ job, snapshotRoot, maxSnapshots = 30 }) {
  if (!job || !job.airtableUrl || !job.outputPath) {
    throw new Error("Invalid job config. Airtable URL and output path are required.");
  }

  const { headers, rows } = await extractRowsFromAirtableHtml(job.airtableUrl.trim());
  if (!headers.length || !rows.length) {
    throw new Error("No rows extracted from Airtable.");
  }

  const generatedAt = new Date().toISOString();
  const payload = buildPayload({ job, headers, rows, generatedAt });
  const previousPayload = await readJsonIfExists(job.outputPath);
  const previousRecords = Array.isArray(previousPayload?.records)
    ? previousPayload.records
    : [];
  const diff = buildDiff(previousRecords, payload.records);

  const prettyJson = `${JSON.stringify(payload, null, 2)}\n`;
  const outputPath = await writeFileAtomic(job.outputPath, prettyJson);

  const snapshotDir = path.resolve(snapshotRoot, job.id);
  await fs.mkdir(snapshotDir, { recursive: true });

  const snapshotName = `${generatedAt.replace(/[:.]/g, "-")}.json`;
  const snapshotPath = path.join(snapshotDir, snapshotName);
  await writeFileAtomic(snapshotPath, prettyJson);
  await trimSnapshots(snapshotDir, maxSnapshots);

  return {
    outputPath,
    snapshotPath,
    snapshotName,
    generatedAt,
    columns: headers.length,
    rows: payload.records.length,
    bytes: Buffer.byteLength(prettyJson, "utf8"),
    diff,
    payload,
  };
}

module.exports = {
  exportJobToJson,
  readJsonIfExists,
  writeFileAtomic,
  slugify,
};

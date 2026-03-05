const axios = require("axios");
const cheerio = require("cheerio");

function stripHtml(value) {
  return String(value).replace(/<[^>]+>/g, "").trim();
}

function valueToCell(value) {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "object" && item !== null) {
          if ("name" in item) return String(item.name);
          if ("url" in item) return String(item.url);
          return JSON.stringify(item);
        }
        return String(item);
      })
      .join(", ");
  }
  if (typeof value === "object") {
    if ("name" in value) return String(value.name);
    return JSON.stringify(value);
  }
  return String(value);
}

function tableRowsFromHtml($) {
  const table = $("table").first();
  if (!table.length) return null;

  const headers = [];
  table.find("thead th").each((_, el) => headers.push(stripHtml($(el).text())));
  if (!headers.length) {
    table.find("tr").first().find("th,td").each((_, el) => headers.push(stripHtml($(el).text())));
  }
  if (!headers.length) return null;

  const rows = [];
  table.find("tbody tr").each((_, tr) => {
    const row = [];
    $(tr).find("td,th").each((__, td) => row.push(stripHtml($(td).text())));
    if (row.some((cell) => cell !== "")) rows.push(row);
  });

  return { headers, rows };
}

function extractJsonStrings(scriptText) {
  const outputs = [];

  const jsonScriptRegex = /({[\s\S]*})/g;
  let match = jsonScriptRegex.exec(scriptText);
  while (match) {
    outputs.push(match[1]);
    match = jsonScriptRegex.exec(scriptText);
  }

  const assignmentRegex = /(?:window\.[a-zA-Z0-9_$]+|var\s+[a-zA-Z0-9_$]+)\s*=\s*({[\s\S]*?});/g;
  let assigned = assignmentRegex.exec(scriptText);
  while (assigned) {
    outputs.push(assigned[1]);
    assigned = assignmentRegex.exec(scriptText);
  }

  return outputs;
}

function safelyParseJson(str) {
  try {
    const normalized = str.replace(/\\u002F/g, "/");
    return JSON.parse(normalized);
  } catch {
    return null;
  }
}

function walk(node, fn) {
  if (!node || typeof node !== "object") return;
  fn(node);
  if (Array.isArray(node)) {
    for (const item of node) walk(item, fn);
    return;
  }
  for (const key of Object.keys(node)) {
    walk(node[key], fn);
  }
}

function rowsFromAirtableLikeObject(obj) {
  let result = null;
  walk(obj, (candidate) => {
    if (result) return;
    if (!candidate || typeof candidate !== "object") return;

    const fields = Array.isArray(candidate.fields) ? candidate.fields : null;
    const records = Array.isArray(candidate.records) ? candidate.records : null;
    if (!fields || !records || !fields.length || !records.length) return;

    const normalizedFields = fields
      .filter((f) => f && typeof f === "object" && (f.id || f.name))
      .map((f) => ({ id: String(f.id || f.name), name: String(f.name || f.id) }));
    if (!normalizedFields.length) return;

    const headers = normalizedFields.map((f) => f.name);
    const rows = records.map((record) => {
      const cells = record && typeof record === "object" ? record.cellValuesByFieldId || record.fields || {} : {};
      return normalizedFields.map((field) => valueToCell(cells[field.id]));
    });
    result = { headers, rows };
  });
  return result;
}

function rowsFromGenericRowsObject(obj) {
  let result = null;
  walk(obj, (candidate) => {
    if (result) return;
    if (!candidate || typeof candidate !== "object") return;

    const rows = Array.isArray(candidate.rows) ? candidate.rows : null;
    if (!rows || !rows.length) return;
    const first = rows[0];
    if (!first || typeof first !== "object") return;

    const keys = Object.keys(first).filter((k) => typeof first[k] !== "object" || first[k] === null);
    if (!keys.length) return;

    const headerSet = new Set(keys);
    const materializedRows = rows.map((row) => keys.map((key) => valueToCell(row[key])));
    if (!materializedRows.length) return;

    result = { headers: [...headerSet], rows: materializedRows };
  });
  return result;
}

function pickBestCandidate(candidates) {
  const valid = candidates.filter((c) => c && c.headers?.length && c.rows?.length);
  if (!valid.length) return null;
  valid.sort((a, b) => b.rows.length - a.rows.length);
  return valid[0];
}

async function extractWithRenderedHtml(airtableUrl) {
  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch {
    throw new Error(
      "Playwright is not installed. Run: npm install playwright && npx playwright install chromium"
    );
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();
    await page.goto(airtableUrl, { waitUntil: "domcontentloaded", timeout: 45000 });

    // Dismiss common cookie overlays that can block interaction/hydration.
    for (const selector of [
      "#onetrust-accept-btn-handler",
      ".onetrust-close-btn-handler",
      "#onetrust-close-btn-container button",
    ]) {
      try {
        await page.click(selector, { timeout: 1000 });
      } catch {
        // Best-effort only.
      }
    }

    // Airtable grid can take time to hydrate.
    try {
      await page.waitForSelector(
        '[data-testid^="gridCell-"], [data-rowindex][data-columnindex].cell',
        { timeout: 30000 }
      );
    } catch {
      await page.waitForTimeout(5000);
    }

    const renderedHtml = await page.content();
    const $ = cheerio.load(renderedHtml);

    const directTable = tableRowsFromHtml($);
    if (directTable && directTable.rows.length) {
      return directTable;
    }

    const collectGridSnapshot = async () =>
      page.evaluate(() => {
        const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
        const extractCellValue = (cell) => {
          const columnType = String(cell.getAttribute("data-columntype") || "");

          if (columnType === "button") {
            const href = cell.querySelector("a[href]")?.getAttribute("href");
            if (href) return clean(href);
          }

          if (columnType === "foreignKey") {
            const tagValues = Array.from(
              cell.querySelectorAll(
                ".foreignRecordRendererContainer .foreign-key-blue, .foreignRecordRendererContainer [class*='foreign-key']"
              )
            )
              .map((node) => clean(node.textContent))
              .filter(Boolean);

            if (tagValues.length) {
              return [...new Set(tagValues)].join(" | ");
            }
          }

          return clean(cell.innerText);
        };
        const findScroller = () => {
          const byClass = document.querySelector(".antiscroll-inner");
          if (byClass) return byClass;

          const candidates = Array.from(document.querySelectorAll("div")).filter(
            (el) => el.scrollHeight - el.clientHeight > 50
          );
          return (
            candidates.find((el) =>
              el.querySelector('[data-testid^="gridCell-"], [data-rowindex][data-columnindex].cell')
            ) || document.scrollingElement
          );
        };

        const headerEntries = [];
        for (const headerCell of document.querySelectorAll(
          '[data-tutorial-selector-id="gridHeaderCell"][data-columnindex], .cell.header[data-columnindex]'
        )) {
          const columnIndex = Number(headerCell.getAttribute("data-columnindex"));
          const name = clean(headerCell.innerText);
          if (Number.isFinite(columnIndex) && name) {
            headerEntries.push([columnIndex, name]);
          }
        }

        const rowEntries = [];
        for (const cell of document.querySelectorAll(
          '[data-testid^="gridCell-"][data-rowindex][data-columnindex], [data-rowindex][data-columnindex].cell'
        )) {
          const rowIndex = Number(cell.getAttribute("data-rowindex"));
          const columnIndex = Number(cell.getAttribute("data-columnindex"));
          if (!Number.isFinite(rowIndex) || !Number.isFinite(columnIndex)) continue;
          rowEntries.push([rowIndex, columnIndex, extractCellValue(cell)]);
        }

        const selectionText = clean(
          document.querySelector(".selectionCount")?.textContent || ""
        );
        const totalMatch = selectionText.match(/([\d,]+)\s+records?/i);
        const totalRecords = totalMatch
          ? Number(totalMatch[1].replace(/,/g, ""))
          : null;

        const scroller = findScroller();
        const scrollState = scroller
          ? {
              scrollTop: scroller.scrollTop,
              scrollLeft: scroller.scrollLeft,
              scrollHeight: scroller.scrollHeight,
              scrollWidth: scroller.scrollWidth,
              clientHeight: scroller.clientHeight,
              clientWidth: scroller.clientWidth,
            }
          : null;

        return { headerEntries, rowEntries, totalRecords, scrollState };
      });

    const headerByIndex = new Map();
    const rowMap = new Map();

    const mergeSnapshot = (snapshot) => {
      for (const [columnIndex, name] of snapshot.headerEntries || []) {
        if (!headerByIndex.has(columnIndex)) headerByIndex.set(columnIndex, name);
      }
      for (const [rowIndex, columnIndex, value] of snapshot.rowEntries || []) {
        if (!rowMap.has(rowIndex)) rowMap.set(rowIndex, new Map());
        const row = rowMap.get(rowIndex);
        // Keep first non-empty value if virtualized duplicates appear.
        if (!row.has(columnIndex) || (row.get(columnIndex) === "" && value !== "")) {
          row.set(columnIndex, value);
        }
      }
    };

    let initial = await collectGridSnapshot();
    mergeSnapshot(initial);

    const metrics = initial.scrollState;
    if (!metrics) {
      throw new Error("Could not find Airtable grid scroller in rendered page.");
    }

    const horizontalStep = Math.max(200, Math.floor(metrics.clientWidth * 0.85));
    const verticalStep = Math.max(200, Math.floor(metrics.clientHeight * 0.85));

    const xPositions = [];
    for (let left = 0; left <= metrics.scrollWidth; left += horizontalStep) {
      xPositions.push(Math.min(left, Math.max(0, metrics.scrollWidth - metrics.clientWidth)));
    }
    if (!xPositions.includes(0)) xPositions.unshift(0);
    xPositions.sort((a, b) => a - b);
    const uniqueXPositions = [...new Set(xPositions)];

    for (const left of uniqueXPositions) {
      await page.evaluate((targetLeft) => {
        const scroller =
          document.querySelector(".antiscroll-inner") || document.scrollingElement;
        if (scroller) scroller.scrollLeft = targetLeft;
      }, left);
      await page.waitForTimeout(120);

      let previousRowCount = rowMap.size;
      let stallPasses = 0;
      for (let top = 0; top <= metrics.scrollHeight; top += verticalStep) {
        const clampedTop = Math.min(top, Math.max(0, metrics.scrollHeight - metrics.clientHeight));
        await page.evaluate((targetTop) => {
          const scroller =
            document.querySelector(".antiscroll-inner") || document.scrollingElement;
          if (scroller) scroller.scrollTop = targetTop;
        }, clampedTop);
        await page.waitForTimeout(120);

        const snapshot = await collectGridSnapshot();
        mergeSnapshot(snapshot);

        if (rowMap.size === previousRowCount) {
          stallPasses += 1;
        } else {
          previousRowCount = rowMap.size;
          stallPasses = 0;
        }

        // If no new rows appear for several viewport jumps near the end, stop this sweep.
        if (stallPasses >= 4 && clampedTop >= metrics.scrollHeight - metrics.clientHeight - verticalStep) {
          break;
        }
      }
    }

    const result = (() => {
      const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
      const sortedColumnIndexes = Array.from(headerByIndex.keys()).sort((a, b) => a - b);
      const headers = sortedColumnIndexes.map((index) => clean(headerByIndex.get(index) || ""));
      const rows = Array.from(rowMap.keys())
        .sort((a, b) => a - b)
        .map((rowIndex) => {
          const values = rowMap.get(rowIndex);
          return sortedColumnIndexes.map((columnIndex) => values.get(columnIndex) || "");
        })
        .filter((row) => row.some((cell) => cell !== ""));
      return { headers, rows };
    })();

    if (result.headers && result.headers.length && result.rows && result.rows.length) {
      return result;
    }

    throw new Error("Rendered page did not expose extractable grid rows.");
  } finally {
    await browser.close();
  }
}

async function extractRowsFromAirtableHtml(airtableUrl) {
  const response = await axios.get(airtableUrl, {
    timeout: 30000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml",
    },
  });

  const html = response.data;
  const $ = cheerio.load(html);

  const tableCandidate = tableRowsFromHtml($);
  if (tableCandidate && tableCandidate.rows.length) return tableCandidate;

  const jsonCandidates = [];
  $("script").each((_, scriptEl) => {
    const text = $(scriptEl).html() || "";
    if (!text || text.length < 20) return;
    for (const jsonChunk of extractJsonStrings(text)) {
      const parsed = safelyParseJson(jsonChunk);
      if (parsed) jsonCandidates.push(parsed);
    }
  });

  const extracted = [];
  for (const candidate of jsonCandidates) {
    extracted.push(rowsFromAirtableLikeObject(candidate));
    extracted.push(rowsFromGenericRowsObject(candidate));
  }

  const best = pickBestCandidate(extracted);
  if (best) return best;
  return extractWithRenderedHtml(airtableUrl);
}

module.exports = { extractRowsFromAirtableHtml };

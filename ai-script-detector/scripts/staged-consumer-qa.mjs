import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import {
  buildSummary,
  formatInlineCompact,
  formatInlineOutcome,
  formatWorkspaceHandoff,
  isRetryableInlineTransportError
} from "./staged-consumer-qa-lib.mjs";
import { fetchBackendMetadata } from "./release-readiness-lib.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const Contracts = require(path.join(__dirname, "..", "shared", "contracts.js"));
const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_MATRIX_PATH = path.join(ROOT_DIR, "release", "staging-video-matrix.json");
const DEFAULT_EXTENSION_PATH = path.join(ROOT_DIR, "dist", "chrome-unpacked");
const DEFAULT_REPORT_JSON = path.join(ROOT_DIR, "release", "staged-qa-report.json");
const DEFAULT_REPORT_MD = path.join(ROOT_DIR, "release", "staged-qa-report.md");
const ROOT_ID = "#scriptlens-youtube-cta-root";
const DEFAULT_BACKEND_TIMEOUT_MS = 90000;
const DEFAULT_REQUESTED_LANGUAGE_CODE = "en";
const DEFAULT_AUTO_ASR_SECONDS = 2100;
const DEFAULT_PANEL_TIMEOUT_MS = 10000;
const DEFAULT_INLINE_TIMEOUT_MS = 60000;

const args = parseArgs(process.argv.slice(2));
const matrix = loadMatrix(args.matrixPath || DEFAULT_MATRIX_PATH, {
  canaryOnly: args.canaryOnly,
  limit: args.limit
});
const backendOrigin = resolveBackendOrigin(args.backendOrigin);

if (!backendOrigin) {
  console.error("Missing backend origin. Pass --backend-origin or set SCRIPTLENS_BACKEND_ORIGIN.");
  process.exit(1);
}

const backendEndpoint = backendOrigin.replace(/\/+$/, "") + "/transcript/resolve";
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const generatedAt = new Date().toISOString();
const backendClientInstanceId =
  args.clientInstanceId || `staging-backend-${runId}`;
const inlineClientInstanceId =
  args.inlineClientInstanceId || `staging-inline-${runId}`;
const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isDirectRun) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}

async function main() {
  const backendResults = await runBackendMatrix(matrix, {
    endpoint: backendEndpoint,
    timeoutMs: args.timeoutMs || DEFAULT_BACKEND_TIMEOUT_MS,
    requestedLanguageCode: args.requestedLanguageCode || DEFAULT_REQUESTED_LANGUAGE_CODE,
    maxAutomaticAsrDurationSeconds:
      args.maxAutomaticAsrDurationSeconds || DEFAULT_AUTO_ASR_SECONDS,
    clientInstanceId: backendClientInstanceId
  });

  let inlineResults = [];
  if (!args.backendOnly) {
    inlineResults = await runInlineMatrix(matrix, {
      extensionPath: args.extensionPath || DEFAULT_EXTENSION_PATH,
      backendEndpoint,
      clientInstanceId: inlineClientInstanceId
    });
  }

  const mergedResults = matrix.map((entry) => ({
    ...entry,
    backend: backendResults.find((result) => result.id === entry.id) || null,
    inline: inlineResults.find((result) => result.id === entry.id) || null
  }));
  const summary = buildSummary(mergedResults);
  const backendMetadata = await fetchBackendMetadata(backendOrigin);
  const report = {
    generatedAt,
    backendOrigin,
    backendMetadata,
    backendClientInstanceId,
    inlineClientInstanceId: args.backendOnly ? null : inlineClientInstanceId,
    matrix: mergedResults,
    summary
  };

  fs.writeFileSync(args.reportJson || DEFAULT_REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(args.reportMarkdown || DEFAULT_REPORT_MD, buildMarkdownReport(report), "utf8");

  console.log(`Staged QA report written to ${args.reportMarkdown || DEFAULT_REPORT_MD}`);
  console.log(`Summary: ${summary.backendSuccess}/${matrix.length} backend transcript-class successes`);
  if (!args.backendOnly) {
    console.log(`Inline: ${summary.inlineSuccess}/${matrix.length} inline success cards`);
    console.log(`Compact UX: ${summary.inlineCompact}/${summary.inlineMeasured} measured inline runs stayed compact`);
  }
  if (args.requireCanary && summary.canaryMismatches.length) {
    console.error("Canary expectation mismatches:");
    summary.canaryMismatches.forEach((mismatch) => console.error(`- ${mismatch}`));
    process.exitCode = 1;
  }
}

function loadMatrix(matrixPath, options) {
  const raw = fs.readFileSync(matrixPath, "utf8");
  const entries = JSON.parse(raw);
  let filtered = Array.isArray(entries) ? entries : [];

  if (options.canaryOnly) {
    filtered = filtered.filter((entry) => entry.canary);
  }
  if (Number.isFinite(options.limit) && options.limit > 0) {
    filtered = filtered.slice(0, options.limit);
  }

  return filtered;
}

async function runBackendMatrix(entries, options) {
  const results = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const payload = {
      url: entry.url,
      requestedLanguageCode: options.requestedLanguageCode,
      analysisMode: "youtube-transcript-first",
      allowAutomaticAsr: true,
      maxAutomaticAsrDurationSeconds: options.maxAutomaticAsrDurationSeconds,
      clientInstanceId: `${options.clientInstanceId}-${index + 1}`,
      traceId: `staging-backend-${index + 1}-${Date.now()}`
    };

    const startedAt = Date.now();
    try {
      const response = await withRetries(
        () => fetchWithTimeout(options.endpoint, payload, options.timeoutMs),
        2,
        isRetryableTransportError
      );
      const body = response.body || {};
      results.push({
        id: entry.id,
        ok: Boolean(body.ok),
        contractVersion: body.contractVersion || Contracts.CONTRACT_VERSION,
        latencyMs: Date.now() - startedAt,
        originKind: body.originKind || "unavailable",
        recoveryTier: body.recoveryTier || null,
        sourceTrustTier: body.sourceTrustTier || null,
        winnerReason: body.winnerReason || body.errorCode || "unknown",
        errorCode: body.errorCode || null,
        failureCategory:
          body.failureCategory ||
          Contracts.resolveFailureCategory(body) ||
          null,
        authenticatedAcquisitionUsed: Boolean(body.authenticatedAcquisitionUsed),
        acquisitionPathUsed: body.acquisitionPathUsed || null,
        qualityGate: body.qualityGate || null,
        warnings: Array.isArray(body.warnings) ? body.warnings.slice() : [],
        stageTelemetry: Array.isArray(body.stageTelemetry) ? body.stageTelemetry : [],
        meetsExpectation: evaluateExpectation(entry, body)
      });
    } catch (error) {
      results.push({
        id: entry.id,
        ok: false,
        contractVersion: Contracts.CONTRACT_VERSION,
        latencyMs: Date.now() - startedAt,
        originKind: "transport-error",
        recoveryTier: null,
        sourceTrustTier: null,
        winnerReason: "transport_error",
        errorCode: "transport_error",
        failureCategory:
          Contracts.resolveFailureCategory("transport_error") ||
          Contracts.FAILURE_CATEGORIES.transport,
        authenticatedAcquisitionUsed: false,
        acquisitionPathUsed: null,
        qualityGate: null,
        warnings: [],
        transportError: error?.message || String(error),
        stageTelemetry: [],
        meetsExpectation: false
      });
    }
  }

  return results;
}

async function runInlineMatrix(entries, options) {
  const extensionPath = path.resolve(options.extensionPath);
  if (!fs.existsSync(extensionPath)) {
    throw new Error(`Built extension not found at ${extensionPath}. Run build:extension first.`);
  }

  const userDataDir = path.join(ROOT_DIR, "test-results", `staging-qa-${Date.now()}`);
  fs.mkdirSync(userDataDir, { recursive: true });

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: process.env.PW_HEADLESS === "1",
    viewport: { width: 1600, height: 1000 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  });

  try {
    let [serviceWorker] = context.serviceWorkers();
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent("serviceworker", { timeout: 20000 });
    }

    await saveExtensionSettings(serviceWorker, {
      allowBackendTranscriptFallback: true,
      backendTranscriptEndpoint: options.backendEndpoint,
      clientInstanceId: options.clientInstanceId
    });

    const results = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const page = await context.newPage();
      try {
        await clearPanelLaunchRequest(serviceWorker);
        await gotoVideoWithRetry(page, entry.url);
        await page.bringToFront();
        await page.waitForTimeout(2500);
        const overlay = page.locator(ROOT_ID);
        await overlay.waitFor({ state: "visible", timeout: 20000 });

        const panelBefore = await getTranscriptPanelState(page);
        const startedAt = Date.now();
        await clickOverlayButton(overlay, "Analyze video");
        const outcome = await waitForInlineOutcome(overlay, DEFAULT_INLINE_TIMEOUT_MS);
        const latencyMs = Date.now() - startedAt;

        let detailsOpened = false;
        if (outcome === "success") {
          await clickOverlayButton(overlay, "Details");
          detailsOpened = true;
          await page.waitForTimeout(400);
        }

        const snapshot = await getInlineSnapshot(page);
        const panelAfter = await getTranscriptPanelState(page);

        let workspaceHandoffWorks = false;
        if (outcome === "success" || outcome === "error") {
          await clickOverlayButton(overlay, "Open full workspace");
          workspaceHandoffWorks = await waitForPanelLaunchRequest(serviceWorker);
        }

        const compactInline = Boolean(snapshot.cardWidth > 0 && snapshot.cardWidth <= 380 && !panelAfter.visible);
        const understandable = evaluateInlineUnderstandable(outcome, snapshot);

        results.push({
          id: entry.id,
          outcome,
          latencyMs,
          detailsOpened,
          compactInline,
          understandable,
          noSidebarBlowup: !panelAfter.visible,
          workspaceHandoffWorks,
          panelBefore,
          panelAfter,
          cardWidth: snapshot.cardWidth,
          title: snapshot.title,
          scoreText: snapshot.scoreText,
          summaryText: snapshot.summaryText,
          reducedTrustVisible: snapshot.badges.includes("Audio-derived transcript"),
          detailsText: snapshot.detailsText,
          buttons: snapshot.buttons,
          detailsHonest: outcome === "success" ? Boolean(snapshot.detailsText) : true
        });
      } catch (error) {
        const navigationTransportIssue = isRetryableInlineTransportError(error);
        results.push({
          id: entry.id,
          outcome: navigationTransportIssue ? "transport" : "crashed",
          latencyMs: 0,
          detailsOpened: false,
          compactInline: null,
          understandable: null,
          noSidebarBlowup: null,
          workspaceHandoffWorks: null,
          panelBefore: null,
          panelAfter: null,
          cardWidth: 0,
          title: "",
          scoreText: "",
          summaryText: "",
          reducedTrustVisible: false,
          detailsText: "",
          buttons: [],
          detailsHonest: false,
          transportIssue: navigationTransportIssue,
          error: error?.message || String(error)
        });
      } finally {
        await page.close().catch(() => {});
      }
    }

    return results;
  } finally {
    await context.close();
  }
}

async function fetchWithTimeout(endpoint, payload, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    return {
      ok: response.ok,
      status: response.status,
      body: await response.json()
    };
  } finally {
    clearTimeout(timer);
  }
}

async function saveExtensionSettings(serviceWorker, partialSettings) {
  await serviceWorker.evaluate(async (updates) => {
    const defaultSettings = {
      sensitivity: "medium",
      maxTextLength: 18000,
      minCharacters: 180,
      minWords: 40,
      recentReportsLimit: 5,
      debugMode: false,
      allowBackendTranscriptFallback: true,
      backendTranscriptEndpoint: "",
      clientInstanceId: ""
    };

    await new Promise((resolve) => setTimeout(resolve, 500));
    await new Promise((resolve, reject) => {
      chrome.storage.local.set(
        {
          settings: {
            ...defaultSettings,
            ...updates
          }
        },
        () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve();
        }
      );
    });

    const startedAt = Date.now();
    while (Date.now() - startedAt < 5000) {
      const values = await new Promise((resolve, reject) => {
        chrome.storage.local.get(["settings"], (items) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(items || {});
        });
      });
      const settings = values.settings || {};
      if (
        settings.backendTranscriptEndpoint === updates.backendTranscriptEndpoint &&
        settings.allowBackendTranscriptFallback === updates.allowBackendTranscriptFallback &&
        settings.clientInstanceId === updates.clientInstanceId
      ) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error("Timed out while applying extension settings for staged QA.");
  }, partialSettings);
}

async function clearPanelLaunchRequest(serviceWorker) {
  await serviceWorker.evaluate(async () => {
    await new Promise((resolve, reject) => {
      chrome.storage.session.remove(["panelLaunchRequest"], () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      });
    });
  });
}

async function waitForPanelLaunchRequest(serviceWorker) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < DEFAULT_PANEL_TIMEOUT_MS) {
    const value = await serviceWorker.evaluate(async () => {
      return await new Promise((resolve, reject) => {
        chrome.storage.session.get(["panelLaunchRequest"], (values) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(values.panelLaunchRequest || null);
        });
      });
    });
    if (value?.request?.mode === "youtube") {
      return true;
    }
    await wait(250);
  }
  return false;
}

async function gotoVideoWithRetry(page, url, attempts = 3) {
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableInlineTransportError(error) || attempt === attempts - 1) {
        throw error;
      }
      await wait(500);
    }
  }

  throw lastError;
}

async function clickOverlayButton(overlay, name) {
  const locator = overlay.getByRole("button", { name }).first();
  await locator.waitFor({ state: "attached", timeout: 15000 });
  try {
    await locator.click({ timeout: 5000 });
  } catch (_error) {
    await locator.evaluate((element) => {
      element.click();
    });
  }
}

async function waitForInlineOutcome(overlay, timeoutMs) {
  const details = overlay.getByRole("button", { name: "Details" }).first();
  const retry = overlay.getByRole("button", { name: "Try again" }).first();
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await details.isVisible().catch(() => false)) {
      return "success";
    }
    if (await retry.isVisible().catch(() => false)) {
      return "error";
    }
    await wait(250);
  }

  return "timeout";
}

async function getTranscriptPanelState(page) {
  return await page.evaluate(() => {
    const panel = document.querySelector(
      'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]'
    );
    if (!panel) {
      return {
        exists: false,
        visible: false
      };
    }
    const style = getComputedStyle(panel);
    const rect = panel.getBoundingClientRect();
    return {
      exists: true,
      visible:
        !panel.hidden &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
    };
  });
}

async function getInlineSnapshot(page) {
  return await page.evaluate(() => {
    const root = document.querySelector("#scriptlens-youtube-cta-root");
    const shadow = root?.shadowRoot;
    const card = shadow?.querySelector(".sl-card, .sl-pill");
    const buttons = shadow
      ? Array.from(shadow.querySelectorAll("button")).map((button) =>
          String(button.textContent || "").replace(/\s+/g, " ").trim()
        )
      : [];
    const badges = shadow
      ? Array.from(shadow.querySelectorAll(".sl-badge, .sl-chip")).map((badge) =>
          String(badge.textContent || "").replace(/\s+/g, " ").trim()
        )
      : [];

    return {
      title: String(shadow?.querySelector(".sl-title")?.textContent || "").trim(),
      scoreText: String(shadow?.querySelector(".sl-score strong")?.textContent || "").trim(),
      summaryText: Array.from(shadow?.querySelectorAll(".sl-summary, .sl-copy") || [])
        .map((node) => String(node.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join(" | "),
      detailsText: String(shadow?.querySelector(".sl-details")?.textContent || "")
        .replace(/\s+/g, " ")
        .trim(),
      buttons,
      badges,
      cardWidth: card ? Math.round(card.getBoundingClientRect().width) : 0
    };
  });
}

function evaluateInlineUnderstandable(outcome, snapshot) {
  if (outcome === "success") {
    return Boolean(
      snapshot.title &&
        snapshot.scoreText &&
        (snapshot.buttons.includes("Details") || snapshot.buttons.includes("Hide details")) &&
        snapshot.buttons.includes("Open full workspace")
    );
  }
  if (outcome === "error") {
    return Boolean(
      /couldn't finish the transcript check/i.test(snapshot.title) &&
        snapshot.buttons.includes("Try again") &&
        snapshot.buttons.includes("Open full workspace")
    );
  }
  if (outcome === "transport") {
    return null;
  }
  return false;
}

function evaluateExpectation(entry, body) {
  if (!entry.canary) {
    return null;
  }

  if (typeof entry.expectedOk === "boolean" && Boolean(body?.ok) !== entry.expectedOk) {
    return false;
  }
  if (entry.expectedOriginKind && body?.originKind !== entry.expectedOriginKind) {
    return false;
  }
  if (entry.expectedErrorCode && body?.errorCode !== entry.expectedErrorCode) {
    return false;
  }
  return true;
}

function buildMarkdownReport(report) {
  const lines = [
    "# Staged Consumer QA Report",
    "",
    `Generated: ${report.generatedAt}`,
    `Backend: ${report.backendOrigin}`,
    `Backend client instance: ${report.backendClientInstanceId}`,
    report.inlineClientInstanceId ? `Inline client instance: ${report.inlineClientInstanceId}` : "Inline: skipped",
    "",
    `Backend transcript-class successes: ${report.summary.backendSuccess}/${report.summary.total}`,
    report.inlineClientInstanceId
      ? `Inline success cards: ${report.summary.inlineSuccess}/${report.summary.total}`
      : "Inline success cards: skipped",
    report.inlineClientInstanceId
      ? `Inline compact runs: ${report.summary.inlineCompact}/${report.summary.inlineMeasured}`
      : "Inline compact runs: skipped",
    report.inlineClientInstanceId
      ? `Inline transport issues: ${report.summary.inlineTransportIssues}`
      : "Inline transport issues: skipped",
    report.inlineClientInstanceId
      ? `Backend-good inline errors: ${report.summary.backendGoodInlineErrors}`
      : "Backend-good inline errors: skipped",
    ""
  ];

  if (report.summary.canaryMismatches.length) {
    lines.push("## Canary mismatches", "");
    report.summary.canaryMismatches.forEach((item) => lines.push(`- ${item}`));
    lines.push("");
  }

  lines.push(
    "| Video | Categories | Backend | Failure Category | Origin | Recovery | Trust | Winner | Latency (ms) | Inline | Compact | Workspace |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | ---: | --- | --- | --- |"
  );

  report.matrix.forEach((entry) => {
    lines.push(
      `| ${entry.label} | ${entry.categories.join(", ")} | ${entry.backend?.ok ? "success" : `fail (${entry.backend?.errorCode || entry.backend?.winnerReason || "n/a"})`} | ${entry.backend?.failureCategory || "n/a"} | ${entry.backend?.originKind || "n/a"} | ${entry.backend?.recoveryTier || "n/a"} | ${entry.backend?.sourceTrustTier || "n/a"} | ${entry.backend?.winnerReason || "n/a"} | ${entry.backend?.latencyMs ?? ""} | ${entry.inline ? formatInlineOutcome(entry.inline) : "skipped"} | ${entry.inline ? formatInlineCompact(entry.inline) : "skipped"} | ${entry.inline ? formatWorkspaceHandoff(entry.inline) : "skipped"} |`
    );
  });

  lines.push("", "## Notes", "");
  lines.push("- `Inline` records whether the watch-page widget reached a success card, error card, or timed out.");
  lines.push("- `Compact` requires the inline card to stay within the small watch-page footprint and avoid opening the YouTube transcript engagement panel.");
  lines.push("- `Workspace` checks that `Open full workspace` stored a valid panel launch request.");
  lines.push("- `transport` means the staged runner hit a transient browser/network navigation failure before the page could load; it is tracked separately from product behavior.");
  lines.push("");
  return lines.join("\n");
}

function parseArgs(argv) {
  const result = {
    backendOrigin: "",
    matrixPath: "",
    extensionPath: "",
    reportJson: "",
    reportMarkdown: "",
    clientInstanceId: "",
    inlineClientInstanceId: "",
    timeoutMs: null,
    requestedLanguageCode: DEFAULT_REQUESTED_LANGUAGE_CODE,
    maxAutomaticAsrDurationSeconds: DEFAULT_AUTO_ASR_SECONDS,
    backendOnly: false,
    canaryOnly: false,
    requireCanary: false,
    limit: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--backend-origin") {
      result.backendOrigin = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (value === "--matrix") {
      result.matrixPath = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (value === "--extension-path") {
      result.extensionPath = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (value === "--report-json") {
      result.reportJson = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (value === "--report-markdown") {
      result.reportMarkdown = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (value === "--client-instance-id") {
      result.clientInstanceId = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (value === "--inline-client-instance-id") {
      result.inlineClientInstanceId = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (value === "--timeout-ms") {
      result.timeoutMs = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (value === "--requested-language-code") {
      result.requestedLanguageCode = String(argv[index + 1] || "").trim().toLowerCase() || DEFAULT_REQUESTED_LANGUAGE_CODE;
      index += 1;
      continue;
    }
    if (value === "--max-automatic-asr-duration-seconds") {
      result.maxAutomaticAsrDurationSeconds = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (value === "--limit") {
      result.limit = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (value === "--backend-only") {
      result.backendOnly = true;
      continue;
    }
    if (value === "--canary-only") {
      result.canaryOnly = true;
      continue;
    }
    if (value === "--require-canary") {
      result.requireCanary = true;
    }
  }

  return result;
}

function resolveBackendOrigin(input) {
  return String(input || process.env.SCRIPTLENS_BACKEND_ORIGIN || "").trim();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetries(task, attempts, predicate) {
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1 || !predicate(error)) {
        throw error;
      }
      await wait(1000);
    }
  }

  throw lastError;
}

function isRetryableTransportError(error) {
  const message = String(error?.message || "");
  return /fetch failed|ECONNRESET|ETIMEDOUT|timeout|UND_ERR|socket/i.test(message);
}

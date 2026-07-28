import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { ROOT_DIR, buildExtension } from "./release-lib.mjs";
import { fetchBackendMetadata, resolveBackendOrigin } from "./release-readiness-lib.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const Contracts = require(path.join(__dirname, "..", "shared", "contracts.js"));
const { startBackendServer } = require(path.join(__dirname, "..", "backend", "server.js"));

const DEFAULT_MATRIX_PATH = path.join(ROOT_DIR, "release", "defuddle-video-matrix.json");
const DEFAULT_REPORT_JSON = path.join(ROOT_DIR, "release", "defuddle-video-report.json");
const DEFAULT_REPORT_MD = path.join(ROOT_DIR, "release", "defuddle-video-report.md");
const DEFAULT_SETTLE_MS = 2500;
const DEFAULT_OVERLAY_TIMEOUT_MS = 20000;
const DEFAULT_ANALYZE_TIMEOUT_MS = 90000;
const DEFAULT_ACTIVE_TAB_TIMEOUT_MS = 15000;
const DEFAULT_INIT_TIMEOUT_MS = 30000;
const ROOT_ID = "#scriptlens-youtube-cta-root";
const DEFAULT_BACKEND_ENDPOINT = String(process.env.SCRIPTLENS_BACKEND_ENDPOINT || "").trim();
const DEFAULT_REQUEST = Object.freeze({
  mode: "youtube",
  includeSources: ["transcript", "description", "title"],
  trackBaseUrl: "",
  transcriptBias: "manual-en",
  requireTranscript: false,
  allowFallbackText: true
});

const args = parseArgs(process.argv.slice(2));
const matrix = loadMatrix(args.matrixPath || DEFAULT_MATRIX_PATH, args);
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isDirectRun) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}

async function main() {
  if (!matrix.length) {
    throw new Error("No Defuddle video matrix entries matched the requested filters.");
  }

  const localBackend = await maybeStartLocalBackend(args);

  try {
    const buildRoot = path.join(ROOT_DIR, "dist", "defuddle-video-qa");
    const controlBuild = buildVariant(false, path.join(buildRoot, "control"));
    const defuddleBuild = buildVariant(true, path.join(buildRoot, "defuddle"));
    const variants = buildVariantPlan({
      controlBuild,
      defuddleBuild,
      includeBackend: args.includeBackend,
      backendEndpoint: localBackend?.url || args.backendEndpoint
    });
    const variantResults = {};

    for (const variant of variants) {
      variantResults[variant.key] = await runVariant(matrix, {
        variant: variant.label,
        extensionPath: variant.extensionPath,
        runtimeSettings: variant.runtimeSettings,
        settleMs: args.settleMs,
        overlayTimeoutMs: args.overlayTimeoutMs,
        analyzeTimeoutMs: args.analyzeTimeoutMs,
        activeTabTimeoutMs: args.activeTabTimeoutMs,
        initTimeoutMs: args.initTimeoutMs
      });
    }

    const report = buildReport(matrix, variantResults, {
      control: controlBuild,
      defuddle: defuddleBuild,
      variants,
      localBackend,
      backendMetadata: await resolveQaBackendMetadata(args, localBackend)
    });

    fs.writeFileSync(
      args.reportJson || DEFAULT_REPORT_JSON,
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8"
    );
    fs.writeFileSync(args.reportMarkdown || DEFAULT_REPORT_MD, buildMarkdownReport(report), "utf8");

    console.log(`Defuddle video QA report written to ${args.reportMarkdown || DEFAULT_REPORT_MD}`);
    console.log(
      `Changed outcomes: ${report.summary.changedOutcomes}/${report.summary.total} | Defuddle direct wins: ${report.summary.defuddleDirectWins} | Transcript regressions: ${report.summary.transcriptRegressions}`
    );
    if (report.summary.backendConfigured) {
      console.log(
        `Backend rescues: control ${report.summary.backendControlRescues || 0} | defuddle ${report.summary.backendDefuddleRescues || 0}`
      );
    }
  } finally {
    if (localBackend?.server) {
      await new Promise((resolve) => {
        localBackend.server.close(() => resolve());
      });
    }
  }
}

function buildVariant(enableDefuddleExperiment, stagingDir) {
  return withEnvironment(
    {
      SCRIPTLENS_ENABLE_DEFUDDLE_EXPERIMENT: enableDefuddleExperiment ? "true" : "false"
    },
    () => buildExtension(ROOT_DIR, { stagingDir })
  );
}

function buildVariantPlan(input) {
  const includeBackend = Boolean(input?.includeBackend);
  const backendEndpoint = String(input?.backendEndpoint || "").trim();
  const plan = [
    {
      key: "control",
      label: "control",
      extensionPath: input.controlBuild.stagingDir,
      buildKey: "control",
      runtimeSettings: {
        allowBackendTranscriptFallback: false,
        backendTranscriptEndpoint: ""
      }
    },
    {
      key: "defuddle",
      label: "defuddle",
      extensionPath: input.defuddleBuild.stagingDir,
      buildKey: "defuddle",
      runtimeSettings: {
        allowBackendTranscriptFallback: false,
        backendTranscriptEndpoint: ""
      }
    }
  ];

  if (!includeBackend) {
    return plan;
  }

  plan.push(
    {
      key: "backendControl",
      label: "backend-control",
      extensionPath: input.controlBuild.stagingDir,
      buildKey: "control",
      runtimeSettings: {
        allowBackendTranscriptFallback: true,
        backendTranscriptEndpoint: backendEndpoint
      }
    },
    {
      key: "backendDefuddle",
      label: "backend-defuddle",
      extensionPath: input.defuddleBuild.stagingDir,
      buildKey: "defuddle",
      runtimeSettings: {
        allowBackendTranscriptFallback: true,
        backendTranscriptEndpoint: backendEndpoint
      }
    }
  );

  return plan;
}

function withEnvironment(overrides, callback) {
  const previousValues = {};

  for (const [key, value] of Object.entries(overrides || {})) {
    previousValues[key] = Object.prototype.hasOwnProperty.call(process.env, key)
      ? process.env[key]
      : undefined;
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }

  try {
    return callback();
  } finally {
    for (const [key, value] of Object.entries(previousValues)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function loadMatrix(matrixPath, options) {
  const raw = fs.readFileSync(matrixPath, "utf8");
  let entries = JSON.parse(raw);

  if (!Array.isArray(entries)) {
    throw new Error(`Expected an array at ${matrixPath}`);
  }

  if (options.canaryOnly) {
    entries = entries.filter((entry) => entry.canary);
  }

  if (options.ids.size) {
    entries = entries.filter((entry) => options.ids.has(entry.id));
  }

  if (options.categories.size) {
    entries = entries.filter((entry) => {
      const values = []
        .concat(entry.category || [])
        .concat(Array.isArray(entry.categories) ? entry.categories : []);
      return values.some((value) => options.categories.has(normalizeKey(value)));
    });
  }

  if (Number.isFinite(options.limit) && options.limit > 0) {
    entries = entries.slice(0, options.limit);
  }

  return entries;
}

async function runVariant(entries, options) {
  const extensionPath = path.resolve(options.extensionPath);
  const userDataDir = path.join(
    ROOT_DIR,
    "test-results",
    `defuddle-video-qa-${options.variant}-${Date.now()}`
  );
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

    const extensionId = new URL(serviceWorker.url()).host;

    await saveExtensionSettings(serviceWorker, {
      allowBackendTranscriptFallback:
        options.runtimeSettings?.allowBackendTranscriptFallback === true,
      backendTranscriptEndpoint:
        options.runtimeSettings?.backendTranscriptEndpoint || "",
      clientInstanceId: `defuddle-video-qa-${options.variant}-${Date.now()}`
    });

    const results = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      console.log(`[${options.variant}] ${index + 1}/${entries.length} ${entry.id}`);
      results.push(
        await runMatrixEntry(entry, {
          context,
          extensionId,
          serviceWorker,
          settleMs: options.settleMs,
          overlayTimeoutMs: options.overlayTimeoutMs,
          analyzeTimeoutMs: options.analyzeTimeoutMs,
          activeTabTimeoutMs: options.activeTabTimeoutMs,
          initTimeoutMs: options.initTimeoutMs
        })
      );
    }

    return results;
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

async function runMatrixEntry(entry, options) {
  const startedAt = Date.now();
  let videoPage = null;
  let popupPage = null;

  try {
    videoPage = await options.context.newPage();
    const youtubeiTrace = attachYoutubeiTrace(videoPage);
    await gotoVideoWithRetry(videoPage, entry.url);
    await videoPage.bringToFront();
    await videoPage.waitForTimeout(options.settleMs);

    const overlay = videoPage.locator(ROOT_ID);
    await overlay.waitFor({
      state: "visible",
      timeout: options.overlayTimeoutMs
    });
    const bootstrapBefore = await readYouTubeBootstrap(videoPage);

    const targetTab = await waitForActiveTabInfo(
      options.serviceWorker,
      (tab) => Boolean(tab?.url && extractVideoIdFromUrl(tab.url) === entry.videoId),
      options.activeTabTimeoutMs
    );

    popupPage = await options.context.newPage();
    popupPage.setDefaultTimeout(options.analyzeTimeoutMs);
    await popupPage.goto(
      `chrome-extension://${options.extensionId}/popup.html?targetTabId=${targetTab.id}&targetWindowId=${targetTab.windowId}`,
      { waitUntil: "domcontentloaded" }
    );
    const preflight = await requestPopupInit(popupPage, {
      tabId: targetTab.id,
      windowId: targetTab.windowId,
      timeoutMs: options.initTimeoutMs
    });

    const response = await requestPopupAnalysis(popupPage, {
      tabId: targetTab.id,
      windowId: targetTab.windowId,
      request: DEFAULT_REQUEST,
      timeoutMs: options.analyzeTimeoutMs
    });
    const bootstrapAfter = await readYouTubeBootstrap(videoPage);

    return summarizeResponse(entry, response, Date.now() - startedAt, preflight, {
      bootstrapBefore,
      bootstrapAfter,
      youtubeiTrace: youtubeiTrace.read()
    });
  } catch (error) {
    return {
      id: entry.id,
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: error?.message || String(error),
      transportError: true
    };
  } finally {
    if (popupPage) {
      await popupPage.close().catch(() => {});
    }
    if (videoPage) {
      await videoPage.close().catch(() => {});
    }
  }
}

async function requestPopupAnalysis(popupPage, payload) {
  return await popupPage.evaluate(async ({ tabId, windowId, request, timeoutMs }) => {
    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          ok: false,
          error: `Timed out after ${timeoutMs}ms while waiting for popup:analyze.`,
          timeout: true
        });
      }, timeoutMs);
    });

    const responsePromise = chrome.runtime
      .sendMessage({
        type: "popup:analyze",
        tabId,
        windowId,
        request
      })
      .then((response) => {
        if (!response || typeof response !== "object") {
          return {
            ok: false,
            error: "popup:analyze returned an empty response."
          };
        }
        return response;
      })
      .catch((error) => ({
        ok: false,
        error: error?.message || String(error)
      }));

    return await Promise.race([responsePromise, timeoutPromise]);
  }, payload);
}

async function requestPopupInit(popupPage, payload) {
  return await popupPage.evaluate(async ({ tabId, windowId, timeoutMs }) => {
    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          ok: false,
          error: `Timed out after ${timeoutMs}ms while waiting for popup:init.`,
          timeout: true
        });
      }, timeoutMs);
    });

    const responsePromise = chrome.runtime
      .sendMessage({
        type: "popup:init",
        tabId,
        windowId
      })
      .then((response) => {
        if (!response || typeof response !== "object") {
          return {
            ok: false,
            error: "popup:init returned an empty response."
          };
        }
        return response;
      })
      .catch((error) => ({
        ok: false,
        error: error?.message || String(error)
      }));

    return await Promise.race([responsePromise, timeoutPromise]);
  }, payload);
}

function summarizeResponse(entry, response, latencyMs, preflight, pageDebug = {}) {
  const report = response?.report || null;
  const acquisition = report?.acquisition || report?.sourceInfo || {};
  const sourceMeta = report?.sourceMeta || {};
  const contract = report ? Contracts.buildAnalysisContractSnapshot(report) : {};
  const summary = {
    id: entry.id,
    ok: Boolean(response?.ok),
    latencyMs,
    error: response?.ok ? null : response?.error || "Unknown failure",
    timeout: response?.timeout === true,
    score: report?.score ?? null,
    verdict: report?.verdict || "",
    scoringStatus: report?.scoringStatus || null,
    inputQualityLabel:
      report?.inputQuality?.label || report?.quality?.label || null,
    source: report?.source || null,
    explanation: report?.explanation || "",
    contract,
    preflight: summarizePreflight(preflight),
    pageDebug,
    acquisition: {
      kind: acquisition.kind || sourceMeta.kind || null,
      sourceLabel: acquisition.sourceLabel || report?.source || null,
      providerClass: acquisition.providerClass || sourceMeta.providerClass || null,
      strategy: acquisition.strategy || sourceMeta.strategy || null,
      acquisitionState:
        acquisition.acquisitionState || sourceMeta.acquisitionState || null,
      quality: acquisition.quality || sourceMeta.quality || null,
      failureReason:
        acquisition.failureReason || sourceMeta.failureReason || null,
      originKind: acquisition.originKind || sourceMeta.originKind || null,
      recoveryTier: acquisition.recoveryTier || sourceMeta.recoveryTier || null,
      sourceTrustTier:
        acquisition.sourceTrustTier || sourceMeta.sourceTrustTier || null,
      winnerReason: acquisition.winnerReason || sourceMeta.winnerReason || null,
      languageCode: acquisition.languageCode || sourceMeta.languageCode || null,
      warnings: Array.isArray(acquisition.warnings)
        ? acquisition.warnings.slice()
        : [],
      coverageRatio:
        acquisition.coverageRatio ?? sourceMeta.coverageRatio ?? null,
      requestShapeValidation: acquisition.requestShapeValidation || null,
      resolverAttempts: summarizeResolverAttempts(acquisition.resolverAttempts),
      errors: summarizeResolverErrors(acquisition.errors),
      resolverPath: Array.isArray(acquisition.resolverPath)
        ? acquisition.resolverPath.slice()
        : []
    },
    direct: {
      extractor: sourceMeta.extractor || null,
      extractorWarnings: Array.isArray(sourceMeta.extractorWarnings)
        ? sourceMeta.extractorWarnings.slice()
        : [],
      extractorDurationMs: sourceMeta.extractorDurationMs ?? null,
      legacyExtractorDurationMs: sourceMeta.legacyExtractorDurationMs ?? null,
      defuddleExtractorDurationMs: sourceMeta.defuddleExtractorDurationMs ?? null,
      defuddleAttempted: sourceMeta.defuddleAttempted === true
    }
  };

  summary.failureClassification = classifyFailure(summary);
  return summary;
}

async function readYouTubeBootstrap(page) {
  if (!page || page.isClosed()) {
    return null;
  }

  try {
    return await page.evaluate(() => {
      const rawValue =
        document.documentElement?.getAttribute("data-scriptlens-youtube-bootstrap") || "";
      let parsed = null;
      try {
        parsed = rawValue ? JSON.parse(rawValue) : null;
      } catch (error) {
        parsed = null;
      }

      const visibleTranscriptSegments = Array.from(
        document.querySelectorAll(
          "ytd-transcript-segment-renderer, ytd-transcript-search-panel-renderer [data-start-ms]"
        )
      )
        .map((element) => String(element.textContent || "").trim())
        .filter(Boolean).length;

      return {
        rawAvailable: Boolean(rawValue),
        videoId: parsed?.videoId || "",
        transcriptParams: Boolean(parsed?.transcriptParams),
        captionTrackCount: Array.isArray(parsed?.captionTracks) ? parsed.captionTracks.length : 0,
        observedTranscriptRequest: parsed?.observedTranscriptRequest || null,
        updatedAt: parsed?.updatedAt || null,
        visibleTranscriptSegments
      };
    });
  } catch (error) {
    return {
      error: error?.message || String(error)
    };
  }
}

function attachYoutubeiTrace(page) {
  const entries = [];
  const pushEntry = (entry) => {
    if (entries.length >= 6) {
      return;
    }
    entries.push(entry);
  };

  const onRequest = (request) => {
    const url = String(request?.url?.() || "");
    if (!/\/youtubei\/v1\/get_transcript\b/i.test(url)) {
      return;
    }

    pushEntry({
      type: "request",
      url,
      method: request.method(),
      headers: summarizeYoutubeiHeaders(request.headers()),
      postData: truncateText(request.postData() || "", 1200)
    });
  };

  const onResponse = async (response) => {
    const url = String(response?.url?.() || "");
    if (!/\/youtubei\/v1\/get_transcript\b/i.test(url)) {
      return;
    }

    let body = "";
    try {
      body = await response.text();
    } catch (error) {
      body = "";
    }

    pushEntry({
      type: "response",
      url,
      status: response.status(),
      ok: response.ok(),
      headers: summarizeYoutubeiHeaders(await response.allHeaders()),
      body: truncateText(body, 1200)
    });
  };

  page.on("request", onRequest);
  page.on("response", onResponse);

  return {
    read() {
      page.off("request", onRequest);
      page.off("response", onResponse);
      return entries.slice();
    }
  };
}

function summarizeYoutubeiHeaders(headers) {
  const input = headers && typeof headers === "object" ? headers : {};
  const keys = [
    "content-type",
    "x-youtube-client-name",
    "x-youtube-client-version",
    "origin",
    "referer"
  ];
  return keys.reduce((output, key) => {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      output[key] = input[key];
    }
    return output;
  }, {});
}

function truncateText(value, maxLength) {
  const text = String(value || "");
  if (!maxLength || text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}…`;
}

function classifyFailure(result) {
  const signals = [];
  const acquisition = result?.acquisition || {};
  const attempts = Array.isArray(acquisition.resolverAttempts)
    ? acquisition.resolverAttempts
    : [];
  const pageDebug = result?.pageDebug || {};
  const bootstrapAfter = pageDebug?.bootstrapAfter || {};
  const youtubeiTrace = Array.isArray(pageDebug?.youtubeiTrace)
    ? pageDebug.youtubeiTrace
    : [];
  const youtubeiResponse = youtubeiTrace.find((entry) => entry?.type === "response") || null;

  const attemptByStrategy = (strategy) =>
    attempts.find((attempt) => attempt?.strategy === strategy) || null;
  const captionAttempt = attemptByStrategy("caption-track");
  const youtubeiAttempt = attemptByStrategy("youtubei-transcript");
  const domAttempt = attemptByStrategy("dom-transcript");

  if (result?.ok !== true) {
    signals.push("transport_error");
  }
  if (captionAttempt?.errorCode === "caption_fetch_failed") {
    signals.push("caption_track_fetch_failed");
  }
  if (youtubeiAttempt?.errorCode === "youtubei_http_403") {
    signals.push("youtubei_http_403");
  }
  if (
    bootstrapAfter?.observedTranscriptRequest?.responseStatus === 400 ||
    (youtubeiResponse?.status === 400 &&
      /failed_precondition|failedprecondition/i.test(String(youtubeiResponse?.body || "")))
  ) {
    signals.push("youtubei_failed_precondition");
  }
  if (domAttempt?.errorCode === "timeout") {
    signals.push("dom_transcript_timeout");
  }
  if (
    bootstrapAfter?.observedTranscriptRequest &&
    (bootstrapAfter?.visibleTranscriptSegments || 0) === 0
  ) {
    signals.push("dom_transcript_panel_opened_no_segments");
  }
  if (isFallbackTextOnlyResult(result)) {
    signals.push("weak_fallback_only");
  }

  const uniqueSignals = Array.from(new Set(signals));
  const priority = [
    "transport_error",
    "youtubei_failed_precondition",
    "youtubei_http_403",
    "caption_track_fetch_failed",
    "dom_transcript_panel_opened_no_segments",
    "dom_transcript_timeout",
    "weak_fallback_only"
  ];
  const primary = priority.find((code) => uniqueSignals.includes(code)) || null;

  return {
    primary,
    signals: uniqueSignals
  };
}

function summarizeResolverAttempts(attempts) {
  if (!Array.isArray(attempts)) {
    return [];
  }

  return attempts.map((attempt) => ({
    provider: attempt?.provider || null,
    strategy: attempt?.strategy || null,
    ok: attempt?.ok === true,
    skipped: attempt?.skipped === true,
    durationMs: attempt?.durationMs ?? null,
    sourceConfidence: attempt?.sourceConfidence || null,
    warningCodes: Array.isArray(attempt?.warningCodes)
      ? attempt.warningCodes.slice()
      : [],
    errorCode: attempt?.errorCode || null
  }));
}

function summarizeResolverErrors(errors) {
  if (!Array.isArray(errors)) {
    return [];
  }

  return errors.map((error) => ({
    strategy: error?.strategy || null,
    code: error?.code || null,
    message: error?.message || null
  }));
}

function buildReport(entries, variants, builds) {
  const backendControlEnabled = Array.isArray(variants.backendControl);
  const backendDefuddleEnabled = Array.isArray(variants.backendDefuddle);
  const mergedMatrix = entries.map((entry) => {
    const control = variants.control?.find((result) => result.id === entry.id) || null;
    const defuddle = variants.defuddle?.find((result) => result.id === entry.id) || null;
    const backendControl =
      variants.backendControl?.find((result) => result.id === entry.id) || null;
    const backendDefuddle =
      variants.backendDefuddle?.find((result) => result.id === entry.id) || null;
    return {
      ...entry,
      control,
      defuddle,
      backendControl,
      backendDefuddle,
      expectations: {
        control: evaluateVariantExpectation(entry, control, "control", true),
        defuddle: evaluateVariantExpectation(entry, defuddle, "defuddle", true),
        backendControl: evaluateVariantExpectation(
          entry,
          backendControl,
          "backendControl",
          backendControlEnabled
        ),
        backendDefuddle: evaluateVariantExpectation(
          entry,
          backendDefuddle,
          "backendDefuddle",
          backendDefuddleEnabled
        )
      },
      comparison: compareResults(control, defuddle),
      backendComparison: {
        control: compareBackendResults(control, backendControl),
        defuddle: compareBackendResults(defuddle, backendDefuddle)
      }
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    matrixPath: args.matrixPath || DEFAULT_MATRIX_PATH,
    request: DEFAULT_REQUEST,
    filters: {
      canaryOnly: args.canaryOnly,
      ids: Array.from(args.ids),
      categories: Array.from(args.categories),
      limit: Number.isFinite(args.limit) ? args.limit : null,
      includeBackend: args.includeBackend,
      backendLocal: args.backendLocal,
      backendEndpointConfigured: Boolean(args.backendEndpoint)
    },
    backend: builds.localBackend
      ? {
          mode: "local",
          url: builds.localBackend.url,
          port: builds.localBackend.port
        }
      : null,
    backendMetadata: builds.backendMetadata || null,
    builds: {
      control: buildSummaryForBuild(builds.control),
      defuddle: buildSummaryForBuild(builds.defuddle)
    },
    variants: builds.variants.reduce((output, variant) => {
      output[variant.key] = {
        label: variant.label,
        buildKey: variant.buildKey,
        allowBackendTranscriptFallback:
          variant.runtimeSettings?.allowBackendTranscriptFallback === true,
        backendTranscriptEndpointConfigured: Boolean(
          variant.runtimeSettings?.backendTranscriptEndpoint
        )
      };
      return output;
    }, {}),
    summary: summarizeMatrix(mergedMatrix),
    matrix: mergedMatrix
  };
}

async function maybeStartLocalBackend(options) {
  if (!options.includeBackend || !options.backendLocal) {
    return null;
  }

  const port = await findOpenPort();
  return await startBackendServer({
    host: "127.0.0.1",
    port
  });
}

async function resolveQaBackendMetadata(options, localBackend) {
  if (!options.includeBackend) {
    return null;
  }

  const localOrigin = localBackend?.url ? resolveBackendOrigin(localBackend.url) : "";
  const configuredOrigin = resolveBackendOrigin(options.backendEndpoint);
  const origin = localOrigin || configuredOrigin;
  if (!origin) {
    return null;
  }

  return await fetchBackendMetadata(origin);
}

async function findOpenPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!port) {
          reject(new Error("Failed to allocate a local backend port."));
          return;
        }
        resolve(port);
      });
    });
  });
}

function compareResults(control, defuddle) {
  const controlKind = control?.acquisition?.kind || null;
  const defuddleKind = defuddle?.acquisition?.kind || null;
  const controlStrategy = control?.acquisition?.strategy || null;
  const defuddleStrategy = defuddle?.acquisition?.strategy || null;
  const controlLabel = control?.acquisition?.sourceLabel || control?.source || null;
  const defuddleLabel = defuddle?.acquisition?.sourceLabel || defuddle?.source || null;
  const changed =
    Boolean(control?.ok) !== Boolean(defuddle?.ok) ||
    controlKind !== defuddleKind ||
    controlStrategy !== defuddleStrategy ||
    controlLabel !== defuddleLabel;
  const transcriptRegression =
    isTranscriptResult(control) && defuddle?.ok && !isTranscriptResult(defuddle);
  const defuddleDirectWin =
    defuddle?.ok === true &&
    isDirectResult(defuddle) &&
    (control?.ok !== true || controlKind !== defuddleKind || controlLabel !== defuddleLabel);
  const labelingIssue =
    defuddle?.ok === true &&
    !isTranscriptResult(defuddle) &&
    /recovered transcript/i.test(String(defuddleLabel || ""));

  return {
    changed,
    transcriptRegression,
    defuddleDirectWin,
    labelingIssue,
    summary: buildComparisonSummary({
      changed,
      transcriptRegression,
      defuddleDirectWin,
      control,
      defuddle
    })
  };
}

function compareBackendResults(baseResult, backendResult) {
  const changed =
    Boolean(baseResult?.ok) !== Boolean(backendResult?.ok) ||
    (baseResult?.acquisition?.kind || null) !== (backendResult?.acquisition?.kind || null) ||
    (baseResult?.acquisition?.providerClass || null) !==
      (backendResult?.acquisition?.providerClass || null) ||
    (baseResult?.acquisition?.sourceLabel || baseResult?.source || null) !==
      (backendResult?.acquisition?.sourceLabel || backendResult?.source || null);

  return {
    changed,
    backendRescue: isBackendRescue(baseResult, backendResult)
  };
}

function summarizeMatrix(entries) {
  const changedOutcomes = entries.filter((entry) => entry.comparison.changed).length;
  const controlSuccess = entries.filter((entry) => entry.control?.ok).length;
  const defuddleSuccess = entries.filter((entry) => entry.defuddle?.ok).length;
  const controlTranscriptWins = entries.filter((entry) => isTranscriptResult(entry.control)).length;
  const defuddleTranscriptWins = entries.filter((entry) => isTranscriptResult(entry.defuddle)).length;
  const controlFallbackTextOnly = entries.filter((entry) => isFallbackTextOnlyResult(entry.control)).length;
  const defuddleFallbackTextOnly = entries.filter((entry) => isFallbackTextOnlyResult(entry.defuddle)).length;
  const controlPreflightTranscriptAvailable = entries.filter(
    (entry) => entry.control?.preflight?.transcriptAvailable === true
  ).length;
  const defuddlePreflightTranscriptAvailable = entries.filter(
    (entry) => entry.defuddle?.preflight?.transcriptAvailable === true
  ).length;
  const defuddleDirectWins = entries.filter((entry) => entry.comparison.defuddleDirectWin).length;
  const transcriptRegressions = entries.filter(
    (entry) => entry.comparison.transcriptRegression
  ).length;
  const labelingIssues = entries.filter((entry) => entry.comparison.labelingIssue).length;
  const backendConfigured = entries.some(
    (entry) => entry.backendControl || entry.backendDefuddle
  );
  const backendControlSuccess = entries.filter((entry) => entry.backendControl?.ok).length;
  const backendDefuddleSuccess = entries.filter((entry) => entry.backendDefuddle?.ok).length;
  const backendControlTranscriptWins = entries.filter((entry) =>
    isTranscriptResult(entry.backendControl)
  ).length;
  const backendDefuddleTranscriptWins = entries.filter((entry) =>
    isTranscriptResult(entry.backendDefuddle)
  ).length;
  const backendControlRescues = entries.filter((entry) =>
    isBackendRescue(entry.control, entry.backendControl)
  ).length;
  const backendDefuddleRescues = entries.filter((entry) =>
    isBackendRescue(entry.defuddle, entry.backendDefuddle)
  ).length;
  const expectationMismatchCounts = {
    control: entries.filter((entry) => entry.expectations?.control?.matches === false).length,
    defuddle: entries.filter((entry) => entry.expectations?.defuddle?.matches === false).length,
    backendControl: entries.filter((entry) => entry.expectations?.backendControl?.matches === false)
      .length,
    backendDefuddle: entries.filter(
      (entry) => entry.expectations?.backendDefuddle?.matches === false
    ).length
  };

  return {
    total: entries.length,
    controlSuccess,
    defuddleSuccess,
    controlTranscriptWins,
    defuddleTranscriptWins,
    controlFallbackTextOnly,
    defuddleFallbackTextOnly,
    controlPreflightTranscriptAvailable,
    defuddlePreflightTranscriptAvailable,
    changedOutcomes,
    defuddleDirectWins,
    transcriptRegressions,
    labelingIssues,
    backendConfigured,
    backendControlSuccess,
    backendDefuddleSuccess,
    backendControlTranscriptWins,
    backendDefuddleTranscriptWins,
    backendControlRescues,
    backendDefuddleRescues,
    expectationMismatchCounts
  };
}

function buildMarkdownReport(report) {
  const lines = [];
  lines.push("# Defuddle Video QA");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Matrix entries: ${report.summary.total}`);
  lines.push(`- Control successes: ${report.summary.controlSuccess}`);
  lines.push(`- Defuddle successes: ${report.summary.defuddleSuccess}`);
  lines.push(`- Control transcript wins: ${report.summary.controlTranscriptWins}`);
  lines.push(`- Defuddle transcript wins: ${report.summary.defuddleTranscriptWins}`);
  lines.push(`- Control fallback-text-only results: ${report.summary.controlFallbackTextOnly}`);
  lines.push(`- Defuddle fallback-text-only results: ${report.summary.defuddleFallbackTextOnly}`);
  lines.push(
    `- Control preflight transcript-available pages: ${report.summary.controlPreflightTranscriptAvailable}`
  );
  lines.push(
    `- Defuddle preflight transcript-available pages: ${report.summary.defuddlePreflightTranscriptAvailable}`
  );
  lines.push(`- Changed outcomes: ${report.summary.changedOutcomes}`);
  lines.push(`- Defuddle direct wins: ${report.summary.defuddleDirectWins}`);
  lines.push(`- Transcript regressions: ${report.summary.transcriptRegressions}`);
  lines.push(`- Labeling issues: ${report.summary.labelingIssues}`);
  lines.push(
    `- Expectation mismatches: control ${report.summary.expectationMismatchCounts.control}, defuddle ${report.summary.expectationMismatchCounts.defuddle}`
  );
  if (report.summary.backendConfigured) {
    lines.push(`- Backend control successes: ${report.summary.backendControlSuccess}`);
    lines.push(`- Backend defuddle successes: ${report.summary.backendDefuddleSuccess}`);
    lines.push(
      `- Backend control transcript wins: ${report.summary.backendControlTranscriptWins}`
    );
    lines.push(
      `- Backend defuddle transcript wins: ${report.summary.backendDefuddleTranscriptWins}`
    );
    lines.push(`- Backend control rescues: ${report.summary.backendControlRescues}`);
    lines.push(`- Backend defuddle rescues: ${report.summary.backendDefuddleRescues}`);
    lines.push(
      `- Backend expectation mismatches: control ${report.summary.expectationMismatchCounts.backendControl}, defuddle ${report.summary.expectationMismatchCounts.backendDefuddle}`
    );
  }
  lines.push("");
  lines.push("## Changed Cases");
  lines.push("");
  lines.push("| ID | Expected | Control | Defuddle | Delta |");
  lines.push("| --- | --- | --- | --- | --- |");

  const changed = report.matrix.filter((entry) => entry.comparison.changed);
  if (!changed.length) {
    lines.push("| none | - | - | - | no changed outcomes |");
  } else {
    changed.forEach((entry) => {
      lines.push(
        `| ${escapeCell(entry.id)} | ${escapeCell(formatExpectedCell(entry))} | ${escapeCell(formatResultCell(entry.control))} | ${escapeCell(formatResultCell(entry.defuddle))} | ${escapeCell(entry.comparison.summary)} |`
      );
    });
  }

  lines.push("");
  lines.push("## Failures");
  lines.push("");
  lines.push("| ID | Control | Defuddle |");
  lines.push("| --- | --- | --- |");

  const failures = report.matrix.filter((entry) => !entry.control?.ok || !entry.defuddle?.ok);
  if (!failures.length) {
    lines.push("| none | - | - |");
  } else {
    failures.forEach((entry) => {
      lines.push(
        `| ${escapeCell(entry.id)} | ${escapeCell(formatFailureCell(entry.control))} | ${escapeCell(formatFailureCell(entry.defuddle))} |`
      );
    });
  }

  lines.push("");
  lines.push("## Expectation Mismatches");
  lines.push("");
  lines.push("| ID | Variant | Expected | Actual | Notes |");
  lines.push("| --- | --- | --- | --- | --- |");

  const expectationMismatches = collectExpectationMismatches(report.matrix);
  if (!expectationMismatches.length) {
    lines.push("| none | - | - | - | - |");
  } else {
    expectationMismatches.forEach((mismatch) => {
      lines.push(
        `| ${escapeCell(mismatch.id)} | ${escapeCell(mismatch.variant)} | ${escapeCell(mismatch.expected)} | ${escapeCell(mismatch.actual)} | ${escapeCell(mismatch.notes)} |`
      );
    });
  }

  lines.push("");
  lines.push("## Defuddle Direct Wins");
  lines.push("");

  const directWins = report.matrix.filter((entry) => entry.comparison.defuddleDirectWin);
  if (!directWins.length) {
    lines.push("- None");
  } else {
    directWins.forEach((entry) => {
      lines.push(`- ${entry.id}: ${entry.comparison.summary}`);
    });
  }

  lines.push("");
  if (report.summary.backendConfigured) {
    lines.push("## Backend Rescues");
    lines.push("");
    const backendRescues = report.matrix.filter(
      (entry) =>
        entry.backendComparison?.control?.backendRescue ||
        entry.backendComparison?.defuddle?.backendRescue
    );
    if (!backendRescues.length) {
      lines.push("- None");
    } else {
      backendRescues.forEach((entry) => {
        if (entry.backendComparison?.control?.backendRescue) {
          lines.push(`- ${entry.id}: backend rescued the control variant.`);
        }
        if (entry.backendComparison?.defuddle?.backendRescue) {
          lines.push(`- ${entry.id}: backend rescued the Defuddle variant.`);
        }
      });
    }
    lines.push("");
  }

  return lines.join("\n");
}

function buildSummaryForBuild(build) {
  return {
    version: build?.manifest?.version || null,
    stagingDir: build?.stagingDir || "",
    enableDefuddleExperiment: build?.runtimeConfig?.enableDefuddleExperiment === true
  };
}

function summarizePreflight(response) {
  const pageContext = response?.pageContext || {};
  const video = pageContext?.video || {};
  const transcriptTracks = Array.isArray(video.transcriptTracks)
    ? video.transcriptTracks
    : [];

  return {
    ok: Boolean(response?.ok),
    supported: Boolean(pageContext?.supported),
    isYouTubeVideo: Boolean(pageContext?.isYouTubeVideo),
    transcriptAvailable: Boolean(
      pageContext?.transcriptAvailable || video?.availableSources?.transcript
    ),
    transcriptTrackCount: transcriptTracks.length,
    defaultTrackBaseUrl: video?.defaultTrackBaseUrl || "",
    availableSources: video?.availableSources || {},
    error: response?.ok ? null : response?.error || null
  };
}

function buildComparisonSummary(input) {
  if (input.defuddleDirectWin) {
    return "Defuddle direct content replaced the control outcome.";
  }
  if (input.transcriptRegression) {
    return "Transcript result regressed to non-transcript content.";
  }
  if (input.changed) {
    return `${formatResultCell(input.control)} -> ${formatResultCell(input.defuddle)}`;
  }
  return "No material change.";
}

function formatResultCell(result) {
  if (!result) {
    return "missing";
  }
  if (!result.ok) {
    return `error:${result.error || "unknown"}`;
  }
  const label = result.acquisition?.sourceLabel || result.source || "ok";
  const kind = result.acquisition?.kind || "unknown";
  return `${kind}:${label}`;
}

function formatFailureCell(result) {
  if (!result) {
    return "missing";
  }
  if (result.ok) {
    return "ok";
  }
  const failureCode =
    result.failureClassification?.primary ||
    result.acquisition?.failureReason ||
    (result.transportError ? "transport_error" : "");
  return [failureCode, result.error || "unknown"].filter(Boolean).join(": ");
}

function evaluateVariantExpectation(entry, result, variantKey, variantEnabled = true) {
  if (!variantEnabled) {
    return null;
  }
  const expected = describeExpectedOutcome(entry, variantKey);
  if (!expected) {
    return null;
  }

  return {
    expected,
    matches: doesResultMatchExpected(entry, result, variantKey),
    actual: describeActualOutcome(result)
  };
}

function describeExpectedOutcome(entry, variantKey) {
  const winnerClass = entry?.expectedWinnerClass || "";
  const localBehavior = entry?.expectedLocalBehavior || "";
  const backendBehavior = entry?.expectedBackendBehavior || "";
  const defuddleBehavior = entry?.expectedDefuddleBehavior || "";

  if (variantKey === "control") {
    if (localBehavior === "prefer-local-transcript") {
      return "transcript-class";
    }
    if (localBehavior === "weak-fallback-acceptable") {
      return "direct-or-fallback";
    }
  }

  if (variantKey === "defuddle") {
    if (defuddleBehavior === "no-direct-win-when-transcript-succeeds") {
      return "transcript-class";
    }
    if (defuddleBehavior === "direct-content-upgrade-preferred") {
      return "direct-or-fallback";
    }
  }

  if (variantKey === "backendControl" || variantKey === "backendDefuddle") {
    if (backendBehavior === "backend-only-if-local-misses") {
      return "transcript-class";
    }
    if (backendBehavior === "backend-transcript-acceptable") {
      return "transcript-or-direct-or-fallback";
    }
  }

  if (winnerClass === "transcript-class") {
    return "transcript-class";
  }
  if (winnerClass === "direct-content") {
    return "direct-or-fallback";
  }

  return null;
}

function doesResultMatchExpected(entry, result, variantKey) {
  const expected = describeExpectedOutcome(entry, variantKey);
  if (!expected) {
    return null;
  }
  if (!result || result.ok !== true) {
    return false;
  }

  if (expected === "transcript-class") {
    return isTranscriptResult(result);
  }
  if (expected === "direct-or-fallback") {
    return isDirectResult(result) || isFallbackTextOnlyResult(result);
  }
  if (expected === "transcript-or-direct-or-fallback") {
    return (
      isTranscriptResult(result) || isDirectResult(result) || isFallbackTextOnlyResult(result)
    );
  }

  return null;
}

function describeActualOutcome(result) {
  if (!result) {
    return "missing";
  }
  if (result.ok !== true) {
    return `error:${result.failureClassification?.primary || result.error || "unknown"}`;
  }
  if (isTranscriptResult(result)) {
    return "transcript-class";
  }
  if (isDirectResult(result)) {
    return "direct-content";
  }
  if (isFallbackTextOnlyResult(result)) {
    return "fallback-text-only";
  }
  return result?.acquisition?.kind || "ok";
}

function collectExpectationMismatches(entries) {
  const variants = [
    ["control", "control"],
    ["defuddle", "defuddle"],
    ["backendControl", "backend-control"],
    ["backendDefuddle", "backend-defuddle"]
  ];

  return entries.flatMap((entry) =>
    variants
      .map(([property, label]) => {
        const expectation = entry.expectations?.[property];
        if (!expectation || expectation.matches !== false) {
          return null;
        }
        return {
          id: entry.id,
          variant: label,
          expected: expectation.expected,
          actual: expectation.actual || describeActualOutcome(entry[property]),
          notes:
            entry[property]?.failureClassification?.signals?.join(", ") ||
            entry[property]?.error ||
            ""
        };
      })
      .filter(Boolean)
  );
}

function formatExpectedCell(entry) {
  const parts = [
    entry.expectedWinnerClass || entry.expectedStrategy || "",
    entry.expectedLocalBehavior || ""
  ].filter(Boolean);
  return parts.join(" / ") || "-";
}

function isTranscriptResult(result) {
  return (
    result?.ok === true &&
    result?.acquisition?.kind === "transcript" &&
    !isFallbackTextOnlyResult(result)
  );
}

function isDirectResult(result) {
  return (
    result?.ok === true &&
    (result?.acquisition?.kind === "page-content" ||
      result?.acquisition?.kind === "article-content")
  );
}

function isBackendTranscriptResult(result) {
  return isTranscriptResult(result) && result?.acquisition?.providerClass === "backend";
}

function isBackendRescue(baseResult, backendResult) {
  return isBackendTranscriptResult(backendResult) && !isTranscriptResult(baseResult);
}

function isFallbackTextOnlyResult(result) {
  return (
    result?.ok === true &&
    (result?.acquisition?.acquisitionState === "fallback-text-only" ||
      result?.acquisition?.strategy === "title-description" ||
      result?.contract?.originKind === "fallback_text" ||
      result?.contract?.sourceTrustTier === "fallback-text")
  );
}

function escapeCell(value) {
  return String(value || "").replace(/\|/g, "\\|");
}

async function gotoVideoWithRetry(page, url, attempts = 3) {
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      return;
    } catch (error) {
      lastError = error;
      const message = String(error?.message || "");
      if (!/ERR_NETWORK_CHANGED/i.test(message) || attempt === attempts - 1) {
        throw error;
      }
      await page.waitForTimeout(500);
    }
  }

  throw lastError;
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
      allowBackendTranscriptFallback: false,
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

    throw new Error("Timed out while applying extension settings for Defuddle video QA.");
  }, partialSettings);
}

async function getActiveTabInfo(serviceWorker) {
  return await serviceWorker.evaluate(() => {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs && tabs[0];
        resolve(
          tab
            ? {
                id: tab.id,
                windowId: tab.windowId,
                url: tab.url || "",
                title: tab.title || ""
              }
            : null
        );
      });
    });
  });
}

async function waitForActiveTabInfo(serviceWorker, predicate, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const tab = await getActiveTabInfo(serviceWorker);
    if (predicate(tab)) {
      return tab;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error("Timed out while waiting for the expected active YouTube tab.");
}

function extractVideoIdFromUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("v") || "";
  } catch (error) {
    return "";
  }
}

function parseArgs(argv) {
  const options = {
    matrixPath: "",
    reportJson: "",
    reportMarkdown: "",
    canaryOnly: false,
    limit: null,
    settleMs: DEFAULT_SETTLE_MS,
    overlayTimeoutMs: DEFAULT_OVERLAY_TIMEOUT_MS,
    analyzeTimeoutMs: DEFAULT_ANALYZE_TIMEOUT_MS,
    activeTabTimeoutMs: DEFAULT_ACTIVE_TAB_TIMEOUT_MS,
    initTimeoutMs: DEFAULT_INIT_TIMEOUT_MS,
    includeBackend: false,
    backendLocal: false,
    backendEndpoint: DEFAULT_BACKEND_ENDPOINT,
    ids: new Set(),
    categories: new Set()
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === "--help" || value === "-h") {
      printUsage();
      process.exit(0);
    }
    if (value === "--canary-only") {
      options.canaryOnly = true;
      continue;
    }
    if (value === "--matrix") {
      options.matrixPath = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (value === "--include-backend") {
      options.includeBackend = true;
      continue;
    }
    if (value === "--backend-local") {
      options.includeBackend = true;
      options.backendLocal = true;
      continue;
    }
    if (value === "--backend-endpoint") {
      options.includeBackend = true;
      options.backendEndpoint = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (value === "--report-json") {
      options.reportJson = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (value === "--report-markdown") {
      options.reportMarkdown = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (value === "--limit") {
      options.limit = clampPositiveInteger(argv[index + 1]);
      index += 1;
      continue;
    }
    if (value === "--ids") {
      splitCsv(argv[index + 1]).forEach((item) => options.ids.add(item));
      index += 1;
      continue;
    }
    if (value === "--category" || value === "--categories") {
      splitCsv(argv[index + 1]).forEach((item) => options.categories.add(normalizeKey(item)));
      index += 1;
      continue;
    }
    if (value === "--settle-ms") {
      options.settleMs = clampPositiveInteger(argv[index + 1], DEFAULT_SETTLE_MS);
      index += 1;
      continue;
    }
    if (value === "--overlay-timeout-ms") {
      options.overlayTimeoutMs = clampPositiveInteger(
        argv[index + 1],
        DEFAULT_OVERLAY_TIMEOUT_MS
      );
      index += 1;
      continue;
    }
    if (value === "--analyze-timeout-ms") {
      options.analyzeTimeoutMs = clampPositiveInteger(
        argv[index + 1],
        DEFAULT_ANALYZE_TIMEOUT_MS
      );
      index += 1;
      continue;
    }
    if (value === "--active-tab-timeout-ms") {
      options.activeTabTimeoutMs = clampPositiveInteger(
        argv[index + 1],
        DEFAULT_ACTIVE_TAB_TIMEOUT_MS
      );
      index += 1;
      continue;
    }
    if (value === "--init-timeout-ms") {
      options.initTimeoutMs = clampPositiveInteger(
        argv[index + 1],
        DEFAULT_INIT_TIMEOUT_MS
      );
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${value}`);
  }

  if (options.backendLocal) {
    options.backendEndpoint = "";
  }

  if (options.includeBackend && !options.backendLocal && !String(options.backendEndpoint || "").trim()) {
    throw new Error(
      "Backend compare requested without a backend endpoint. Pass --backend-endpoint, set SCRIPTLENS_BACKEND_ENDPOINT, or use --backend-local."
    );
  }

  return options;
}

function splitCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function clampPositiveInteger(value, fallback = null) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function printUsage() {
  const scriptPath = path.relative(process.cwd(), __filename);
  console.log(`Usage: node ${scriptPath} [options]`);
  console.log("");
  console.log("Options:");
  console.log("  --canary-only              Run only entries marked canary");
  console.log("  --matrix <path>            Override the default Defuddle matrix path");
  console.log("  --ids <id1,id2>            Run only the selected matrix ids");
  console.log("  --category <a,b>           Filter by category or categories entries");
  console.log("  --limit <n>                Limit the number of entries");
  console.log("  --report-json <path>       Override JSON report output");
  console.log("  --report-markdown <path>   Override Markdown report output");
  console.log("  --include-backend          Add backend-enabled variants to the compare run");
  console.log("  --backend-local            Start an in-process local backend for backend variants");
  console.log("  --backend-endpoint <url>   Backend transcript endpoint for backend variants");
  console.log("  --settle-ms <n>            Wait after page load before analysis");
  console.log("  --overlay-timeout-ms <n>   Wait for the YouTube overlay root");
  console.log("  --analyze-timeout-ms <n>   Timeout for popup:analyze");
  console.log("  --active-tab-timeout-ms <n> Timeout while locating the active tab");
  console.log("  --init-timeout-ms <n>      Timeout for popup:init");
}

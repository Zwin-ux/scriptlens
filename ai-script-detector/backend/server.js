const http = require("http");
const {
  resolveBackendCapabilitySnapshot,
  resolveTranscriptRequest,
  DEFAULT_TOTAL_TIMEOUT_MS
} = require("./resolve");
const Contracts = require("../shared/contracts");
const Policy = require("../transcript/policy");
const packageManifest = require("../package.json");

const DEFAULT_PORT = 4317;
const DEFAULT_HOST = "127.0.0.1";
const CLOUD_RUN_DEFAULT_HOST = "0.0.0.0";

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORT,
  createBackendMetadata,
  createBackendState,
  createBackendServer,
  resolveBackendRuntimeConfig,
  startBackendServer
};

function createBackendServer(options = {}) {
  const runtimeConfig = resolveBackendRuntimeConfig(options);
  const policy = Policy.resolvePolicy(runtimeConfig.policyOverrides || {});
  const backendState = options.backendState || createBackendState(policy);
  const metadata = createBackendMetadata(runtimeConfig, options);

  return http.createServer(async (request, response) => {
    applyCorsHeaders(response);

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    const normalizedPath = normalizeRoutePath(url.pathname);
    if (request.method === "GET" && normalizedPath === "/healthz") {
      writeJson(response, 200, {
        ok: true,
        ...metadata
      });
      return;
    }

    if (request.method === "GET" && normalizedPath === "/version") {
      writeJson(response, 200, metadata);
      return;
    }

    if (request.method !== "POST" || normalizedPath !== "/transcript/resolve") {
      writeJson(response, 404, {
        ok: false,
        contractVersion: Contracts.CONTRACT_VERSION,
        failureCategory:
          Contracts.resolveFailureCategory("not_found") || Contracts.FAILURE_CATEGORIES.request,
        errorCode: "not_found",
        errorMessage: "Unsupported route."
      });
      return;
    }

    const controller = new AbortController();
    let releaseRecovery = null;
    const timeoutMs = clampNumber(
      runtimeConfig.totalTimeoutMs,
      1000,
      120000,
      policy.timeouts.backendRequestMs || DEFAULT_TOTAL_TIMEOUT_MS
    );
    const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
    request.on("aborted", () => controller.abort(new Error("client_closed")));
    response.on("close", () => {
      if (!response.writableEnded) {
        controller.abort(new Error("client_closed"));
      }
    });

    try {
      const body = normalizeResolveRequestBody(
        await readJsonBody(request),
        runtimeConfig
      );
      const clientKey = buildClientKey(body, request);
      const cacheKey = buildCacheKey(body, policy);
      const cached = backendState.getCache(cacheKey);
      if (cached) {
        writeJson(response, 200, withCacheTelemetry(cached));
        return;
      }

      const recoveryLease = backendState.beginRecoveryRequest(clientKey);
      if (!recoveryLease.ok) {
        writeJson(
          response,
          recoveryLease.statusCode || 429,
          buildBackendFailureResponse({
            errorCode: recoveryLease.code,
            errorMessage: recoveryLease.message,
            warnings: [recoveryLease.code],
            traceId: String(body?.traceId || "").trim(),
            stageTelemetry: [
              {
                traceId: String(body?.traceId || "").trim(),
                type: "server-gate",
                stage: "request",
                outcome: "rejected",
                errorCode: recoveryLease.code,
                cacheStatus: "miss",
                winnerReason: recoveryLease.code,
                authenticatedModeEnabled: Boolean(runtimeConfig.authenticatedModeEnabled),
                authenticatedAcquisitionUsed: false,
                acquisitionPathUsed: null
              }
            ],
            winnerReason: recoveryLease.code,
            authenticatedModeEnabled: Boolean(runtimeConfig.authenticatedModeEnabled)
          })
        );
        return;
      }
      releaseRecovery = recoveryLease.release;

      const result = await resolveTranscriptRequest(body, {
        ...options,
        totalTimeoutMs:
          body?.allowAutomaticAsr === true
            ? policy.timeouts.backendAsrMs || runtimeConfig.resolveTimeoutMs
            : runtimeConfig.resolveTimeoutMs,
        signal: controller.signal,
        backendState,
        clientKey,
        policyOverrides: runtimeConfig.policyOverrides
      });
      logBackendFailure(body, result);
      backendState.setCache(cacheKey, result);
      writeJson(response, 200, result);
    } catch (error) {
      const statusCode = /invalid json/i.test(String(error?.message || "")) ? 400 : 500;
      writeJson(
        response,
        statusCode,
        buildBackendFailureResponse({
          errorCode: statusCode === 400 ? "invalid_json" : "backend_server_error",
          errorMessage:
            statusCode === 400
              ? "The request body was not valid JSON."
              : error?.message || "The backend transcript server failed.",
          warnings: [statusCode === 400 ? "invalid_json" : "backend_server_error"],
          winnerReason: statusCode === 400 ? "invalid_json" : "backend_server_error",
          authenticatedModeEnabled: Boolean(runtimeConfig.authenticatedModeEnabled)
        })
      );
    } finally {
      clearTimeout(timer);
      if (typeof releaseRecovery === "function") {
        releaseRecovery();
      }
    }
  });
}

async function startBackendServer(options = {}) {
  const runtimeConfig = resolveBackendRuntimeConfig(options);
  const server = createBackendServer(runtimeConfig);
  const host = runtimeConfig.host;
  const port = runtimeConfig.port;

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    server,
    host,
    port,
    url: `http://${host}:${port}/transcript/resolve`
  };
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error("Request body too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on("end", () => {
      const source = Buffer.concat(chunks).toString("utf8").trim();
      if (!source) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(source));
      } catch (error) {
        reject(new Error("invalid json"));
      }
    });

    request.on("error", reject);
  });
}

function applyCorsHeaders(response) {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json; charset=utf-8");
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode);
  response.end(JSON.stringify(payload));
}

function logBackendFailure(requestBody, result) {
  if (!result || result.ok) {
    return;
  }

  const summary = {
    source: "scriptlens-backend",
    type: "resolve-failure",
    traceId: String(result.traceId || requestBody?.traceId || "").trim(),
    url: String(requestBody?.url || "").trim(),
    videoId: String(requestBody?.videoId || "").trim(),
    errorCode: result.errorCode || null,
    failureCategory:
      result.failureCategory ||
      Contracts.resolveFailureCategory(result.errorCode || result.winnerReason) ||
      null,
    winnerReason: result.winnerReason || null,
    stageTelemetry: summarizeStageTelemetryForLog(result.stageTelemetry)
  };

  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

function summarizeStageTelemetryForLog(events) {
  if (!Array.isArray(events)) {
    return [];
  }

  return events.slice(0, 8).map((event) => ({
    stage: event?.stage || "",
    type: event?.type || "stage",
    outcome: event?.outcome || "unknown",
    durationMs: typeof event?.durationMs === "number" ? event.durationMs : null,
    errorCode: event?.errorCode || null,
    winnerReason: event?.winnerReason || null,
    authenticatedModeEnabled:
      typeof event?.authenticatedModeEnabled === "boolean"
        ? event.authenticatedModeEnabled
        : null,
    authenticatedAcquisitionUsed:
      typeof event?.authenticatedAcquisitionUsed === "boolean"
        ? event.authenticatedAcquisitionUsed
        : null,
    acquisitionPathUsed: event?.acquisitionPathUsed || null,
    detail: summarizeLogDetail(event?.detail)
  }));
}

function summarizeLogDetail(detail) {
  if (!detail || typeof detail !== "object") {
    return detail || null;
  }

  const summary = {};
  if (Array.isArray(detail.attempts)) {
    summary.attempts = detail.attempts.slice(0, 3).map((attempt) => ({
      formatPreference: attempt?.formatPreference || null,
      exitCode: typeof attempt?.exitCode === "number" ? attempt.exitCode : null,
      failureKind: attempt?.failureKind || null,
      chosenSubtitleFile: attempt?.chosenSubtitleFile || null,
      stderrTail: truncateLogText(attempt?.stderrTail),
      stdoutTail: truncateLogText(attempt?.stdoutTail)
    }));
  }
  if (Array.isArray(detail.steps)) {
    summary.steps = detail.steps.slice(0, 8).map((step) => ({
      step: step?.step || "",
      outcome: step?.outcome || "unknown",
      durationMs: typeof step?.durationMs === "number" ? step.durationMs : null,
      detail: truncateLogText(JSON.stringify(step?.detail || null))
    }));
  }
  if (Array.isArray(detail.pageSnapshots)) {
    summary.pageSnapshots = detail.pageSnapshots.slice(-3).map((snapshot) => ({
      label: snapshot?.label || "",
      pageState: snapshot?.pageState || null
    }));
  }
  if (Array.isArray(detail.transcriptRequests)) {
    summary.transcriptRequests = detail.transcriptRequests.slice(-3);
  }
  if (detail.lastKnownState) {
    summary.lastKnownState = detail.lastKnownState;
  }
  if (detail.error?.message) {
    summary.error = detail.error.message;
  }
  if (typeof detail.budgetMs === "number") {
    summary.budgetMs = detail.budgetMs;
  }
  if (detail.botGateDetected === true) {
    summary.botGateDetected = true;
  }
  if (detail.audioDownload) {
    summary.audioDownload = {
      selectedAudioFile: detail.audioDownload.selectedAudioFile || null,
      exitCode:
        typeof detail.audioDownload.exitCode === "number"
          ? detail.audioDownload.exitCode
          : null,
      failureKind: detail.audioDownload.failureKind || null,
      stderrTail: truncateLogText(detail.audioDownload.stderrTail),
      stdoutTail: truncateLogText(detail.audioDownload.stdoutTail)
    };
  }
  if (detail.asr) {
    summary.asr = {
      source: detail.asr.source || null,
      exitCode:
        typeof detail.asr.exitCode === "number" ? detail.asr.exitCode : null,
      failureKind: detail.asr.failureKind || null,
      parseResult: detail.asr.parseResult || null,
      model: detail.asr.model || null,
      engine: detail.asr.engine || null,
      stderrTail: truncateLogText(detail.asr.stderrTail),
      stdoutTail: truncateLogText(detail.asr.stdoutTail)
    };
  }

  return Object.keys(summary).length ? summary : detail;
}

function truncateLogText(value, maxLength = 240) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, number));
}

function createBackendMetadata(runtimeConfig, options = {}) {
  return {
    service: "scriptlens-backend",
    version: packageManifest.version || "0.0.0",
    contractVersion: Contracts.CONTRACT_VERSION,
    asrEnabled: Boolean(runtimeConfig.enableAutomaticAsr),
    authenticatedModeEnabled: Boolean(runtimeConfig.authenticatedModeEnabled),
    capabilities: resolveBackendCapabilitySnapshot({
      ...options,
      policyOverrides: runtimeConfig.policyOverrides,
      enableAutomaticAsr: runtimeConfig.enableAutomaticAsr
    })
  };
}

function resolveBackendRuntimeConfig(options = {}) {
  const policyOverrides = resolveBackendPolicyOverrides(options.policyOverrides);
  const resolvedPolicy = Policy.resolvePolicy(policyOverrides);
  return {
    host: resolveBackendHost(options.host),
    port: resolveBackendPort(options.port),
    totalTimeoutMs: clampNumber(
      options.totalTimeoutMs ?? process.env.SCRIPTLENS_BACKEND_TIMEOUT_MS,
      1000,
      120000,
      resolvedPolicy.timeouts.backendRequestMs || DEFAULT_TOTAL_TIMEOUT_MS
    ),
    resolveTimeoutMs: clampNumber(
      options.resolveTimeoutMs,
      1000,
      120000,
      resolvedPolicy.timeouts.backendTranscriptMs || DEFAULT_TOTAL_TIMEOUT_MS
    ),
    enableAutomaticAsr: resolveBooleanOption(
      options.enableAutomaticAsr,
      process.env.SCRIPTLENS_BACKEND_ENABLE_ASR,
      false
    ),
    authenticatedModeEnabled:
      resolveAuthenticatedMode(policyOverrides) !== "disabled" &&
      Boolean(resolveCookieFilePath(policyOverrides)),
    policyOverrides
  };
}

function resolveBackendPolicyOverrides(optionOverrides) {
  const envOverrides = {};

  assignNumberOverride(
    envOverrides,
    ["timeouts", "backendTranscriptMs"],
    process.env.SCRIPTLENS_BACKEND_TRANSCRIPT_TIMEOUT_MS,
    1000,
    120000
  );
  assignNumberOverride(
    envOverrides,
    ["timeouts", "backendAsrMs"],
    process.env.SCRIPTLENS_BACKEND_ASR_TIMEOUT_MS,
    1000,
    180000
  );
  assignNumberOverride(
    envOverrides,
    ["timeouts", "backendStage", "watchPageMs"],
    process.env.SCRIPTLENS_BACKEND_STAGE_STATIC_MS,
    100,
    30000
  );
  assignNumberOverride(
    envOverrides,
    ["timeouts", "backendStage", "youtubeiMs"],
    process.env.SCRIPTLENS_BACKEND_STAGE_YOUTUBEI_MS,
    100,
    30000
  );
  assignNumberOverride(
    envOverrides,
    ["timeouts", "backendStage", "ytDlpMs"],
    process.env.SCRIPTLENS_BACKEND_STAGE_YTDLP_MS,
    100,
    60000
  );
  assignNumberOverride(
    envOverrides,
    ["timeouts", "backendStage", "headlessMs"],
    process.env.SCRIPTLENS_BACKEND_STAGE_HEADLESS_MS,
    100,
    60000
  );
  assignNumberOverride(
    envOverrides,
    ["timeouts", "backendStage", "asrMs"],
    process.env.SCRIPTLENS_BACKEND_STAGE_ASR_MS,
    1000,
    180000
  );
  assignNumberOverride(
    envOverrides,
    ["backend", "headless", "navigationTimeoutMs"],
    process.env.SCRIPTLENS_BACKEND_HEADLESS_NAVIGATION_TIMEOUT_MS,
    1000,
    60000
  );
  assignNumberOverride(
    envOverrides,
    ["backend", "headless", "transcriptWaitMs"],
    process.env.SCRIPTLENS_BACKEND_HEADLESS_TRANSCRIPT_WAIT_MS,
    250,
    30000
  );
  assignNumberOverride(
    envOverrides,
    ["backend", "headless", "settleMs"],
    process.env.SCRIPTLENS_BACKEND_HEADLESS_SETTLE_MS,
    0,
    10000
  );

  const extraLaunchArgs = parseLaunchArgs(process.env.SCRIPTLENS_BACKEND_HEADLESS_EXTRA_ARGS);
  if (extraLaunchArgs.length) {
    assignOverride(envOverrides, ["backend", "headless", "extraLaunchArgs"], extraLaunchArgs);
  }
  assignNumberOverride(
    envOverrides,
    ["backend", "maxVideoLengthSeconds", "automaticAsr"],
    process.env.SCRIPTLENS_BACKEND_ASR_AUTO_MAX_SECONDS,
    60,
    21600
  );
  assignNumberOverride(
    envOverrides,
    ["backend", "maxVideoLengthSeconds", "manualAsr"],
    process.env.SCRIPTLENS_BACKEND_ASR_MANUAL_MAX_SECONDS,
    60,
    21600
  );
  assignNumberOverride(
    envOverrides,
    ["backend", "maxVideoLengthSeconds", "absolute"],
    process.env.SCRIPTLENS_BACKEND_ASR_ABSOLUTE_MAX_SECONDS,
    60,
    21600
  );
  assignBooleanOverride(
    envOverrides,
    ["backend", "allowAutomaticAsrWithoutKnownDuration"],
    process.env.SCRIPTLENS_BACKEND_ASR_ALLOW_UNKNOWN_DURATION
  );
  assignBooleanOverride(
    envOverrides,
    ["backend", "circuitBreaker", "forcedOpen"],
    process.env.SCRIPTLENS_BACKEND_ASR_CIRCUIT_FORCED_OPEN
  );
  assignStringOverride(
    envOverrides,
    ["backend", "auth", "mode"],
    normalizeAuthenticatedMode(
      process.env.SCRIPTLENS_BACKEND_AUTH_MODE || process.env.SCRIPTLENS_BACKEND_AUTHENTICATED_MODE
    )
  );
  assignStringOverride(
    envOverrides,
    ["backend", "auth", "cookieFilePath"],
    process.env.SCRIPTLENS_BACKEND_YOUTUBE_COOKIE_FILE
  );
  assignBooleanOverride(
    envOverrides,
    ["backend", "auth", "useForYtDlp"],
    process.env.SCRIPTLENS_BACKEND_AUTH_USE_YTDLP
  );
  assignBooleanOverride(
    envOverrides,
    ["backend", "auth", "useForBrowserSession"],
    process.env.SCRIPTLENS_BACKEND_AUTH_USE_BROWSER_SESSION
  );

  return mergeObjects(envOverrides, optionOverrides || {});
}

function resolveBackendHost(optionHost) {
  if (typeof optionHost === "string" && optionHost.trim()) {
    return optionHost.trim();
  }
  if (typeof process.env.SCRIPTLENS_BACKEND_HOST === "string" && process.env.SCRIPTLENS_BACKEND_HOST.trim()) {
    return process.env.SCRIPTLENS_BACKEND_HOST.trim();
  }
  if (typeof process.env.HOST === "string" && process.env.HOST.trim()) {
    return process.env.HOST.trim();
  }
  if (process.env.PORT) {
    return CLOUD_RUN_DEFAULT_HOST;
  }
  return DEFAULT_HOST;
}

function resolveBackendPort(optionPort) {
  return clampNumber(
    optionPort ?? process.env.PORT ?? process.env.SCRIPTLENS_BACKEND_PORT,
    1,
    65535,
    DEFAULT_PORT
  );
}

function resolveBooleanOption(optionValue, environmentValue, fallback) {
  if (typeof optionValue === "boolean") {
    return optionValue;
  }

  const normalized = String(environmentValue || "").trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
    return false;
  }
  return fallback;
}

function assignNumberOverride(target, path, sourceValue, min, max) {
  const value = clampNumber(sourceValue, min, max, null);
  if (value === null) {
    return;
  }
  assignOverride(target, path, value);
}

function assignBooleanOverride(target, path, sourceValue) {
  const normalized = String(sourceValue || "").trim().toLowerCase();
  if (!normalized) {
    return;
  }
  if (["true", "1", "yes", "on"].includes(normalized)) {
    assignOverride(target, path, true);
    return;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    assignOverride(target, path, false);
  }
}

function assignStringOverride(target, path, sourceValue) {
  const normalized = String(sourceValue || "").trim();
  if (!normalized) {
    return;
  }
  assignOverride(target, path, normalized);
}

function assignOverride(target, path, value) {
  let cursor = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    if (!isPlainObject(cursor[key])) {
      cursor[key] = {};
    }
    cursor = cursor[key];
  }
  cursor[path[path.length - 1]] = value;
}

function parseLaunchArgs(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeAuthenticatedMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  if (["1", "true", "yes", "on", "enabled", "cookie-file", "cookies"].includes(normalized)) {
    return "cookie-file";
  }
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) {
    return "disabled";
  }
  return normalized;
}

function resolveAuthenticatedMode(policyOverrides) {
  const mode = String(policyOverrides?.backend?.auth?.mode || "").trim().toLowerCase();
  return mode || "disabled";
}

function resolveCookieFilePath(policyOverrides) {
  const value = String(policyOverrides?.backend?.auth?.cookieFilePath || "").trim();
  return value || "";
}

function normalizeResolveRequestBody(body, runtimeConfig) {
  return {
    ...(body || {}),
    allowAutomaticAsr: Boolean(runtimeConfig.enableAutomaticAsr) &&
      body?.allowAutomaticAsr !== false
  };
}

function normalizeRoutePath(value) {
  const path = String(value || "").trim() || "/";
  if (path === "/") {
    return path;
  }
  return path.replace(/\/+$/, "") || "/";
}

function mergeObjects(baseValue, overrideValue) {
  if (!isPlainObject(baseValue)) {
    return overrideValue === undefined ? baseValue : overrideValue;
  }

  const result = { ...baseValue };
  Object.keys(overrideValue || {}).forEach((key) => {
    const baseEntry = baseValue[key];
    const overrideEntry = overrideValue[key];
    result[key] = isPlainObject(baseEntry) && isPlainObject(overrideEntry)
      ? mergeObjects(baseEntry, overrideEntry)
      : overrideEntry;
  });
  return result;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function createBackendState(policy) {
  const state = {
    policy,
    cache: new Map(),
    recoveryWindows: new Map(),
    asrWindows: new Map(),
    activeByClient: new Map(),
    activeTranscriptJobs: 0,
    activeAsrJobs: 0,
    asrOutcomes: [],
    asrOpenUntil: 0
  };

  return {
    getCache(cacheKey) {
      pruneCache(state.cache);
      const entry = state.cache.get(cacheKey);
      if (!entry || entry.expiresAt <= Date.now()) {
        state.cache.delete(cacheKey);
        return null;
      }
      return clonePayload(entry.payload);
    },
    setCache(cacheKey, payload) {
      pruneCache(state.cache);
      const ttl = resolveCacheTtl(policy, payload);
      if (!ttl || !payload) {
        return;
      }
      state.cache.set(cacheKey, {
        expiresAt: Date.now() + ttl,
        payload: clonePayload(payload)
      });
    },
    beginRecoveryRequest(clientKey) {
      const now = Date.now();
      const rateLimit = policy.backend.rateLimit.recoveryRequests;
      const transcriptLimit = policy.backend.concurrency.transcriptJobs;
      const perClientLimit = policy.backend.concurrency.perClient;
      const recoveryHits = getActiveWindow(state.recoveryWindows, clientKey, rateLimit.windowMs, now);
      if (recoveryHits.length >= rateLimit.limit) {
        return {
          ok: false,
          statusCode: 429,
          code: "rate_limited",
          message: "Too many transcript recovery requests. Please try again shortly."
        };
      }
      if (state.activeTranscriptJobs >= transcriptLimit) {
        return {
          ok: false,
          statusCode: 503,
          code: "transcript_concurrency_limit",
          message: "Transcript recovery is temporarily saturated. Please try again shortly."
        };
      }
      const activeForClient = state.activeByClient.get(clientKey) || 0;
      if (activeForClient >= perClientLimit) {
        return {
          ok: false,
          statusCode: 429,
          code: "client_concurrency_limit",
          message: "Too many in-flight recoveries for this client."
        };
      }

      recoveryHits.push(now);
      state.recoveryWindows.set(clientKey, recoveryHits);
      state.activeByClient.set(clientKey, activeForClient + 1);
      state.activeTranscriptJobs += 1;

      return {
        ok: true,
        release() {
          state.activeTranscriptJobs = Math.max(0, state.activeTranscriptJobs - 1);
          const current = state.activeByClient.get(clientKey) || 0;
          if (current <= 1) {
            state.activeByClient.delete(clientKey);
          } else {
            state.activeByClient.set(clientKey, current - 1);
          }
        }
      };
    },
    beginAsrStage(clientKey) {
      const circuit = this.getCircuitState();
      if (circuit.open) {
        return {
          ok: false,
          code: "asr_circuit_open",
          message: "Audio ASR is temporarily disabled under load."
        };
      }
      const now = Date.now();
      const asrRateLimit = policy.backend.rateLimit.asrRequests;
      const hits = getActiveWindow(state.asrWindows, clientKey, asrRateLimit.windowMs, now);
      if (hits.length >= asrRateLimit.limit) {
        return {
          ok: false,
          code: "asr_rate_limited",
          message: "Too many ASR attempts for this client."
        };
      }
      if (state.activeAsrJobs >= policy.backend.concurrency.asrJobs) {
        openAsrCircuit(state, policy, "queue_depth");
        return {
          ok: false,
          code: "asr_concurrency_limit",
          message: "Audio ASR capacity is currently full."
        };
      }

      hits.push(now);
      state.asrWindows.set(clientKey, hits);
      state.activeAsrJobs += 1;

      return {
        ok: true,
        release() {
          state.activeAsrJobs = Math.max(0, state.activeAsrJobs - 1);
        }
      };
    },
    recordAsrOutcome(success, code) {
      state.asrOutcomes.push({
        time: Date.now(),
        success: Boolean(success),
        code: code || null
      });
      const breaker = policy.backend.circuitBreaker;
      state.asrOutcomes = state.asrOutcomes.slice(-breaker.rollingWindowSize);
      const sample = state.asrOutcomes;
      if (sample.length >= breaker.minimumSamples) {
        const failureRate =
          sample.filter((entry) => !entry.success).length / Math.max(1, sample.length);
        if (failureRate >= breaker.failureRateOpen) {
          openAsrCircuit(state, policy, "failure_rate");
        }
      }
    },
    getCircuitState() {
      const breaker = policy.backend.circuitBreaker;
      if (breaker.forcedOpen) {
        return { open: true, reason: "forced_open" };
      }
      if (state.activeAsrJobs >= breaker.asrQueueDepthOpen) {
        openAsrCircuit(state, policy, "queue_depth");
      }
      if (state.asrOpenUntil > Date.now()) {
        return { open: true, reason: "open_window" };
      }
      return { open: false, reason: null };
    }
  };
}

function buildClientKey(body, request) {
  const clientInstanceId = String(body?.clientInstanceId || "").trim();
  const ip =
    request.socket?.remoteAddress ||
    request.headers["x-forwarded-for"] ||
    "unknown";
  return clientInstanceId ? `${clientInstanceId}:${ip}` : String(ip);
}

function buildCacheKey(body, policy) {
  const videoId = String(body?.videoId || "").trim() || extractVideoIdFromUrl(body?.url);
  const requestedLanguageCode = String(body?.requestedLanguageCode || "").trim().toLowerCase();
  const analysisMode = String(body?.analysisMode || Policy.ANALYSIS_MODES.youtubeTranscriptFirst);
  const automaticAsr = body?.allowAutomaticAsr === false ? "no-asr" : "asr";
  const durationCap = clampNumber(
    body?.maxAutomaticAsrDurationSeconds,
    60,
    policy.backend.maxVideoLengthSeconds.absolute,
    policy.backend.maxVideoLengthSeconds.automaticAsr
  );
  return [
    "pipeline-v2",
    videoId,
    requestedLanguageCode,
    analysisMode,
    automaticAsr,
    durationCap
  ].join("|");
}

function resolveCacheTtl(policy, payload) {
  if (!payload) {
    return 0;
  }
  if (!payload.ok) {
    return policy.backend.cacheTtlMs.unavailable;
  }
  if (payload.originKind === "audio_asr") {
    return policy.backend.cacheTtlMs.asrSuccess;
  }
  return policy.backend.cacheTtlMs.transcriptSuccess;
}

function withCacheTelemetry(payload) {
  const clone = clonePayload(payload);
  clone.stageTelemetry = [
    {
      traceId: clone.traceId || "",
      type: "cache",
      stage: "cache",
      outcome: "hit",
      cacheStatus: "hit",
      winnerReason: clone.winnerReason || null
    }
  ].concat(Array.isArray(clone.stageTelemetry) ? clone.stageTelemetry : []);
  return clone;
}

function buildBackendFailureResponse(input) {
  return {
    ok: false,
    contractVersion: Contracts.CONTRACT_VERSION,
    failureCategory:
      Contracts.resolveFailureCategory(input.errorCode || input.winnerReason) ||
      Contracts.FAILURE_CATEGORIES.server,
    providerClass: "backend",
    strategy: input.strategy || "backend-transcript",
    sourceLabel: "Backend transcript unavailable",
    sourceConfidence: "low",
    quality: "enhanced-extraction-unavailable",
    recoveryTier: input.recoveryTier || "hosted_transcript",
    originKind: "unavailable",
    sourceTrustTier: "unavailable",
    winnerReason: input.winnerReason || input.errorCode || "backend_server_error",
    languageCode: null,
    originalLanguageCode: null,
    isGenerated: null,
    coverageRatio: null,
    transcriptSpanSeconds: null,
    videoDurationSeconds: null,
    qualityGate: null,
    authenticatedModeEnabled: input.authenticatedModeEnabled === true,
    authenticatedAcquisitionUsed: input.authenticatedAcquisitionUsed === true,
    acquisitionPathUsed: input.acquisitionPathUsed || null,
    traceId: input.traceId || "",
    stageTelemetry: Array.isArray(input.stageTelemetry) ? input.stageTelemetry.slice() : [],
    warnings: Array.isArray(input.warnings) ? input.warnings.slice() : [],
    errorCode: input.errorCode || "backend_server_error",
    errorMessage: input.errorMessage || "The backend transcript server failed.",
    segments: [],
    text: ""
  };
}

function getActiveWindow(store, key, windowMs, now) {
  const items = (store.get(key) || []).filter((timestamp) => now - timestamp < windowMs);
  store.set(key, items);
  return items;
}

function openAsrCircuit(state, policy, _reason) {
  state.asrOpenUntil = Date.now() + policy.backend.circuitBreaker.openMs;
}

function pruneCache(cache) {
  const now = Date.now();
  Array.from(cache.keys()).forEach((key) => {
    if ((cache.get(key)?.expiresAt || 0) <= now) {
      cache.delete(key);
    }
  });
}

function clonePayload(payload) {
  return JSON.parse(JSON.stringify(payload));
}

function extractVideoIdFromUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    if (parsed.pathname === "/watch") {
      return parsed.searchParams.get("v") || "";
    }
  } catch (error) {
    return "";
  }
  return "";
}

if (require.main === module) {
  startBackendServer({
    host: process.env.SCRIPTLENS_BACKEND_HOST || process.env.HOST || undefined,
    port: process.env.PORT || process.env.SCRIPTLENS_BACKEND_PORT || DEFAULT_PORT,
    totalTimeoutMs: process.env.SCRIPTLENS_BACKEND_TIMEOUT_MS || DEFAULT_TOTAL_TIMEOUT_MS,
    enableAutomaticAsr: resolveBooleanOption(
      undefined,
      process.env.SCRIPTLENS_BACKEND_ENABLE_ASR,
      false
    )
  })
    .then((info) => {
      process.stdout.write(`ScriptLens backend listening on ${info.url}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
      process.exitCode = 1;
    });
}

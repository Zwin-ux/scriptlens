import fs from "node:fs";

export function loadJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function resolveBackendOrigin(input) {
  const value = String(input || "").trim();
  if (!value) {
    return "";
  }

  try {
    const parsed = new URL(value);
    if (/\/transcript\/resolve\/?$/i.test(parsed.pathname)) {
      parsed.pathname = "";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString().replace(/\/$/, "");
    }
    return parsed.origin;
  } catch (error) {
    return "";
  }
}

export async function fetchBackendMetadata(input, options = {}) {
  const origin = resolveBackendOrigin(input);
  if (!origin) {
    return null;
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return null;
  }

  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 10000;
  const version = await fetchJsonWithTimeout(fetchImpl, `${origin}/version`, timeoutMs);
  const health = await fetchJsonWithTimeout(fetchImpl, `${origin}/healthz`, timeoutMs);

  return {
    origin,
    fetchedAt: new Date().toISOString(),
    version,
    health
  };
}

async function fetchJsonWithTimeout(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json"
      }
    });
    const body = await response.json().catch(() => null);
    return {
      ok: response.ok,
      status: response.status,
      body
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      error: error?.message || String(error),
      body: null
    };
  } finally {
    clearTimeout(timer);
  }
}

export function evaluateReleaseReadiness(input = {}) {
  const mode = normalizeMode(input.mode);
  const defuddleReport = input.defuddleReport || null;
  const stagedCanaryReport = input.stagedCanaryReport || null;
  const stagedQaReport = input.stagedQaReport || null;
  const backendMetadata =
    input.backendMetadata ||
    stagedQaReport?.backendMetadata ||
    stagedCanaryReport?.backendMetadata ||
    defuddleReport?.backendMetadata ||
    null;
  const backendOrigin =
    input.backendOrigin ||
    backendMetadata?.origin ||
    stagedQaReport?.backendOrigin ||
    stagedCanaryReport?.backendOrigin ||
    "";
  const checks = [
    evaluateDefuddleCheck(defuddleReport, mode),
    evaluateStagedCanaryCheck(stagedCanaryReport, mode),
    evaluateStagedQaCheck(stagedQaReport, mode),
    evaluateBackendCapabilityCheck(backendMetadata, backendOrigin, mode)
  ];
  const score = computeHealthScore(checks);
  const failedChecks = checks.filter((check) => check.status === "fail");
  const warningChecks = checks.filter((check) => check.status === "warn");

  return {
    generatedAt: new Date().toISOString(),
    mode,
    ok: failedChecks.length === 0,
    healthScore: score,
    backendOrigin: backendOrigin || "",
    checks,
    summary: {
      failedChecks: failedChecks.length,
      warningChecks: warningChecks.length,
      passedChecks: checks.filter((check) => check.status === "pass").length
    },
    metrics: {
      defuddle: summarizeDefuddleMetrics(defuddleReport),
      stagedCanary: summarizeStagedMetrics(stagedCanaryReport),
      stagedQa: summarizeStagedMetrics(stagedQaReport),
      backend: summarizeBackendMetrics(backendMetadata)
    }
  };
}

export function buildReleaseReadinessMarkdown(report) {
  const lines = [];
  lines.push("# Release Readiness");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Mode: ${report.mode}`);
  lines.push(`Overall: ${report.ok ? "PASS" : "FAIL"}`);
  lines.push(`Health score: ${report.healthScore}/100`);
  if (report.backendOrigin) {
    lines.push(`Backend origin: ${report.backendOrigin}`);
  }
  lines.push("");
  lines.push("## Checks");
  lines.push("");
  lines.push("| Check | Status | Summary |");
  lines.push("| --- | --- | --- |");

  for (const check of report.checks) {
    lines.push(`| ${escapeCell(check.label)} | ${escapeCell(check.status.toUpperCase())} | ${escapeCell(check.summary)} |`);
  }

  lines.push("");
  lines.push("## Metrics");
  lines.push("");
  lines.push("### Defuddle Corpus");
  lines.push("");
  lines.push(...formatMetricLines(report.metrics.defuddle));
  lines.push("");
  lines.push("### Staged Canary");
  lines.push("");
  lines.push(...formatMetricLines(report.metrics.stagedCanary));
  lines.push("");
  lines.push("### Staged QA");
  lines.push("");
  lines.push(...formatMetricLines(report.metrics.stagedQa));
  lines.push("");
  lines.push("### Backend");
  lines.push("");
  lines.push(...formatMetricLines(report.metrics.backend));

  const failures = report.checks.filter((check) => check.status === "fail");
  if (failures.length) {
    lines.push("");
    lines.push("## Blocking Issues");
    lines.push("");
    failures.forEach((check) => {
      lines.push(`- ${check.label}: ${check.summary}`);
    });
  }

  return lines.join("\n");
}

function evaluateDefuddleCheck(report, mode) {
  if (!report) {
    return buildCheck(
      "defuddle-corpus",
      mode === "public" ? "fail" : "warn",
      "Defuddle corpus gate",
      "Defuddle QA report is missing."
    );
  }

  const summary = report.summary || {};
  const mismatchCount = totalExpectationMismatches(summary.expectationMismatchCounts);
  const failures = [];
  if ((summary.transcriptRegressions || 0) > 0) {
    failures.push(`${summary.transcriptRegressions} transcript regressions`);
  }
  if ((summary.labelingIssues || 0) > 0) {
    failures.push(`${summary.labelingIssues} labeling issues`);
  }
  if (mismatchCount > 0) {
    failures.push(`${mismatchCount} expectation mismatches`);
  }

  return buildCheck(
    "defuddle-corpus",
    failures.length ? "fail" : "pass",
    "Defuddle corpus gate",
    failures.length ? failures.join(", ") : "No transcript regressions, labeling issues, or expectation mismatches.",
    {
      total: summary.total || 0,
      transcriptRegressions: summary.transcriptRegressions || 0,
      labelingIssues: summary.labelingIssues || 0,
      expectationMismatches: mismatchCount
    }
  );
}

function evaluateStagedCanaryCheck(report, mode) {
  if (!report) {
    return buildCheck(
      "staged-canary",
      "fail",
      "Staged canary gate",
      "Staged canary report is missing."
    );
  }

  const summary = report.summary || {};
  const failures = [];
  const warnings = [];
  if (Array.isArray(summary.canaryMismatches) && summary.canaryMismatches.length) {
    failures.push(`${summary.canaryMismatches.length} canary mismatches`);
  }
  if ((summary.backendGoodInlineErrors || 0) > 0) {
    failures.push(`${summary.backendGoodInlineErrors} backend-good inline errors`);
  }
  if ((summary.inlineTransportIssues || 0) > 0) {
    const transportSummary = `${summary.inlineTransportIssues} inline transport issues`;
    if (mode === "public") {
      failures.push(transportSummary);
    } else {
      warnings.push(transportSummary);
    }
  }

  const status = failures.length ? "fail" : warnings.length ? "warn" : "pass";
  const summaryText = failures.concat(warnings).join(", ") || "Canary expectations and inline handoff stayed healthy.";
  return buildCheck("staged-canary", status, "Staged canary gate", summaryText, {
    total: summary.total || 0,
    backendSuccess: summary.backendSuccess || 0,
    canaryMismatches: Array.isArray(summary.canaryMismatches) ? summary.canaryMismatches.length : 0,
    backendGoodInlineErrors: summary.backendGoodInlineErrors || 0,
    inlineTransportIssues: summary.inlineTransportIssues || 0
  });
}

function evaluateStagedQaCheck(report, mode) {
  if (!report) {
    return buildCheck(
      "staged-qa",
      mode === "public" ? "fail" : "warn",
      "Staged full QA gate",
      "Full staged QA report is missing."
    );
  }

  const summary = report.summary || {};
  const backendExpectationFailures = countBackendExpectationFailures(report);
  const failures = [];
  const warnings = [];

  if (backendExpectationFailures > 0) {
    failures.push(`${backendExpectationFailures} backend expectation failures`);
  }
  if ((summary.backendGoodInlineErrors || 0) > 0) {
    failures.push(`${summary.backendGoodInlineErrors} backend-good inline errors`);
  }
  if ((summary.inlineMeasured || 0) > 0 && summary.inlineCompact !== summary.inlineMeasured) {
    failures.push(
      `${summary.inlineMeasured - summary.inlineCompact} inline runs were not compact`
    );
  }
  if ((summary.inlineTransportIssues || 0) > 0) {
    const transportSummary = `${summary.inlineTransportIssues} inline transport issues`;
    if (mode === "public") {
      failures.push(transportSummary);
    } else {
      warnings.push(transportSummary);
    }
  }

  const status = failures.length ? "fail" : warnings.length ? "warn" : "pass";
  const summaryText =
    failures.concat(warnings).join(", ") ||
    "Backend expectations, inline compactness, and handoff signals stayed healthy.";
  return buildCheck("staged-qa", status, "Staged full QA gate", summaryText, {
    total: summary.total || 0,
    backendSuccess: summary.backendSuccess || 0,
    inlineSuccess: summary.inlineSuccess || 0,
    backendExpectationFailures,
    backendGoodInlineErrors: summary.backendGoodInlineErrors || 0,
    inlineMeasured: summary.inlineMeasured || 0,
    inlineCompact: summary.inlineCompact || 0
  });
}

function evaluateBackendCapabilityCheck(metadata, backendOrigin, mode) {
  const isLocal = isLocalOrigin(backendOrigin);
  const missingStatus = !backendOrigin || isLocal ? "warn" : "fail";
  if (!metadata || metadata.version?.body == null) {
    return buildCheck(
      "backend-capabilities",
      missingStatus,
      "Backend capability gate",
      "Backend metadata is missing.",
      {
        origin: backendOrigin || ""
      }
    );
  }

  const version = metadata.version?.body || {};
  const capabilities = version.capabilities || {};
  const failures = [];
  const warnings = [];

  if (!capabilities?.ytDlp?.available) {
    const text = "yt-dlp capability is unavailable";
    if (isLocal || !backendOrigin) {
      warnings.push(text);
    } else {
      failures.push(text);
    }
  }
  if (!version.authenticatedModeEnabled) {
    const text = "authenticated backend mode is disabled";
    if (isLocal || !backendOrigin) {
      warnings.push(text);
    } else {
      failures.push(text);
    }
  }
  if (version.asrEnabled && capabilities?.asr?.configured !== true) {
    failures.push("ASR is enabled but not configured");
  }
  if (!version.asrEnabled) {
    warnings.push("ASR is disabled");
  }

  const status = failures.length ? "fail" : warnings.length ? "warn" : "pass";
  const summaryText =
    failures.concat(warnings).join(", ") ||
    "Backend metadata confirms authenticated yt-dlp capability is available.";
  return buildCheck("backend-capabilities", status, "Backend capability gate", summaryText, {
    origin: backendOrigin || metadata.origin || "",
    authenticatedModeEnabled: Boolean(version.authenticatedModeEnabled),
    asrEnabled: Boolean(version.asrEnabled),
    ytDlpAvailable: Boolean(capabilities?.ytDlp?.available),
    ytDlpSource: capabilities?.ytDlp?.source || null
  });
}

function summarizeDefuddleMetrics(report) {
  const summary = report?.summary || {};
  return {
    total: summary.total || 0,
    transcriptRegressions: summary.transcriptRegressions || 0,
    labelingIssues: summary.labelingIssues || 0,
    expectationMismatches: totalExpectationMismatches(summary.expectationMismatchCounts)
  };
}

function summarizeStagedMetrics(report) {
  const summary = report?.summary || {};
  return {
    total: summary.total || 0,
    backendSuccess: summary.backendSuccess || 0,
    inlineSuccess: summary.inlineSuccess || 0,
    inlineMeasured: summary.inlineMeasured || 0,
    inlineCompact: summary.inlineCompact || 0,
    inlineTransportIssues: summary.inlineTransportIssues || 0,
    backendGoodInlineErrors: summary.backendGoodInlineErrors || 0,
    canaryMismatches: Array.isArray(summary.canaryMismatches) ? summary.canaryMismatches.length : 0,
    backendExpectationFailures: countBackendExpectationFailures(report)
  };
}

function summarizeBackendMetrics(metadata) {
  const version = metadata?.version?.body || {};
  const capabilities = version.capabilities || {};
  return {
    origin: metadata?.origin || "",
    service: version.service || "",
    version: version.version || "",
    authenticatedModeEnabled: Boolean(version.authenticatedModeEnabled),
    asrEnabled: Boolean(version.asrEnabled),
    ytDlpAvailable: Boolean(capabilities?.ytDlp?.available),
    ytDlpSource: capabilities?.ytDlp?.source || null,
    asrConfigured: capabilities?.asr?.configured === true
  };
}

function countBackendExpectationFailures(report) {
  const matrix = Array.isArray(report?.matrix) ? report.matrix : [];
  return matrix.filter((entry) => entry?.backend?.meetsExpectation === false).length;
}

function totalExpectationMismatches(counts) {
  if (!counts || typeof counts !== "object") {
    return 0;
  }
  return Object.values(counts).reduce((sum, value) => {
    const number = Number(value);
    return sum + (Number.isFinite(number) ? number : 0);
  }, 0);
}

function buildCheck(id, status, label, summary, metrics = {}) {
  return {
    id,
    status,
    label,
    summary,
    metrics
  };
}

function normalizeMode(value) {
  return String(value || "canary").trim().toLowerCase() === "public" ? "public" : "canary";
}

function isLocalOrigin(origin) {
  const value = resolveBackendOrigin(origin);
  if (!value) {
    return true;
  }
  try {
    const parsed = new URL(value);
    return ["127.0.0.1", "localhost"].includes(parsed.hostname);
  } catch (error) {
    return true;
  }
}

function computeHealthScore(checks) {
  const score = checks.reduce((total, check) => {
    if (check.status === "fail") {
      return total - 35;
    }
    if (check.status === "warn") {
      return total - 10;
    }
    return total;
  }, 100);
  return Math.max(0, Math.min(100, score));
}

function formatMetricLines(metrics) {
  const entries = Object.entries(metrics || {}).filter(([, value]) => value !== "");
  if (!entries.length) {
    return ["- none"];
  }
  return entries.map(([key, value]) => `- ${key}: ${value}`);
}

function escapeCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|");
}

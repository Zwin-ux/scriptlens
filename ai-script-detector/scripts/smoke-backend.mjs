const DEFAULT_URLS = [
  "https://www.youtube.com/watch?v=NPY2NIS-iao",
  "https://www.youtube.com/watch?v=vWQk67meYUA"
];

const args = parseArgs(process.argv.slice(2));
const endpoint = resolveEndpoint(args.endpoint);
const timeoutMs = Number.isFinite(args.timeoutMs)
  ? args.timeoutMs
  : args.allowAutomaticAsr
  ? 90000
  : 45000;
const urls = args.urls.length ? args.urls : DEFAULT_URLS;
const requireSuccess = Boolean(args.requireSuccess);

if (!endpoint) {
  process.stderr.write("Missing backend endpoint. Pass --endpoint or set SCRIPTLENS_BACKEND_ORIGIN.\n");
  process.exitCode = 1;
} else {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
    process.exitCode = 1;
  });
}

async function main() {
  const results = [];

  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index];
    const traceId = `smoke-${index + 1}-${Date.now()}`;
    const payload = {
      url,
      requestedLanguageCode: args.requestedLanguageCode || "en",
      analysisMode: "youtube-transcript-first",
      allowAutomaticAsr: args.allowAutomaticAsr,
      maxAutomaticAsrDurationSeconds: args.maxAutomaticAsrDurationSeconds || null,
      traceId
    };

    process.stdout.write(`\nURL: ${url}\n`);
    const startedAt = Date.now();
    const response = await fetchWithTimeout(endpoint, payload, timeoutMs);
    const elapsedMs = Date.now() - startedAt;
    const body = response.body;
    const ok = response.ok && body?.ok === true;
    const transcriptClassSuccess = ok && body.originKind !== "unavailable";

    results.push({
      url,
      elapsedMs,
      ok,
      transcriptClassSuccess,
      body
    });

    process.stdout.write(
      `Outcome: ok=${String(body?.ok)} origin=${body?.originKind || "n/a"} recovery=${body?.recoveryTier || "n/a"} trust=${body?.sourceTrustTier || "n/a"} winner=${body?.winnerReason || "n/a"} error=${body?.errorCode || "none"} totalMs=${elapsedMs}\n`
    );

    const events = Array.isArray(body?.stageTelemetry) ? body.stageTelemetry : [];
    if (!events.length) {
      process.stdout.write("Stages: none\n");
      continue;
    }

    process.stdout.write("Stages:\n");
    events.forEach((event) => {
      const line = [
        `  - ${event.stage || "unknown"}`,
        `type=${event.type || "stage"}`,
        `outcome=${event.outcome || "unknown"}`,
        `ms=${event.durationMs ?? "n/a"}`,
        `error=${event.errorCode || "none"}`,
        `winner=${event.winnerReason || "n/a"}`
      ].join(" ");
      process.stdout.write(`${line}\n`);

      const detail = summarizeDetail(event.detail);
      if (detail) {
        process.stdout.write(`    detail=${detail}\n`);
      }
    });
  }

  process.stdout.write(`\nSummary: ${buildSummary(results)}\n`);

  if (requireSuccess) {
    const failed = results.filter((entry) => !entry.transcriptClassSuccess);
    if (failed.length) {
      process.stderr.write(
        `\nBackend smoke failed for ${failed.length} URL(s):\n${failed.map((entry) => `- ${entry.url}`).join("\n")}\n`
      );
      process.exitCode = 1;
    }
  }
}

async function fetchWithTimeout(endpoint, payload, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    let body = null;
    try {
      body = await response.json();
    } catch (error) {
      body = null;
    }

    return {
      ok: response.ok,
      status: response.status,
      body
    };
  } finally {
    clearTimeout(timer);
  }
}

function resolveEndpoint(endpointArg) {
  const direct = String(endpointArg || "").trim();
  if (direct) {
    return direct;
  }

  const origin = String(process.env.SCRIPTLENS_BACKEND_ORIGIN || "").trim();
  if (!origin) {
    return "";
  }
  return origin.replace(/\/+$/, "") + "/transcript/resolve";
}

function parseArgs(argv) {
  const result = {
    endpoint: "",
    timeoutMs: null,
    requireSuccess: false,
    allowAutomaticAsr: false,
    maxAutomaticAsrDurationSeconds: null,
    requestedLanguageCode: "en",
    urls: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--endpoint") {
      result.endpoint = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (value === "--url") {
      if (argv[index + 1]) {
        result.urls.push(argv[index + 1]);
      }
      index += 1;
      continue;
    }
    if (value === "--timeout-ms") {
      result.timeoutMs = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (value === "--requested-language-code") {
      result.requestedLanguageCode = String(argv[index + 1] || "").trim().toLowerCase() || "en";
      index += 1;
      continue;
    }
    if (value === "--max-automatic-asr-duration-seconds") {
      result.maxAutomaticAsrDurationSeconds = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (value === "--allow-automatic-asr") {
      result.allowAutomaticAsr = true;
      continue;
    }
    if (value === "--require-success") {
      result.requireSuccess = true;
    }
  }

  return result;
}

function buildSummary(results) {
  const total = results.length;
  const successes = results.filter((entry) => entry.transcriptClassSuccess);
  const byOrigin = new Map();
  successes.forEach((entry) => {
    const key = entry.body?.originKind || "unknown";
    byOrigin.set(key, (byOrigin.get(key) || 0) + 1);
  });

  const originSummary = Array.from(byOrigin.entries())
    .map(([origin, count]) => `${origin}:${count}`)
    .join(", ");
  return `success=${successes.length}/${total}${originSummary ? ` origins=${originSummary}` : ""}`;
}

function summarizeDetail(detail) {
  if (!detail) {
    return "";
  }

  const parts = [];
  if (Array.isArray(detail.attempts)) {
    parts.push(
      `attempts=${detail.attempts
        .map((attempt) => {
          const label = attempt.formatPreference || "unknown";
          const code = attempt.exitCode ?? "n/a";
          const chosen = attempt.chosenSubtitleFile || "none";
          const failure = attempt.failureKind || "success";
          return `${label}:${code}:${chosen}:${failure}`;
        })
        .join(",")}`
    );
  }
  if (Array.isArray(detail.steps)) {
    parts.push(
      `steps=${detail.steps
        .map((step) => {
          const code = step.detail?.errorCode || "none";
          return `${step.step}:${step.outcome}:${step.durationMs ?? "n/a"}:${code}`;
        })
        .join(",")}`
    );
  }
  if (Array.isArray(detail.pageSnapshots) && detail.pageSnapshots.length) {
    const snapshot = detail.pageSnapshots[detail.pageSnapshots.length - 1];
    const state = snapshot?.pageState || {};
    parts.push(
      `snapshot=${snapshot?.label || "unknown"}:segments=${state.segmentCount ?? "n/a"}:transcriptButtons=${state.transcriptButtons?.total ?? "n/a"}:descButtons=${state.descriptionTranscriptButtons?.total ?? "n/a"}`
    );
  }
  if (Array.isArray(detail.transcriptRequests) && detail.transcriptRequests.length) {
    parts.push(
      `transcriptRequests=${detail.transcriptRequests
        .map((entry) => {
          const status = entry.status ?? "n/a";
          const code = entry.failureCode || "ok";
          return `${status}:${code}`;
        })
        .join(",")}`
    );
  }
  if (detail.lastKnownState?.segmentCount !== undefined) {
    parts.push(`lastSegments=${detail.lastKnownState.segmentCount}`);
  }
  if (detail.launchOptions?.args) {
    parts.push(`launchArgs=${detail.launchOptions.args.join(",")}`);
  }
  if (detail.error?.message) {
    parts.push(`error=${detail.error.message}`);
  }
  if (detail.selectedFormat) {
    parts.push(`selectedFormat=${detail.selectedFormat}`);
  }
  if (detail.chosenSubtitleFile) {
    parts.push(`chosenSubtitleFile=${detail.chosenSubtitleFile}`);
  }

  const fallback = JSON.stringify(detail);
  const text = parts.join(" ");
  if (text) {
    return text;
  }
  return fallback.length <= 400 ? fallback : `${fallback.slice(0, 397)}...`;
}

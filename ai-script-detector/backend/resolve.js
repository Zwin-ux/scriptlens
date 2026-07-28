const { chromium } = require("@playwright/test");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Contracts = require("../shared/contracts");
const Policy = require("../transcript/policy");
const Auth = require("./auth");
const Telemetry = require("./telemetry");

const RECOVERY_POLICY = Policy.resolvePolicy();
const DEFAULT_TOTAL_TIMEOUT_MS =
  RECOVERY_POLICY.timeouts.backendRequestMs || RECOVERY_POLICY.timeouts.backendTranscriptMs;
const STATIC_STAGE_TIMEOUT_MS = RECOVERY_POLICY.timeouts.backendStage.watchPageMs;
const YOUTUBEI_STAGE_TIMEOUT_MS = RECOVERY_POLICY.timeouts.backendStage.youtubeiMs;
const YT_DLP_STAGE_TIMEOUT_MS = RECOVERY_POLICY.timeouts.backendStage.ytDlpMs;
const HEADLESS_STAGE_TIMEOUT_MS = RECOVERY_POLICY.timeouts.backendStage.headlessMs;
const ASR_STAGE_TIMEOUT_MS = RECOVERY_POLICY.timeouts.backendStage.asrMs;
const WATCH_PAGE_HEADERS = {
  "accept-language": "en-US,en;q=0.9",
  "cache-control": "no-cache",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"
};

module.exports = {
  DEFAULT_TOTAL_TIMEOUT_MS,
  HEADLESS_STAGE_TIMEOUT_MS,
  STATIC_STAGE_TIMEOUT_MS,
  YOUTUBEI_STAGE_TIMEOUT_MS,
  YT_DLP_STAGE_TIMEOUT_MS,
  ASR_STAGE_TIMEOUT_MS,
  resolveTranscriptRequest,
  downloadAudioForAsr,
  downloadObservedBrowserSessionMedia,
  pickPreferredTrack,
  parseCaptionPayload,
  resolveAsrCommandConfig,
  resolveBackendCapabilitySnapshot,
  resolveYtDlpCommandConfig,
  selectBrowserSessionMediaCandidate
};

async function resolveTranscriptRequest(input, options = {}) {
  const policy = resolveOperationalPolicy(options.policyOverrides);
  const request = normalizeRequest(input, policy);
  const authConfig = resolveBackendAuthConfig(request.policy);
  const telemetry = [];
  const emit = (event) =>
    emitStageEvent(telemetry, options.onStageEvent, {
      traceId: request.traceId,
      authenticatedModeEnabled: authConfig.enabled,
      ...event
    });

  if (!request.url || !request.videoId) {
    return buildFailurePayload({
      errorCode: "invalid_request",
      errorMessage: "A YouTube video URL or video ID is required.",
      warnings: ["backend_invalid_request"],
      traceId: request.traceId,
      stageTelemetry: telemetry,
      winnerReason: "invalid_request",
      policy: request.policy
    });
  }
  if (request.analysisMode !== Policy.ANALYSIS_MODES.youtubeTranscriptFirst) {
    return buildFailurePayload({
      errorCode: "unsupported_analysis_mode",
      errorMessage: "The backend transcript resolver only supports YouTube transcript-first analysis.",
      warnings: ["unsupported_analysis_mode"],
      traceId: request.traceId,
      stageTelemetry: telemetry,
      winnerReason: "unsupported_analysis_mode",
      policy: request.policy
    });
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return buildFailurePayload({
      errorCode: "fetch_unavailable",
      errorMessage: "The backend runtime does not expose fetch().",
      warnings: ["backend_fetch_unavailable"],
      traceId: request.traceId,
      stageTelemetry: telemetry,
      winnerReason: "fetch_unavailable",
      policy: request.policy
    });
  }

  const totalTimeoutMs = clampNumber(
    options.totalTimeoutMs,
    1000,
    120000,
    request.allowAutomaticAsr
      ? policy.timeouts.backendAsrMs
      : policy.timeouts.backendTranscriptMs
  );
  const deadlineAt = Date.now() + totalTimeoutMs;
  const stageWarnings = [];
  const stageErrors = [];
  let pageData = null;
  let bestResult = null;
  let asrSkippedReason = null;

  const staticStage = await runStage(
    "static-caption-track",
    deadlineAt,
    options.staticStageTimeoutMs || policy.timeouts.backendStage.watchPageMs,
    options.signal,
    (signal) =>
      resolveFromStaticPage(request, {
        fetchImpl,
        signal
      })
  );
  pageData = staticStage.pageData || pageData;
  mergeStage(stageWarnings, stageErrors, staticStage);
  emit({
    type: "stage",
    stage: "static-caption-track",
    startedAt: staticStage.startedAt,
    endedAt: staticStage.endedAt,
    durationMs: staticStage.durationMs,
    outcome: staticStage.ok ? "success" : "failure",
    cacheStatus: "miss",
    errorCode: staticStage.errorCode || null,
    warnings: staticStage.warnings || [],
    candidate: summarizeTelemetryCandidate(staticStage.payload || null),
    detail: staticStage.detail || null
  });
  if (staticStage.ok) {
    bestResult = chooseBestBackendResult(bestResult, staticStage.payload, request);
    if (
      isEligibleBackendResult(bestResult) &&
      isTrustedTranscriptWinner(bestResult)
    ) {
      return finalizeBackendResult(bestResult, {
        traceId: request.traceId,
        warnings: stageWarnings,
        stageTelemetry: telemetry,
        emit,
        policy: request.policy
      });
    }
  }

  const youtubeiStage = await runStage(
    "youtubei-command",
    deadlineAt,
    options.youtubeiStageTimeoutMs || policy.timeouts.backendStage.youtubeiMs,
    options.signal,
    (signal) =>
      resolveFromYoutubei(request, {
        fetchImpl,
        signal,
        pageData
      })
  );
  pageData = youtubeiStage.pageData || pageData;
  mergeStage(stageWarnings, stageErrors, youtubeiStage);
  emit({
    type: "stage",
    stage: "youtubei-command",
    startedAt: youtubeiStage.startedAt,
    endedAt: youtubeiStage.endedAt,
    durationMs: youtubeiStage.durationMs,
    outcome: youtubeiStage.ok ? "success" : "failure",
    cacheStatus: "miss",
    errorCode: youtubeiStage.errorCode || null,
    warnings: youtubeiStage.warnings || [],
    candidate: summarizeTelemetryCandidate(youtubeiStage.payload || null),
    detail: youtubeiStage.detail || null
  });
  if (youtubeiStage.ok) {
    bestResult = chooseBestBackendResult(bestResult, youtubeiStage.payload, request);
    if (
      isEligibleBackendResult(bestResult) &&
      isTrustedTranscriptWinner(bestResult)
    ) {
      return finalizeBackendResult(bestResult, {
        traceId: request.traceId,
        warnings: stageWarnings,
        stageTelemetry: telemetry,
        emit,
        policy: request.policy
      });
    }
  }

  const ytDlpStageDetailRef = { current: null };
  const ytDlpStage = await runStage(
    "yt-dlp-captions",
    deadlineAt,
    options.ytDlpStageTimeoutMs || policy.timeouts.backendStage.ytDlpMs,
    options.signal,
    {
      run: (signal) =>
        resolveFromYtDlp(request, {
          signal,
          pageData,
          ytDlpResolver: options.ytDlpResolver,
          ytDlpCommand: options.ytDlpCommand,
          ytDlpPythonPath: options.ytDlpPythonPath,
          ytDlpPythonCommand: options.ytDlpPythonCommand,
          detailRef: ytDlpStageDetailRef
        }),
      getDetail: () => ytDlpStageDetailRef.current
    }
  );
  pageData = ytDlpStage.pageData || pageData;
  mergeStage(stageWarnings, stageErrors, ytDlpStage);
  emit({
    type: "stage",
    stage: "yt-dlp-captions",
    startedAt: ytDlpStage.startedAt,
    endedAt: ytDlpStage.endedAt,
    durationMs: ytDlpStage.durationMs,
    outcome: ytDlpStage.ok ? "success" : "failure",
    cacheStatus: "miss",
    errorCode: ytDlpStage.errorCode || null,
    warnings: ytDlpStage.warnings || [],
    candidate: summarizeTelemetryCandidate(ytDlpStage.payload || null),
    detail: ytDlpStage.detail || null
  });
  if (ytDlpStage.ok) {
    bestResult = chooseBestBackendResult(bestResult, ytDlpStage.payload, request);
    if (isEligibleBackendResult(bestResult)) {
      return finalizeBackendResult(bestResult, {
        traceId: request.traceId,
        warnings: stageWarnings,
        stageTelemetry: telemetry,
        emit,
        policy: request.policy
      });
    }
  }

  const headlessStageDetailRef = { current: null };
  const headlessStage = await runStage(
    "headless-transcript-panel",
    deadlineAt,
    options.headlessStageTimeoutMs || policy.timeouts.backendStage.headlessMs,
    options.signal,
    {
      run: (signal) =>
        resolveFromHeadless(request, {
          chromiumLauncher: options.chromiumLauncher || chromium,
          signal,
          pageData,
          headlessResolver: options.headlessResolver,
          detailRef: headlessStageDetailRef
        }),
      getDetail: () => headlessStageDetailRef.current
    }
  );
  pageData = headlessStage.pageData || pageData;
  mergeStage(stageWarnings, stageErrors, headlessStage);
  emit({
    type: "stage",
    stage: "headless-transcript-panel",
    startedAt: headlessStage.startedAt,
    endedAt: headlessStage.endedAt,
    durationMs: headlessStage.durationMs,
    outcome: headlessStage.ok ? "success" : "failure",
    cacheStatus: "miss",
    errorCode: headlessStage.errorCode || null,
    warnings: headlessStage.warnings || [],
    candidate: summarizeTelemetryCandidate(headlessStage.payload || null),
    detail: headlessStage.detail || null
  });
  if (headlessStage.ok) {
    bestResult = chooseBestBackendResult(bestResult, headlessStage.payload, request);
  }

  if (isEligibleBackendResult(bestResult)) {
    return finalizeBackendResult(bestResult, {
      traceId: request.traceId,
      warnings: stageWarnings,
      stageTelemetry: telemetry,
      emit,
      policy: request.policy
    });
  }

  const asrDecision = shouldRunAutomaticAsr({
    request,
    policy,
    pageData,
    bestResult,
    backendState: options.backendState,
    clientKey: options.clientKey
  });
  emit({
    type: "asr-decision",
    stage: "audio-asr",
    outcome: asrDecision.allowed ? "eligible" : "skipped",
    circuitState: asrDecision.circuitState || "closed",
    warning: asrDecision.reason || null,
    videoDurationSeconds: pageData?.videoDurationSeconds || null,
    detail: asrDecision.detail || null
  });
  if (asrDecision.allowed) {
    const asrStage = await runStage(
      "audio-asr",
      deadlineAt,
      options.asrStageTimeoutMs || policy.timeouts.backendStage.asrMs,
      options.signal,
      (signal) =>
        resolveFromAsr(request, {
          signal,
          pageData,
          asrResolver: options.asrResolver,
          audioDownloadResolver: options.audioDownloadResolver,
          browserSessionAudioResolver: options.browserSessionAudioResolver,
          asrCommand: options.asrCommand,
          asrArgs: options.asrArgs,
          asrHelperPath: options.asrHelperPath,
          asrPythonCommand: options.asrPythonCommand,
          ytDlpCommand: options.ytDlpCommand,
          ytDlpPythonPath: options.ytDlpPythonPath,
          ytDlpPythonCommand: options.ytDlpPythonCommand,
          chromiumLauncher: options.chromiumLauncher || chromium,
          fetchImpl,
          backendState: options.backendState,
          clientKey: options.clientKey
        })
    );
    mergeStage(stageWarnings, stageErrors, asrStage);
    emit({
      type: "stage",
      stage: "audio-asr",
      startedAt: asrStage.startedAt,
      endedAt: asrStage.endedAt,
      durationMs: asrStage.durationMs,
      outcome: asrStage.ok ? "success" : "failure",
      cacheStatus: "miss",
      errorCode: asrStage.errorCode || null,
      warnings: asrStage.warnings || [],
      candidate: summarizeTelemetryCandidate(asrStage.payload || null),
      circuitState: asrDecision.circuitState || "closed",
      detail: asrStage.detail || null
    });
    if (asrStage.ok) {
      bestResult = chooseBestBackendResult(bestResult, asrStage.payload, request);
    }
  } else {
    asrSkippedReason = asrDecision.reason;
    if (asrSkippedReason) {
      stageWarnings.push(asrSkippedReason);
    }
  }

  if (bestResult && isEligibleBackendResult(bestResult)) {
    return finalizeBackendResult(bestResult, {
      traceId: request.traceId,
      warnings: stageWarnings,
      stageTelemetry: telemetry,
      emit,
      policy: request.policy
    });
  }

  const primaryFailure =
    stageErrors.find((entry) => entry.errorCode === "backend_timeout") ||
    stageErrors.find((entry) => entry.errorCode === "backend_aborted") ||
    (asrSkippedReason
      ? {
          errorCode: asrSkippedReason,
          errorMessage:
            "Transcript and caption recovery were unavailable, and audio ASR was skipped by policy."
        }
      : null) ||
    (!isEligibleBackendResult(bestResult) && bestResult?.qualityGate?.rejectedReasons?.length
      ? {
          errorCode: bestResult.qualityGate.rejectedReasons[0],
          errorMessage: "Recovered transcript text did not meet the scoring quality gate."
        }
      : null) ||
    stageErrors[stageErrors.length - 1] || {
      errorCode: "backend_transcript_unavailable",
      errorMessage: "No transcript-class source was available for this video."
    };

  return buildFailurePayload({
    errorCode: primaryFailure.errorCode,
    errorMessage: primaryFailure.errorMessage,
    warnings: []
      .concat(stageWarnings)
      .concat(bestResult?.warnings || []),
    videoDurationSeconds: pageData?.videoDurationSeconds || null,
    traceId: request.traceId,
    stageTelemetry: telemetry,
    winnerReason: primaryFailure.errorCode,
    policy: request.policy
  });
}

async function runStage(name, deadlineAt, stageTimeoutMs, parentSignal, runner) {
  const runnerConfig = normalizeStageRunner(runner);
  const startedAt = Date.now();
  const remainingMs = Math.max(0, deadlineAt - Date.now());
  if (remainingMs <= 0) {
    return {
      ok: false,
      startedAt,
      endedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      warnings: [`${name}_skipped_timeout`],
      errorCode: "backend_timeout",
      errorMessage: "The backend transcript budget expired before the next stage could run.",
      detail: {
        budgetMs: 0,
        remainingMs
      }
    };
  }

  const budgetMs = Math.max(
    1,
    Math.min(clampNumber(stageTimeoutMs, 100, 20000, remainingMs), remainingMs)
  );
  const controller = new AbortController();
  const cleanupAbort = linkAbortSignal(parentSignal, controller);
  const timeoutHandle = createAbortTimeout(controller, budgetMs);

  try {
    const result = await Promise.race([
      Promise.resolve().then(() => runnerConfig.run(controller.signal)),
      waitForAbort(controller.signal)
    ]);
    const endedAt = Date.now();
    return {
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      ...(result || {
        ok: false,
        warnings: [`${name}_empty`],
        errorCode: "backend_empty",
        errorMessage: "The stage returned no result.",
        detail: {
          budgetMs
        }
      })
    };
  } catch (error) {
    const parentAbortReason = String(parentSignal?.reason?.message || parentSignal?.reason || "");
    const code = controller.signal.aborted && !parentSignal?.aborted
      ? "backend_timeout"
      : parentSignal?.aborted
        ? (/timeout/i.test(parentAbortReason) ? "backend_timeout" : "backend_aborted")
        : "backend_stage_failed";
    const endedAt = Date.now();
    const runnerDetail = code === "backend_timeout"
      ? await waitForStageDetail(runnerConfig.getDetail, Math.min(200, budgetMs))
      : runnerConfig.getDetail();
    return {
      ok: false,
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      warnings: [code, `${name}_failed`],
      errorCode: code,
      errorMessage: error?.message || "The backend transcript stage failed.",
      detail: normalizeTelemetryDetail(
        error?.stageDetail ||
          mergeStageErrorDetail(
            runnerDetail,
            {
              budgetMs,
              error: summarizeError(error)
            }
          )
      )
    };
  } finally {
    clearTimeout(timeoutHandle);
    cleanupAbort();
  }
}

function normalizeStageRunner(runner) {
  if (typeof runner === "function") {
    return {
      run: runner,
      getDetail: () => null
    };
  }

  return {
    run: typeof runner?.run === "function" ? runner.run : () => null,
    getDetail:
      typeof runner?.getDetail === "function"
        ? runner.getDetail
        : () => null
  };
}

async function waitForStageDetail(getDetail, timeoutMs) {
  const readDetail = () =>
    typeof getDetail === "function" ? normalizeTelemetryDetail(getDetail()) : null;
  const immediate = readDetail();
  if (immediate) {
    return immediate;
  }
  const deadlineAt = Date.now() + Math.max(0, timeoutMs || 0);
  while (Date.now() < deadlineAt) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const current = readDetail();
    if (current) {
      return current;
    }
  }
  return readDetail();
}

function mergeStageErrorDetail(currentDetail, fallbackDetail) {
  const current = normalizeTelemetryDetail(currentDetail);
  const fallback = normalizeTelemetryDetail(fallbackDetail);
  if (!current) {
    return fallback;
  }
  if (!fallback || typeof current !== "object" || typeof fallback !== "object") {
    return current;
  }
  return {
    ...current,
    ...fallback
  };
}

function mergeStage(stageWarnings, stageErrors, stageResult) {
  (stageResult?.warnings || []).forEach((warning) => stageWarnings.push(warning));
  if (!stageResult?.ok && stageResult?.errorCode) {
    stageErrors.push({
      errorCode: stageResult.errorCode,
      errorMessage: stageResult.errorMessage || "Transcript resolution failed."
    });
  }
}

async function resolveFromStaticPage(request, options) {
  const response = await options.fetchImpl(request.url, {
    headers: WATCH_PAGE_HEADERS,
    method: "GET",
    signal: options.signal
  });

  if (!response.ok) {
    return {
      ok: false,
      warnings: ["watch_page_fetch_failed"],
      errorCode: `watch_page_http_${response.status}`,
      errorMessage: `The YouTube watch page returned ${response.status}.`
    };
  }

  const html = await response.text();
  const playerResponse = extractAssignedObject(html, [
    "var ytInitialPlayerResponse = ",
    "ytInitialPlayerResponse = ",
    "window[\"ytInitialPlayerResponse\"] = "
  ]);
  const initialData = extractAssignedObject(html, [
    "var ytInitialData = ",
    "ytInitialData = ",
    "window[\"ytInitialData\"] = "
  ]);
  const ytcfg = extractYtcfg(html);
  const pageData = {
    html,
    playerResponse,
    initialData,
    ytcfg,
    videoDurationSeconds: toFiniteNumber(playerResponse?.videoDetails?.lengthSeconds)
  };

  const captionTracks = readCaptionTracks(playerResponse);
  if (!captionTracks.length) {
    return {
      ok: false,
      warnings: ["caption_tracks_missing"],
      errorCode: "caption_tracks_missing",
      errorMessage: "The watch page exposed no caption tracks.",
      pageData
    };
  }

  const track = pickPreferredTrack(captionTracks, request.requestedLanguageCode);
  if (!track?.baseUrl) {
    return {
      ok: false,
      warnings: ["caption_track_unavailable"],
      errorCode: "caption_track_unavailable",
      errorMessage: "No usable caption track could be selected on the watch page.",
      pageData
    };
  }

  const captionPayload = await fetchCaptionTrack(track.baseUrl, {
    fetchImpl: options.fetchImpl,
    signal: options.signal
  });

  if (!captionPayload.text) {
    return {
      ok: false,
      warnings: ["caption_fetch_failed"],
      errorCode: "caption_fetch_failed",
      errorMessage: "Caption tracks were present, but the transcript payload could not be read.",
      pageData
    };
  }

  return {
    ok: true,
    warnings: [],
    pageData,
    payload: buildSuccessPayload({
      text: captionPayload.text,
      segments: captionPayload.segments,
      strategy: "backend-transcript",
      sourceLabel: track.kind === "asr" ? "Backend auto captions" : "Backend caption track",
      sourceConfidence: track.kind === "asr" ? "medium" : "high",
      warnings: []
        .concat(track.kind === "asr" ? ["generated_captions"] : [])
        .concat(["backend_static_caption_track"]),
      languageCode: normalizeLanguage(track.languageCode),
      originalLanguageCode: normalizeLanguage(track.languageCode),
      isGenerated: track.kind === "asr",
      isTranslated: false,
      isMachineTranslated: false,
      videoDurationSeconds: pageData.videoDurationSeconds,
      requestedLanguageCode: request.requestedLanguageCode,
      originKind: track.kind === "asr" ? "generated_caption_track" : "manual_caption_track",
      recoveryTier: "hosted_transcript",
      policy: request.policy
    })
  };
}

async function resolveFromYoutubei(request, options) {
  const pageData = options.pageData || {};
  const apiKey = readInnertubeValue(pageData, "INNERTUBE_API_KEY");
  const clientName = readInnertubeValue(pageData, "INNERTUBE_CONTEXT_CLIENT_NAME") || "WEB";
  const clientVersion = readInnertubeValue(pageData, "INNERTUBE_CONTEXT_CLIENT_VERSION");
  const clientContext = readClientContext(pageData, clientName, clientVersion);
  const transcriptParams = findTranscriptParams(pageData.initialData || pageData.playerResponse);

  if (!apiKey || !clientContext || !clientVersion) {
    return {
      ok: false,
      warnings: ["youtubei_bootstrap_incomplete"],
      errorCode: "youtubei_bootstrap_incomplete",
      errorMessage: "The watch page did not expose enough youtubei metadata for transcript reconstruction.",
      pageData
    };
  }

  if (!transcriptParams) {
    return {
      ok: false,
      warnings: ["youtubei_params_missing"],
      errorCode: "youtubei_params_missing",
      errorMessage: "The watch page did not expose transcript params for youtubei transcript reconstruction.",
      pageData
    };
  }

  const response = await options.fetchImpl(
    `https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false&key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-youtube-client-name": String(clientName),
        "x-youtube-client-version": String(clientVersion)
      },
      signal: options.signal,
      body: JSON.stringify({
        context: clientContext,
        params: transcriptParams
      })
    }
  );

  if (!response.ok) {
    const failure = await readYoutubeiFailure(response);
    return {
      ok: false,
      warnings: failure.warnings,
      errorCode: failure.errorCode,
      errorMessage: failure.errorMessage,
      pageData
    };
  }

  const payload = await response.json();
  const parsed = parseYoutubeiTranscript(payload);
  if (!parsed.text) {
    return {
      ok: false,
      warnings: ["youtubei_empty"],
      errorCode: "youtubei_empty",
      errorMessage: "The youtubei transcript response contained no usable transcript text.",
      pageData
    };
  }

  return {
    ok: true,
    warnings: [],
    pageData,
    payload: buildSuccessPayload({
      text: parsed.text,
      segments: parsed.segments,
      strategy: "backend-transcript",
      sourceLabel: "Backend YouTube transcript",
      sourceConfidence: "medium",
      warnings: ["backend_youtubei_resolver", "youtubei_request_shape_pending_validation"],
      languageCode: normalizeLanguage(parsed.languageCode),
      originalLanguageCode: normalizeLanguage(
        parsed.originalLanguageCode || parsed.languageCode
      ),
      isGenerated: parsed.isGenerated,
      isTranslated: parsed.isTranslated,
      isMachineTranslated: parsed.isMachineTranslated,
      videoDurationSeconds: pageData.videoDurationSeconds || parsed.videoDurationSeconds || null,
      requestedLanguageCode: request.requestedLanguageCode,
      originKind: parsed.isGenerated ? "generated_caption_track" : "youtube_transcript",
      recoveryTier: "hosted_transcript",
      policy: request.policy
    })
  };
}

async function resolveFromYtDlp(request, options) {
  const pageData = options.pageData || {};
  const authConfig = resolveBackendAuthConfig(request.policy);

  if (typeof options.ytDlpResolver === "function") {
    const override = await options.ytDlpResolver({
      request,
      pageData,
      signal: options.signal
    });
    if (!override?.ok) {
      return {
        ok: false,
        warnings: dedupeList([]
          .concat(override?.warnings || [])
          .concat(["yt_dlp_failed"])),
        errorCode: override?.errorCode || "yt_dlp_failed",
        errorMessage: override?.errorMessage || "The yt-dlp transcript fallback failed.",
        pageData,
        detail: normalizeTelemetryDetail(override?.detail || null)
      };
    }

    return {
      ok: true,
      warnings: [],
      pageData,
      detail: normalizeTelemetryDetail(override?.detail || null),
      payload: buildSuccessPayload({
        ...override,
        strategy: override.strategy || "backend-transcript",
        sourceLabel: override.sourceLabel || "Backend yt-dlp transcript",
        sourceConfidence: override.sourceConfidence || "medium",
        warnings: []
          .concat(override.warnings || [])
          .concat(["backend_yt_dlp_fallback"]),
        videoDurationSeconds:
          pageData.videoDurationSeconds || override.videoDurationSeconds || null,
        requestedLanguageCode: request.requestedLanguageCode,
        originKind:
          override.originKind ||
          (override.isGenerated === true ? "generated_caption_track" : "manual_caption_track"),
        recoveryTier: override.recoveryTier || "hosted_transcript",
        policy: request.policy,
        authenticatedModeEnabled:
          override.authenticatedModeEnabled ?? authConfig.enabled,
        authenticatedAcquisitionUsed:
          override.authenticatedAcquisitionUsed === true,
        acquisitionPathUsed: override.acquisitionPathUsed || null
      })
    };
  }

  const commandConfig = resolveYtDlpCommandConfig({
    ...options,
    policy: request.policy
  });
  if (!commandConfig) {
    return {
      ok: false,
      warnings: ["yt_dlp_not_configured"],
      errorCode: "yt_dlp_not_configured",
      errorMessage: "The backend does not have a configured yt-dlp command.",
      pageData,
      detail: {
        commandConfigured: false,
        authenticatedModeEnabled: authConfig.enabled
      }
    };
  }

  const downloaded = await runYtDlpCommand(request, {
    signal: options.signal,
    commandConfig,
    detailRef: options.detailRef
  });

  if (!downloaded.ok) {
    return {
      ok: false,
      warnings: downloaded.warnings || ["yt_dlp_failed"],
      errorCode: downloaded.errorCode || "yt_dlp_failed",
      errorMessage: downloaded.errorMessage || "The yt-dlp transcript fallback failed.",
      pageData,
      detail: downloaded.detail || null
    };
  }

  return {
    ok: true,
    warnings: [],
    pageData,
    detail: downloaded.detail || null,
    payload: buildSuccessPayload({
      text: downloaded.text,
      segments: downloaded.segments,
      strategy: "backend-transcript",
      sourceLabel: "Backend yt-dlp captions",
      sourceConfidence: "medium",
      warnings: []
        .concat(downloaded.warnings || [])
        .concat(["backend_yt_dlp_fallback"]),
      languageCode: normalizeLanguage(
        downloaded.languageCode || request.requestedLanguageCode || "en"
      ),
      originalLanguageCode: normalizeLanguage(
        downloaded.originalLanguageCode ||
          downloaded.languageCode ||
          request.requestedLanguageCode ||
          "en"
      ),
      isGenerated:
        typeof downloaded.isGenerated === "boolean" ? downloaded.isGenerated : null,
      videoDurationSeconds: pageData.videoDurationSeconds || null,
      requestedLanguageCode: request.requestedLanguageCode,
      originKind:
        downloaded.isGenerated === true ? "generated_caption_track" : "manual_caption_track",
      recoveryTier: "hosted_transcript",
      policy: request.policy,
      authenticatedModeEnabled: authConfig.enabled,
      authenticatedAcquisitionUsed: downloaded.authenticatedAcquisitionUsed === true,
      acquisitionPathUsed: downloaded.acquisitionPathUsed || null
    })
  };
}

async function resolveFromHeadless(request, options) {
  const headlessConfig = resolveHeadlessConfig(request.policy);
  const authConfig = resolveBackendAuthConfig(request.policy);
  const headlessDetail = {
    launchOptions: summarizeHeadlessLaunchOptions(headlessConfig),
    steps: [],
    pageSnapshots: [],
    transcriptRequests: [],
    lastKnownState: null
  };
  let authSession = {
    ok: true,
    authenticatedModeEnabled: authConfig.enabled,
    authenticatedAcquisitionUsed: false,
    acquisitionPathUsed: null,
    detail: {
      authenticatedModeEnabled: authConfig.enabled,
      authenticatedAcquisitionUsed: false,
      acquisitionPathUsed: null
    }
  };
  updateStageDetailRef(options.detailRef, headlessDetail);

  if (typeof options.headlessResolver === "function") {
    const override = await options.headlessResolver({
      request,
      pageData: options.pageData || {},
      signal: options.signal,
      headlessDetail
    });
    if (!override?.ok) {
      return {
        ok: false,
        warnings: dedupeList([]
          .concat(override?.warnings || [])
          .concat(["backend_headless_failed"])),
        errorCode: override?.errorCode || "backend_headless_failed",
        errorMessage: override?.errorMessage || "The headless transcript fallback failed.",
        pageData: mergeHeadlessPageData(
          options.pageData,
          override?.pageData,
          headlessDetail,
          override?.videoDurationSeconds
        ),
        detail: normalizeTelemetryDetail(override?.detail || headlessDetail)
      };
    }

    const mergedPageData = mergeHeadlessPageData(
      options.pageData,
      override?.pageData,
      headlessDetail,
      override?.videoDurationSeconds
    );
    return {
      ok: true,
      warnings: [],
      pageData: mergedPageData,
      detail: normalizeTelemetryDetail(override?.detail || headlessDetail),
      payload: buildSuccessPayload({
        ...override,
        strategy: override.strategy || "backend-headless-transcript",
        sourceLabel: override.sourceLabel || "Headless transcript panel",
        sourceConfidence: override.sourceConfidence || "medium",
        warnings: []
          .concat(override.warnings || [])
          .concat(["backend_headless_fallback"]),
        requestedLanguageCode: request.requestedLanguageCode,
        originKind: override.originKind || "headless_transcript",
        recoveryTier: override.recoveryTier || "hosted_transcript",
        policy: request.policy,
        authenticatedModeEnabled:
          override.authenticatedModeEnabled ?? authSession.authenticatedModeEnabled,
        authenticatedAcquisitionUsed:
          override.authenticatedAcquisitionUsed ?? authSession.authenticatedAcquisitionUsed,
        acquisitionPathUsed:
          override.acquisitionPathUsed || authSession.acquisitionPathUsed,
        videoDurationSeconds:
          mergedPageData.videoDurationSeconds ||
          override.videoDurationSeconds ||
          null
      })
    };
  }
  let browser = null;
  let context = null;
  let cleanupAbort = () => {};
  let disposeTranscriptProbe = () => {};

  try {
    const launchStartedAt = Date.now();
    try {
      browser = await options.chromiumLauncher.launch({
        headless: true,
        chromiumSandbox: headlessConfig.chromiumSandbox,
        args: headlessConfig.launchArgs
      });
    } catch (error) {
      if (options.signal?.aborted) {
        error.stageDetail = headlessDetail;
        throw error;
      }
      recordHeadlessStep(headlessDetail, "launch", launchStartedAt, "failure", {
        errorCode: "backend_headless_launch_failed",
        error: summarizeError(error)
      });
      return buildHeadlessFailure(
        "backend_headless_launch_failed",
        "The headless browser failed to launch on this backend instance.",
        options.pageData,
        headlessDetail
      );
    }
    recordHeadlessStep(headlessDetail, "launch", launchStartedAt, "success");
    cleanupAbort = attachBrowserAbort(options.signal, browser);

    context = await browser.newContext({
      locale: "en-US",
      viewport: { width: 1440, height: 1100 },
      userAgent: WATCH_PAGE_HEADERS["user-agent"]
    });
    const authStartedAt = Date.now();
    authSession = await maybeApplyAuthenticatedBrowserSession(context, {
      requestUrl: request.url,
      policy: request.policy
    });
    headlessDetail.authentication = authSession.detail || null;
    recordHeadlessStep(
      headlessDetail,
      "authSession",
      authStartedAt,
      authSession.ok ? "success" : "failure",
      authSession.detail || null
    );

    const page = await context.newPage();
    const transcriptProbe = createHeadlessTranscriptProbe(page, headlessDetail);
    disposeTranscriptProbe = transcriptProbe.dispose;
    const gotoStartedAt = Date.now();
    try {
      await page.goto(request.url, {
        waitUntil: "domcontentloaded",
        timeout: headlessConfig.navigationTimeoutMs
      });
      recordHeadlessStep(headlessDetail, "goto", gotoStartedAt, "success");
      await captureAndRecordHeadlessSnapshot(page, headlessDetail, "after-goto");
    } catch (error) {
      if (options.signal?.aborted) {
        error.stageDetail = headlessDetail;
        throw error;
      }
      recordHeadlessStep(headlessDetail, "goto", gotoStartedAt, "failure", {
        errorCode: "backend_headless_navigation_failed",
        error: summarizeError(error)
      });
      return buildHeadlessFailure(
        "backend_headless_navigation_failed",
        "The headless browser could not load the YouTube watch page.",
        options.pageData,
        headlessDetail
      );
    }

    const consentStartedAt = Date.now();
    try {
      const consentResult = await maybeAcceptConsent(page);
      recordHeadlessStep(headlessDetail, "consent", consentStartedAt, "success", consentResult);
      await captureAndRecordHeadlessSnapshot(page, headlessDetail, "after-consent");
    } catch (error) {
      if (options.signal?.aborted) {
        error.stageDetail = headlessDetail;
        throw error;
      }
      recordHeadlessStep(headlessDetail, "consent", consentStartedAt, "failure", {
        errorCode: "backend_headless_consent_failed",
        error: summarizeError(error)
      });
      return buildHeadlessFailure(
        "backend_headless_consent_failed",
        "The headless browser hit a consent flow it could not complete.",
        options.pageData,
        headlessDetail
      );
    }

    if (headlessConfig.settleMs > 0) {
      await page.waitForTimeout(headlessConfig.settleMs);
    }

    const pageDataStartedAt = Date.now();
    const pageDataTranscript = await requestTranscriptViaAuthenticatedPage(page, request);
    if (pageDataTranscript.ok) {
      const parsed = parseYoutubeiTranscript(pageDataTranscript.payload);
      if (parsed.text) {
        recordHeadlessStep(headlessDetail, "pageDataTranscript", pageDataStartedAt, "success", {
          transcriptParamsFound: pageDataTranscript.detail?.transcriptParamsFound === true,
          responseStatus: pageDataTranscript.detail?.responseStatus || 200,
          segmentCount: Array.isArray(parsed.segments) ? parsed.segments.length : 0,
          languageCode: normalizeLanguage(parsed.languageCode)
        });
        await captureAndRecordHeadlessSnapshot(page, headlessDetail, "page-data-transcript-success");
        return {
          ok: true,
          warnings: [],
          pageData: {
            ...(options.pageData || {}),
            videoDurationSeconds:
              options.pageData?.videoDurationSeconds ||
              pageDataTranscript.videoDurationSeconds ||
              null
          },
          detail: headlessDetail,
          payload: buildSuccessPayload({
            text: parsed.text,
            segments: parsed.segments,
            strategy: "backend-transcript",
            sourceLabel: "Authenticated page transcript",
            sourceConfidence: parsed.isGenerated ? "medium" : "high",
            warnings: ["backend_headless_page_transcript"],
            languageCode: normalizeLanguage(parsed.languageCode),
            originalLanguageCode: normalizeLanguage(
              parsed.originalLanguageCode || parsed.languageCode
            ),
            isGenerated: parsed.isGenerated,
            isTranslated: parsed.isTranslated,
            isMachineTranslated: parsed.isMachineTranslated,
            requestedLanguageCode: request.requestedLanguageCode,
            originKind: parsed.isGenerated ? "generated_caption_track" : "youtube_transcript",
            recoveryTier: "hosted_transcript",
            policy: request.policy,
            authenticatedModeEnabled: authSession.authenticatedModeEnabled,
            authenticatedAcquisitionUsed: authSession.authenticatedAcquisitionUsed,
            acquisitionPathUsed: authSession.acquisitionPathUsed,
            videoDurationSeconds:
              options.pageData?.videoDurationSeconds ||
              pageDataTranscript.videoDurationSeconds ||
              null
          })
        };
      }
      recordHeadlessStep(headlessDetail, "pageDataTranscript", pageDataStartedAt, "failure", {
        errorCode: "backend_headless_page_transcript_empty",
        transcriptParamsFound: pageDataTranscript.detail?.transcriptParamsFound === true,
        responseStatus: pageDataTranscript.detail?.responseStatus || 200
      });
    } else {
      recordHeadlessStep(headlessDetail, "pageDataTranscript", pageDataStartedAt, "failure", {
        errorCode: pageDataTranscript.errorCode,
        responseStatus: pageDataTranscript.detail?.responseStatus || null,
        transcriptParamsFound: pageDataTranscript.detail?.transcriptParamsFound === true,
        error: pageDataTranscript.detail?.error || null,
        bodySnippet: pageDataTranscript.detail?.bodySnippet || null
      });
    }

    const openStartedAt = Date.now();
    let openResult = null;
    try {
      openResult = await withPromiseTimeout(
        openTranscriptPanel(page, { headlessDetail }),
        Math.min(3000, headlessConfig.transcriptWaitMs),
        {
          opened: false,
          route: "timeout",
          attempts: []
        }
      );
    } catch (error) {
      if (options.signal?.aborted) {
        error.stageDetail = headlessDetail;
        throw error;
      }
      await captureAndRecordHeadlessSnapshot(page, headlessDetail, "open-transcript-exception");
      recordHeadlessStep(headlessDetail, "openTranscript", openStartedAt, "failure", {
        errorCode: "backend_headless_panel_failed",
        error: summarizeError(error)
      });
      return buildHeadlessFailure(
        "backend_headless_panel_failed",
        "The headless browser could not open the YouTube transcript controls.",
        options.pageData,
        headlessDetail
      );
    }

    if (!openResult?.opened) {
      await captureAndRecordHeadlessSnapshot(page, headlessDetail, "open-transcript-miss");
      recordHeadlessStep(headlessDetail, "openTranscript", openStartedAt, "failure", {
        errorCode: "backend_headless_panel_failed",
        route: openResult?.route || null,
        expand: openResult?.expand || null,
        attempts: openResult?.attempts || []
      });
      return buildHeadlessFailure(
        "backend_headless_panel_failed",
        "The headless browser could not open the YouTube transcript panel.",
        options.pageData,
        headlessDetail
      );
    }
    recordHeadlessStep(headlessDetail, "openTranscript", openStartedAt, "success", openResult);
    await captureAndRecordHeadlessSnapshot(page, headlessDetail, "after-open-transcript");

    const waitStartedAt = Date.now();
    const waitResult = await waitForHeadlessTranscriptOutcome(
      page,
      transcriptProbe,
      headlessConfig.transcriptWaitMs,
      headlessDetail,
      options.signal
    );
    if (!waitResult.ok) {
      recordHeadlessStep(headlessDetail, "waitSegments", waitStartedAt, "failure", {
        errorCode: waitResult.errorCode,
        timeoutMs: headlessConfig.transcriptWaitMs,
        transcriptRequests: Array.isArray(headlessDetail.transcriptRequests)
          ? headlessDetail.transcriptRequests.length
          : 0,
        pageState: waitResult.pageState || headlessDetail.lastKnownState || null
      });
      return buildHeadlessFailure(
        waitResult.errorCode,
        waitResult.errorMessage,
        options.pageData,
        headlessDetail
      );
    }
    recordHeadlessStep(headlessDetail, "waitSegments", waitStartedAt, "success", {
      timeoutMs: headlessConfig.transcriptWaitMs,
      segmentCount: waitResult.segmentCount
    });
    await captureAndRecordHeadlessSnapshot(page, headlessDetail, "after-wait-segments");

    const extractStartedAt = Date.now();
    let extracted = null;
    try {
      extracted = await page.evaluate(() => {
      const sanitize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const parseTimeLabel = (value) => {
        const text = sanitize(value);
        if (!text) {
          return null;
        }
        const parts = text.split(":").map((part) => Number(part));
        if (parts.some((part) => !Number.isFinite(part))) {
          return null;
        }
        let seconds = 0;
        while (parts.length) {
          seconds = seconds * 60 + parts.shift();
        }
        return seconds * 1000;
      };

      const nodes = Array.from(document.querySelectorAll("ytd-transcript-segment-renderer"));
      const segments = nodes
        .map((node) => {
          const text =
            sanitize(
              node.querySelector("#segment-text")?.textContent ||
                node.querySelector(".segment-text")?.textContent ||
                node.textContent ||
                ""
            );
          if (!text) {
            return null;
          }

          const timeLabel =
            node.querySelector("#segment-timestamp")?.textContent ||
            node.querySelector(".segment-timestamp")?.textContent ||
            "";

          return {
            startMs: parseTimeLabel(timeLabel),
            durationMs: null,
            text
          };
        })
        .filter(Boolean);

      for (let index = 0; index < segments.length - 1; index += 1) {
        const current = segments[index];
        const next = segments[index + 1];
        if (typeof current.startMs === "number" && typeof next.startMs === "number") {
          current.durationMs = Math.max(0, next.startMs - current.startMs);
        }
      }

      const videoDurationSeconds = Number(
        globalThis.ytInitialPlayerResponse?.videoDetails?.lengthSeconds ||
          globalThis.ytplayer?.config?.args?.length_seconds ||
          0
      ) || null;

      return {
        text: sanitize(segments.map((segment) => segment.text).join("\n")),
        segments,
        languageCode: sanitize(document.documentElement.lang || "") || null,
        videoDurationSeconds
      };
      });
    } catch (error) {
      if (options.signal?.aborted) {
        error.stageDetail = headlessDetail;
        throw error;
      }
      await captureAndRecordHeadlessSnapshot(page, headlessDetail, "extract-exception");
      recordHeadlessStep(headlessDetail, "extract", extractStartedAt, "failure", {
        errorCode: "backend_headless_extract_failed",
        error: summarizeError(error)
      });
      return buildHeadlessFailure(
        "backend_headless_extract_failed",
        "The transcript panel rendered, but the backend could not extract the transcript text.",
        options.pageData,
        headlessDetail
      );
    }

    if (!extracted?.text) {
      await captureAndRecordHeadlessSnapshot(page, headlessDetail, "extract-empty");
      recordHeadlessStep(headlessDetail, "extract", extractStartedAt, "failure", {
        errorCode: "backend_headless_extract_failed",
        extractedSegments:
          Array.isArray(extracted?.segments) ? extracted.segments.length : 0
      });
      return buildHeadlessFailure(
        "backend_headless_extract_failed",
        "The transcript panel rendered, but no usable transcript text was extracted.",
        options.pageData,
        headlessDetail
      );
    }
    recordHeadlessStep(headlessDetail, "extract", extractStartedAt, "success", {
      extractedSegments: extracted.segments.length,
      languageCode: normalizeLanguage(extracted.languageCode)
    });
    await captureAndRecordHeadlessSnapshot(page, headlessDetail, "after-extract");

    return {
      ok: true,
      warnings: [],
      pageData: {
        ...(options.pageData || {}),
        videoDurationSeconds:
          options.pageData?.videoDurationSeconds || extracted.videoDurationSeconds || null
      },
      detail: headlessDetail,
      payload: buildSuccessPayload({
        text: extracted.text,
        segments: extracted.segments,
        strategy: "backend-headless-transcript",
        sourceLabel: "Headless transcript panel",
        sourceConfidence: "medium",
        warnings: ["backend_headless_fallback"],
        languageCode: normalizeLanguage(extracted.languageCode),
        originalLanguageCode: normalizeLanguage(extracted.languageCode),
        isGenerated: null,
        isTranslated: false,
        isMachineTranslated: false,
        requestedLanguageCode: request.requestedLanguageCode,
        originKind: "headless_transcript",
        recoveryTier: "hosted_transcript",
        policy: request.policy,
        authenticatedModeEnabled: authSession.authenticatedModeEnabled,
        authenticatedAcquisitionUsed: authSession.authenticatedAcquisitionUsed,
        acquisitionPathUsed: authSession.acquisitionPathUsed,
        videoDurationSeconds:
          options.pageData?.videoDurationSeconds || extracted.videoDurationSeconds || null
      })
    };
  } finally {
    disposeTranscriptProbe();
    cleanupAbort();
    if (context) {
      await context.close().catch(() => {});
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

async function resolveFromAsr(request, options) {
  const releaseAsr =
    typeof options.backendState?.beginAsrStage === "function"
      ? options.backendState.beginAsrStage(options.clientKey)
      : null;
  if (releaseAsr && releaseAsr.ok === false) {
    return {
      ok: false,
      warnings: [releaseAsr.code || "asr_unavailable"],
      errorCode: releaseAsr.code || "asr_unavailable",
      errorMessage: releaseAsr.message || "Audio ASR is temporarily unavailable.",
      pageData: options.pageData || {}
    };
  }

  try {
    const override =
      typeof options.asrResolver === "function"
        ? await options.asrResolver({
            request,
            pageData: options.pageData || {},
            signal: options.signal
          })
        : await runConfiguredAsrPipeline(request, options);
    if (!override?.ok) {
      if (typeof options.backendState?.recordAsrOutcome === "function") {
        options.backendState.recordAsrOutcome(false, override?.errorCode || "asr_failed");
      }
      return {
        ok: false,
        warnings: dedupeList([].concat(override?.warnings || []).concat(["asr_failed"])),
        errorCode: override?.errorCode || "asr_failed",
        errorMessage: override?.errorMessage || "Audio ASR failed to produce a usable transcript.",
        pageData: {
          ...(options.pageData || {}),
          videoDurationSeconds:
            options.pageData?.videoDurationSeconds || override?.videoDurationSeconds || null
        },
        detail: normalizeTelemetryDetail(override?.detail || null)
      };
    }

    if (typeof options.backendState?.recordAsrOutcome === "function") {
      options.backendState.recordAsrOutcome(true, "asr_success");
    }
    return {
      ok: true,
      warnings: [],
      pageData: {
        ...(options.pageData || {}),
        videoDurationSeconds:
          options.pageData?.videoDurationSeconds || override.videoDurationSeconds || null
      },
      detail: normalizeTelemetryDetail(override?.detail || null),
      payload: buildSuccessPayload({
        ...override,
        strategy: override.strategy || "backend-asr",
        sourceLabel: override.sourceLabel || "Audio-derived transcript",
        sourceConfidence: override.sourceConfidence || "low",
        warnings: []
          .concat(override.warnings || [])
          .concat(["backend_audio_asr"]),
        requestedLanguageCode: request.requestedLanguageCode,
        originKind: override.originKind || "audio_asr",
        recoveryTier: override.recoveryTier || "hosted_asr",
        policy: request.policy,
        videoDurationSeconds:
          options.pageData?.videoDurationSeconds || override.videoDurationSeconds || null
      })
    };
  } finally {
    if (typeof releaseAsr?.release === "function") {
      releaseAsr.release();
    }
  }
}

async function runConfiguredAsrPipeline(request, options) {
  const detail = {
    audioDownload: null,
    asr: null
  };
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "scriptlens-asr-"));

  try {
    const downloaded =
      typeof options.audioDownloadResolver === "function"
        ? await options.audioDownloadResolver({
            request,
            pageData: options.pageData || {},
            signal: options.signal,
            tempDir
          })
        : await downloadAudioForAsr(request, {
            signal: options.signal,
            pageData: options.pageData || {},
            outputDir: path.join(tempDir, "audio"),
            fetchImpl: options.fetchImpl || globalThis.fetch,
            chromiumLauncher: options.chromiumLauncher || chromium,
            browserSessionAudioResolver: options.browserSessionAudioResolver,
            commandConfig: resolveYtDlpCommandConfig({
              ytDlpCommand: options.ytDlpCommand,
              ytDlpPythonPath: options.ytDlpPythonPath,
              ytDlpPythonCommand: options.ytDlpPythonCommand,
              policy: request.policy
            })
          });
    detail.audioDownload = normalizeTelemetryDetail(downloaded?.detail || null);
    if (!downloaded?.ok) {
      return {
        ok: false,
        warnings: dedupeList(downloaded?.warnings || []),
        errorCode: downloaded?.errorCode || "asr_audio_download_failed",
        errorMessage:
          downloaded?.errorMessage || "The backend could not acquire audio for ASR recovery.",
        detail,
        videoDurationSeconds:
          downloaded?.videoDurationSeconds || options.pageData?.videoDurationSeconds || null
      };
    }

    const commandConfig = resolveAsrCommandConfig(options);
    if (!commandConfig) {
      return {
        ok: false,
        warnings: ["asr_not_configured"],
        errorCode: "asr_not_configured",
        errorMessage: "Audio ASR recovery is enabled, but no ASR command is configured.",
        detail,
        videoDurationSeconds:
          downloaded.videoDurationSeconds || options.pageData?.videoDurationSeconds || null
      };
    }

    const outputPath = path.join(tempDir, "transcript.json");
    const args = buildAsrCommandArgs(request, commandConfig, {
      audioPath: downloaded.audioFilePath,
      outputPath,
      pageData: options.pageData || {}
    });

    let executed = null;
    try {
      executed = await spawnProcess({
        command: commandConfig.command,
        args,
        env: commandConfig.env || process.env,
        signal: options.signal
      });
    } catch (error) {
      detail.asr = normalizeTelemetryDetail(
        buildAsrInvocationDetail({
          source: commandConfig.source,
          command: commandConfig.command,
          args,
          outputPath,
          error
        })
      );
      return {
        ok: false,
        warnings: ["asr_spawn_failed"],
        errorCode: "asr_spawn_failed",
        errorMessage: "The backend could not start the configured ASR command.",
        detail,
        videoDurationSeconds:
          downloaded.videoDurationSeconds || options.pageData?.videoDurationSeconds || null
      };
    }

    const asrDetail = buildAsrInvocationDetail({
      source: commandConfig.source,
      command: commandConfig.command,
      args,
      outputPath,
      executed
    });
    detail.asr = normalizeTelemetryDetail(asrDetail);

    if (executed.code !== 0) {
      asrDetail.failureKind = "exit_nonzero";
      detail.asr = normalizeTelemetryDetail(asrDetail);
      return {
        ok: false,
        warnings: ["asr_exit_nonzero"],
        errorCode: "asr_exit_nonzero",
        errorMessage: readAsrFailureMessage(executed.stderr, executed.stdout),
        detail,
        videoDurationSeconds:
          downloaded.videoDurationSeconds || options.pageData?.videoDurationSeconds || null
      };
    }

    const payloadText = await readAsrPayload(executed.stdout, outputPath);
    const parsed = parseAsrPayload(payloadText);
    if (!parsed.text) {
      asrDetail.failureKind = "unreadable_output";
      asrDetail.parseResult = "empty";
      detail.asr = normalizeTelemetryDetail(asrDetail);
      return {
        ok: false,
        warnings: ["asr_unreadable_output"],
        errorCode: "asr_unreadable_output",
        errorMessage: "The ASR command completed, but did not return usable transcript text.",
        detail,
        videoDurationSeconds:
          downloaded.videoDurationSeconds || options.pageData?.videoDurationSeconds || null
      };
    }

    asrDetail.failureKind = null;
    asrDetail.parseResult = "success";
    asrDetail.segmentCount = Array.isArray(parsed.segments) ? parsed.segments.length : 0;
    asrDetail.textLength = parsed.text.length;
    if (parsed.detail && typeof parsed.detail === "object") {
      asrDetail.engine = parsed.detail.engine || null;
      asrDetail.model = parsed.detail.model || null;
      asrDetail.languageProbability =
        toFiniteNumber(parsed.detail.languageProbability) || null;
    }
    detail.asr = normalizeTelemetryDetail(asrDetail);

    return {
      ok: true,
      text: parsed.text,
      segments: parsed.segments,
      languageCode:
        normalizeLanguage(parsed.languageCode) ||
        request.requestedLanguageCode ||
        null,
      originalLanguageCode:
        normalizeLanguage(parsed.originalLanguageCode || parsed.languageCode) ||
        request.requestedLanguageCode ||
        null,
      sourceConfidence: parsed.sourceConfidence || "low",
      warnings: dedupeList(
        []
          .concat(downloaded.warnings || [])
          .concat(parsed.warnings || [])
          .concat(["backend_asr_command"])
      ),
      detail,
      authenticatedAcquisitionUsed: downloaded.authenticatedAcquisitionUsed === true,
      acquisitionPathUsed: downloaded.acquisitionPathUsed || null,
      videoDurationSeconds:
        downloaded.videoDurationSeconds || options.pageData?.videoDurationSeconds || null,
      segmentQualityScore: toFiniteNumber(parsed.segmentQualityScore) || null
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function buildSuccessPayload(input) {
  const policy = input.policy || RECOVERY_POLICY;
  const authentication = resolveAuthenticationMetadata({
    policy,
    authenticatedModeEnabled: input.authenticatedModeEnabled,
    authenticatedAcquisitionUsed: input.authenticatedAcquisitionUsed,
    acquisitionPathUsed: input.acquisitionPathUsed
  });
  const segments = normalizeSegments(input.segments || []);
  const text = sanitizeText(input.text || segments.map((segment) => segment.text).join("\n"));
  const videoDurationSeconds = toFiniteNumber(input.videoDurationSeconds);
  const transcriptSpanSeconds =
    toFiniteNumber(input.transcriptSpanSeconds) || computeTranscriptSpanSeconds(segments);
  const coverageRatio = computeCoverageRatio({
    segmentCount: segments.length,
    text,
    transcriptSpanSeconds,
    videoDurationSeconds
  });
  const segmentQualityScore =
    toFiniteNumber(input.segmentQualityScore) || computeSegmentQualityScore(segments);
  const originKind = resolveOriginKind(input);
  const sourceTrustTier = Policy.getSourceTrustTier(originKind);
  const languageDecision = evaluateBackendLanguageDecision({
    requestedLanguageCode: input.requestedLanguageCode,
    languageCode: input.languageCode,
    originalLanguageCode: input.originalLanguageCode || input.languageCode,
    isTranslated: input.isTranslated,
    isMachineTranslated: input.isMachineTranslated
  });
  let sourceConfidence = normalizeConfidence(input.sourceConfidence) || "medium";
  if (originKind === "audio_asr" || languageDecision.status === "downgrade") {
    sourceConfidence = downgradeConfidence(sourceConfidence);
  }
  const qualityGate = buildBackendQualityGate({
    policy,
    text,
    segments,
    coverageRatio,
    videoDurationSeconds,
    transcriptSpanSeconds,
    segmentQualityScore,
    languageDecision,
    originKind
  });
  const quality = deriveQuality({
    text,
    sourceConfidence,
    transcriptSpanSeconds,
    coverageRatio,
    segmentQualityScore,
    qualityGate
  });

  return {
    ok: true,
    contractVersion: Contracts.CONTRACT_VERSION,
    failureCategory: null,
    providerClass: "backend",
    strategy: input.strategy || "backend-transcript",
    sourceLabel: input.sourceLabel || "Backend transcript",
    sourceConfidence,
    quality,
    recoveryTier: input.recoveryTier || (originKind === "audio_asr" ? "hosted_asr" : "hosted_transcript"),
    originKind,
    sourceTrustTier,
    winnerReason:
      input.winnerReason ||
      defaultWinnerReason(qualityGate, originKind, languageDecision),
    languageCode: normalizeLanguage(input.languageCode),
    originalLanguageCode: normalizeLanguage(
      input.originalLanguageCode || input.languageCode
    ),
    isGenerated: typeof input.isGenerated === "boolean" ? input.isGenerated : null,
    isTranslated: Boolean(input.isTranslated),
    isMachineTranslated: Boolean(input.isMachineTranslated),
    coverageRatio,
    transcriptSpanSeconds,
    videoDurationSeconds,
    segmentQualityScore,
    qualityGate,
    authenticatedModeEnabled: authentication.authenticatedModeEnabled,
    authenticatedAcquisitionUsed: authentication.authenticatedAcquisitionUsed,
    acquisitionPathUsed: authentication.acquisitionPathUsed,
    traceId: input.traceId || "",
    warnings: dedupeList([]
      .concat(input.warnings || [])
      .concat(languageDecision.warningCodes || [])
      .concat(!qualityGate.eligible ? ["quality_gate_rejected"] : [])),
    segments,
    text
  };
}

function buildFailurePayload(input) {
  const authentication = resolveAuthenticationMetadata({
    policy: input.policy,
    stageTelemetry: input.stageTelemetry,
    authenticatedModeEnabled: input.authenticatedModeEnabled,
    authenticatedAcquisitionUsed: input.authenticatedAcquisitionUsed,
    acquisitionPathUsed: input.acquisitionPathUsed
  });
  return {
    ok: false,
    contractVersion: Contracts.CONTRACT_VERSION,
    failureCategory:
      Contracts.resolveFailureCategory(input.errorCode || input.winnerReason) ||
      Contracts.FAILURE_CATEGORIES.unknown,
    providerClass: "backend",
    strategy: input.strategy || "backend-transcript",
    sourceLabel: "Backend transcript unavailable",
    sourceConfidence: "low",
    quality: "enhanced-extraction-unavailable",
    recoveryTier: input.recoveryTier || "hosted_transcript",
    originKind: "unavailable",
    sourceTrustTier: "unavailable",
    winnerReason: input.winnerReason || input.errorCode || "backend_transcript_unavailable",
    languageCode: null,
    originalLanguageCode: null,
    isGenerated: null,
    coverageRatio: null,
    transcriptSpanSeconds: null,
    videoDurationSeconds: toFiniteNumber(input.videoDurationSeconds),
    qualityGate: null,
    authenticatedModeEnabled: authentication.authenticatedModeEnabled,
    authenticatedAcquisitionUsed: authentication.authenticatedAcquisitionUsed,
    acquisitionPathUsed: authentication.acquisitionPathUsed,
    traceId: input.traceId || "",
    stageTelemetry: Array.isArray(input.stageTelemetry) ? input.stageTelemetry.slice() : [],
    warnings: dedupeList(input.warnings || []),
    errorCode: input.errorCode || "backend_transcript_unavailable",
    errorMessage:
      input.errorMessage || "No transcript-class source was available for this video.",
    segments: [],
    text: ""
  };
}

function chooseBestBackendResult(current, next, request) {
  if (!current) {
    return next ? withWinnerReason(next, next.winnerReason || "single-candidate") : next;
  }
  if (!next) {
    return current;
  }

  const comparison = compareBackendCandidates(current, next, request);
  return withWinnerReason(comparison.winner, comparison.reason);
}

function isStrongTranscript(result) {
  return result?.quality === "strong-transcript";
}

function finalizeBackendResult(result, context) {
  const authentication = resolveAuthenticationMetadata({
    policy: context.policy,
    stageTelemetry: context.stageTelemetry,
    authenticatedModeEnabled: result.authenticatedModeEnabled,
    authenticatedAcquisitionUsed: result.authenticatedAcquisitionUsed,
    acquisitionPathUsed: result.acquisitionPathUsed
  });
  const finalized = {
    ...result,
    traceId: context.traceId || result.traceId || "",
    warnings: dedupeList([].concat(result.warnings || []).concat(context.warnings || [])),
    authenticatedModeEnabled: authentication.authenticatedModeEnabled,
    authenticatedAcquisitionUsed: authentication.authenticatedAcquisitionUsed,
    acquisitionPathUsed: authentication.acquisitionPathUsed,
    stageTelemetry: Array.isArray(context.stageTelemetry)
      ? context.stageTelemetry.slice()
      : []
  };
  if (typeof context.emit === "function") {
    context.emit({
      type: "winner",
      stage: "winner",
      outcome: finalized.ok ? "success" : "failure",
      winnerReason: finalized.winnerReason || null,
      candidate: summarizeTelemetryCandidate(finalized)
    });
  }
  return finalized;
}

function isEligibleBackendResult(result) {
  return Boolean(
    result &&
      result.ok &&
      result.qualityGate &&
      result.qualityGate.eligible === true &&
      (result.quality === "strong-transcript" || result.quality === "partial-transcript")
  );
}

function isTrustedTranscriptWinner(result) {
  const rank = Policy.getTrustRank(result?.originKind || "unavailable");
  return rank <= Policy.getTrustRank("manual_caption_track");
}

function compareBackendCandidates(current, next) {
  const currentEligible = isEligibleBackendResult(current);
  const nextEligible = isEligibleBackendResult(next);
  if (currentEligible !== nextEligible) {
    return {
      winner: nextEligible ? next : current,
      reason: nextEligible
        ? `quality-eligible:${next.originKind || next.strategy}`
        : `quality-eligible:${current.originKind || current.strategy}`
    };
  }

  const currentRank = Policy.getTrustRank(current.originKind || "unavailable");
  const nextRank = Policy.getTrustRank(next.originKind || "unavailable");
  if (currentRank !== nextRank) {
    return {
      winner: nextRank < currentRank ? next : current,
      reason:
        nextRank < currentRank
          ? `trust-tier:${next.originKind}`
          : `trust-tier:${current.originKind}`
    };
  }

  const currentLanguageRank = languageDecisionRank(current.qualityGate?.languageDecision);
  const nextLanguageRank = languageDecisionRank(next.qualityGate?.languageDecision);
  if (currentLanguageRank !== nextLanguageRank) {
    return {
      winner: nextLanguageRank > currentLanguageRank ? next : current,
      reason:
        nextLanguageRank > currentLanguageRank
          ? `language:${next.qualityGate?.languageDecision || "ok"}`
          : `language:${current.qualityGate?.languageDecision || "ok"}`
    };
  }

  const currentQualityRank = qualityRank(current.quality);
  const nextQualityRank = qualityRank(next.quality);
  if (currentQualityRank !== nextQualityRank) {
    return {
      winner: nextQualityRank > currentQualityRank ? next : current,
      reason:
        nextQualityRank > currentQualityRank
          ? `quality:${next.quality}`
          : `quality:${current.quality}`
    };
  }

  const currentConfidenceRank = confidenceRank(current.sourceConfidence);
  const nextConfidenceRank = confidenceRank(next.sourceConfidence);
  if (currentConfidenceRank !== nextConfidenceRank) {
    return {
      winner: nextConfidenceRank > currentConfidenceRank ? next : current,
      reason:
        nextConfidenceRank > currentConfidenceRank
          ? `confidence:${next.sourceConfidence}`
          : `confidence:${current.sourceConfidence}`
    };
  }

  const currentCoverage = toFiniteNumber(current.coverageRatio) || 0;
  const nextCoverage = toFiniteNumber(next.coverageRatio) || 0;
  if (Math.abs(currentCoverage - nextCoverage) >= 0.05) {
    return {
      winner: nextCoverage > currentCoverage ? next : current,
      reason:
        nextCoverage > currentCoverage
          ? `coverage:${formatComparableNumber(next.coverageRatio)}`
          : `coverage:${formatComparableNumber(current.coverageRatio)}`
    };
  }

  const currentSpan = toFiniteNumber(current.transcriptSpanSeconds) || 0;
  const nextSpan = toFiniteNumber(next.transcriptSpanSeconds) || 0;
  if (Math.abs(currentSpan - nextSpan) >= 20) {
    return {
      winner: nextSpan > currentSpan ? next : current,
      reason:
        nextSpan > currentSpan
          ? `span:${Math.round(nextSpan)}`
          : `span:${Math.round(currentSpan)}`
    };
  }

  return {
    winner:
      (toFiniteNumber(next.segmentQualityScore) || 0) >
      (toFiniteNumber(current.segmentQualityScore) || 0)
        ? next
        : current,
    reason:
      (toFiniteNumber(next.segmentQualityScore) || 0) >
      (toFiniteNumber(current.segmentQualityScore) || 0)
        ? `segment-quality:${Math.round(next.segmentQualityScore || 0)}`
        : `segment-quality:${Math.round(current.segmentQualityScore || 0)}`
  };
}

function shouldRunAutomaticAsr(input) {
  const request = input.request;
  const policy = input.policy;
  const backendState = input.backendState;
  const durationSeconds =
    toFiniteNumber(input.pageData?.videoDurationSeconds) ||
    toFiniteNumber(input.bestResult?.videoDurationSeconds);
  const circuitState = resolveCircuitState(backendState);
  const decisionDetail = {
    durationSeconds: isFiniteNumber(durationSeconds) ? durationSeconds : null,
    automaticLimitSeconds: policy.backend.maxVideoLengthSeconds.automaticAsr,
    absoluteLimitSeconds: policy.backend.maxVideoLengthSeconds.absolute
  };
  if (request.analysisMode !== Policy.ANALYSIS_MODES.youtubeTranscriptFirst) {
    return { allowed: false, reason: "asr_mode_blocked", circuitState, detail: decisionDetail };
  }
  if (request.allowAutomaticAsr === false) {
    return { allowed: false, reason: "asr_disabled", circuitState, detail: decisionDetail };
  }
  if (circuitState === "open") {
    return { allowed: false, reason: "asr_circuit_open", circuitState, detail: decisionDetail };
  }
  if (
    input.bestResult &&
    input.bestResult.originKind !== "audio_asr" &&
    isEligibleBackendResult(input.bestResult)
  ) {
    return {
      allowed: false,
      reason: "transcript_candidate_eligible",
      circuitState,
      detail: decisionDetail
    };
  }

  const absoluteLimit = policy.backend.maxVideoLengthSeconds.absolute;
  const requestedLimit = clampNumber(
    request.maxAutomaticAsrDurationSeconds,
    60,
    absoluteLimit,
    policy.backend.maxVideoLengthSeconds.automaticAsr
  );
  decisionDetail.requestedLimitSeconds = requestedLimit;
  if (!isFiniteNumber(durationSeconds)) {
    return policy.backend.allowAutomaticAsrWithoutKnownDuration
      ? { allowed: true, reason: null, circuitState, detail: decisionDetail }
      : { allowed: false, reason: "asr_duration_unknown", circuitState, detail: decisionDetail };
  }
  if (durationSeconds > absoluteLimit) {
    return {
      allowed: false,
      reason: "asr_duration_absolute_limit",
      circuitState,
      detail: decisionDetail
    };
  }
  if (durationSeconds > requestedLimit) {
    return { allowed: false, reason: "asr_duration_limit", circuitState, detail: decisionDetail };
  }
  return { allowed: true, reason: null, circuitState, detail: decisionDetail };
}

function resolveOperationalPolicy(overrides) {
  return Policy.resolvePolicy(overrides || {});
}

function resolveBackendAuthConfig(policy) {
  return Auth.resolveBackendAuthConfig(policy);
}

function normalizeAuthenticatedMode(value) {
  return Auth.normalizeAuthenticatedMode(value);
}

function resolveAuthenticationMetadata(input = {}) {
  return Auth.resolveAuthenticationMetadata(input);
}

function eventUsesAuthenticatedAcquisition(event) {
  return Auth.eventUsesAuthenticatedAcquisition(event);
}

function inferAcquisitionPathUsed(stageTelemetry) {
  return Auth.inferAcquisitionPathUsed(stageTelemetry);
}

function emitStageEvent(events, callback, event) {
  return Telemetry.emitStageEvent(events, callback, event);
}

function normalizeTelemetryDetail(detail) {
  return Telemetry.normalizeTelemetryDetail(detail);
}

function summarizeError(error) {
  return Telemetry.summarizeError(error);
}

function summarizeTelemetryCandidate(candidate) {
  return Telemetry.summarizeTelemetryCandidate(candidate);
}

function resolveOriginKind(input) {
  return (
    input.originKind ||
    Policy.getOriginKind({
      strategy: input.strategy,
      isGenerated: input.isGenerated,
      isHeadless: input.isHeadless,
      sourceLabel: input.sourceLabel
    })
  );
}

function evaluateBackendLanguageDecision(input) {
  const requested = Policy.getBaseLanguage(input.requestedLanguageCode);
  const language = Policy.getBaseLanguage(input.languageCode);
  const original = Policy.getBaseLanguage(input.originalLanguageCode);

  if (requested) {
    const matchesLanguage = language === requested;
    const matchesOriginal = original === requested;
    if (!matchesLanguage && !matchesOriginal) {
      return {
        status: "reject",
        warningCodes: ["language_requested_mismatch"]
      };
    }
    if (!matchesLanguage && matchesOriginal && (input.isTranslated || input.isMachineTranslated)) {
      return {
        status: "downgrade",
        warningCodes: ["translated_requested_language"]
      };
    }
  } else if (
    (input.isTranslated || input.isMachineTranslated) &&
    language &&
    original &&
    language !== original
  ) {
    return {
      status: "downgrade",
      warningCodes: ["language_mismatch_downgrade", "translated_text"]
    };
  }

  return {
    status: "ok",
    warningCodes: []
  };
}

function buildBackendQualityGate(input) {
  const thresholds = (input.policy || RECOVERY_POLICY).thresholds;
  const effectiveThresholds = resolveAdaptiveTranscriptThresholds(
    thresholds,
    input.videoDurationSeconds,
    input.transcriptSpanSeconds
  );
  const wordCount = countWords(input.text);
  const sentenceUnits = countSentenceUnits(input.text);
  const uniqueSegmentRatio = computeUniqueSegmentRatio(input.segments);
  const averageWordsPerSegment = computeAverageWordsPerSegment(input.segments);
  const nonLetterCharacterRatio = computeNonLetterCharacterRatio(input.text);
  const coverageThreshold =
    input.originKind === "audio_asr"
      ? effectiveThresholds.minCoverageRatioAudio
      : effectiveThresholds.minCoverageRatioTranscript;
  const rejectedReasons = [];

  if (!input.text || wordCount < effectiveThresholds.minWordCount) {
    rejectedReasons.push("word_count_below_threshold");
  }
  if (sentenceUnits < effectiveThresholds.minSentenceUnits) {
    rejectedReasons.push("sentence_structure_below_threshold");
  }
  if (
    typeof input.coverageRatio === "number" &&
    input.coverageRatio < coverageThreshold
  ) {
    rejectedReasons.push("coverage_below_threshold");
  }
  if (
    typeof uniqueSegmentRatio === "number" &&
    uniqueSegmentRatio < thresholds.minUniqueSegmentRatio
  ) {
    rejectedReasons.push("repetition_detected");
  }
  if (
    input.segments.length >= thresholds.minAverageWordsPerSegmentCount &&
    typeof averageWordsPerSegment === "number" &&
    averageWordsPerSegment < thresholds.minAverageWordsPerSegment
  ) {
    rejectedReasons.push("segments_too_sparse");
  }
  if (
    typeof nonLetterCharacterRatio === "number" &&
    nonLetterCharacterRatio > thresholds.maxNonLetterCharacterRatio
  ) {
    rejectedReasons.push("non_letter_noise");
  }
  if (input.languageDecision.status === "reject") {
    rejectedReasons.push("language_mismatch");
  }

  return {
    eligible: rejectedReasons.length === 0,
    rejectedReasons,
    wordCount,
    sentenceUnits,
    coverageRatio:
      typeof input.coverageRatio === "number" ? roundTo(input.coverageRatio, 3) : null,
    effectiveMinWordCount: effectiveThresholds.minWordCount,
    effectiveMinSentenceUnits: effectiveThresholds.minSentenceUnits,
    languageDecision: input.languageDecision.status
  };
}

function resolveAdaptiveTranscriptThresholds(thresholds, videoDurationSeconds, transcriptSpanSeconds) {
  const durationSeconds =
    toFiniteNumber(videoDurationSeconds) ||
    toFiniteNumber(transcriptSpanSeconds) ||
    null;
  if (!durationSeconds || durationSeconds >= 90) {
    return thresholds;
  }

  return {
    ...thresholds,
    minWordCount: Math.min(
      thresholds.minWordCount,
      Math.max(30, Math.ceil(durationSeconds * 1.5))
    ),
    minSentenceUnits: Math.min(
      thresholds.minSentenceUnits,
      Math.max(1, Math.ceil(durationSeconds / 30))
    )
  };
}

function defaultWinnerReason(qualityGate, originKind, languageDecision) {
  if (qualityGate?.eligible) {
    if (languageDecision.status === "downgrade") {
      return `language-downgrade:${originKind}`;
    }
    return `quality-eligible:${originKind}`;
  }
  return `quality-rejected:${(qualityGate?.rejectedReasons || [])[0] || originKind || "unknown"}`;
}

function languageDecisionRank(value) {
  if (value === "ok") {
    return 3;
  }
  if (value === "downgrade") {
    return 2;
  }
  if (value === "reject") {
    return 1;
  }
  return 0;
}

function withWinnerReason(candidate, reason) {
  return {
    ...candidate,
    winnerReason: reason || candidate.winnerReason || null
  };
}

function downgradeConfidence(value) {
  if (value === "high") {
    return "medium";
  }
  if (value === "medium") {
    return "low";
  }
  return "low";
}

function resolveCircuitState(backendState) {
  if (typeof backendState?.getCircuitState !== "function") {
    return "closed";
  }
  return backendState.getCircuitState().open ? "open" : "closed";
}

async function fetchCaptionTrack(baseUrl, options) {
  const urls = buildCaptionAttemptUrls(baseUrl);

  for (const attemptUrl of urls) {
    const response = await options.fetchImpl(attemptUrl, {
      method: "GET",
      headers: {
        "accept-language": "en-US,en;q=0.9"
      },
      signal: options.signal
    }).catch(() => null);

    if (!response?.ok) {
      continue;
    }

    const payloadText = await response.text().catch(() => "");
    const parsed = parseCaptionPayload(payloadText);
    if (parsed.text) {
      return parsed;
    }
  }

  return {
    text: "",
    segments: []
  };
}

function buildCaptionAttemptUrls(baseUrl) {
  const results = [];
  const seen = new Set();
  const pushValue = (value) => {
    if (!value || seen.has(value)) {
      return;
    }
    seen.add(value);
    results.push(value);
  };

  pushValue(baseUrl);

  try {
    const url = new URL(baseUrl);
    ["json3", "srv3", "vtt"].forEach((format) => {
      const nextUrl = new URL(url.toString());
      nextUrl.searchParams.set("fmt", format);
      pushValue(nextUrl.toString());
    });
  } catch (error) {
    return results;
  }

  return results;
}

function resolveYtDlpCommandConfig(options) {
  const authConfig = resolveBackendAuthConfig(options.policy);
  const directCommand = options.ytDlpCommand || process.env.SCRIPTLENS_YTDLP_COMMAND;
  if (Array.isArray(directCommand) && directCommand.length) {
    return {
      command: String(directCommand[0]),
      prefixArgs: directCommand.slice(1).map((value) => String(value)),
      env: process.env,
      source: "custom-command",
      authenticatedModeEnabled: authConfig.enabled,
      useCookies: authConfig.enabled && authConfig.useForYtDlp,
      cookieFilePath: authConfig.cookieFilePath
    };
  }
  if (typeof directCommand === "string" && directCommand.trim()) {
    return {
      command: directCommand.trim(),
      prefixArgs: [],
      env: process.env,
      source: "custom-command",
      authenticatedModeEnabled: authConfig.enabled,
      useCookies: authConfig.enabled && authConfig.useForYtDlp,
      cookieFilePath: authConfig.cookieFilePath
    };
  }

  const pythonPath = options.ytDlpPythonPath || process.env.SCRIPTLENS_YTDLP_PYTHONPATH;
  if (typeof pythonPath === "string" && pythonPath.trim()) {
    return {
      command:
        String(
          options.ytDlpPythonCommand ||
            process.env.SCRIPTLENS_YTDLP_PYTHON ||
            "python"
        ).trim() || "python",
      prefixArgs: ["-m", "yt_dlp"],
      env: {
        ...process.env,
        PYTHONPATH: pythonPath.trim()
      },
      source: "python-module-path",
      authenticatedModeEnabled: authConfig.enabled,
      useCookies: authConfig.enabled && authConfig.useForYtDlp,
      cookieFilePath: authConfig.cookieFilePath
    };
  }

  const autoDetected = detectInstalledYtDlpCommand();
  if (autoDetected) {
    return {
      command: autoDetected.command,
      prefixArgs: autoDetected.prefixArgs,
      source: autoDetected.source,
      env: process.env,
      authenticatedModeEnabled: authConfig.enabled,
      useCookies: authConfig.enabled && authConfig.useForYtDlp,
      cookieFilePath: authConfig.cookieFilePath
    };
  }

  return null;
}

function detectInstalledYtDlpCommand() {
  const directCandidates = ["yt-dlp", "yt_dlp", "yt-dlp.exe"];
  for (const command of directCandidates) {
    if (probeCommand(command, ["--version"])) {
      return {
        command,
        prefixArgs: [],
        source: "auto-detected-binary"
      };
    }
  }

  const pythonCandidates = process.platform === "win32"
    ? ["python", "py"]
    : ["python3", "python"];
  for (const command of pythonCandidates) {
    if (probeCommand(command, ["-m", "yt_dlp", "--version"])) {
      return {
        command,
        prefixArgs: ["-m", "yt_dlp"],
        source: "auto-detected-python"
      };
    }
  }

  return null;
}

function probeCommand(command, args) {
  try {
    const result = spawnSync(command, args, {
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 3000
    });
    return !result.error && result.status === 0;
  } catch (error) {
    return false;
  }
}

async function runYtDlpCommand(request, options) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "scriptlens-ytdlp-"));
  const attempts = [];
  const syncDetail = () => {
    updateStageDetailRef(options.detailRef, buildYtDlpStageDetail(attempts));
  };

  try {
    const formatPreferences = ["json3", "vtt", "best"];

    for (const formatPreference of formatPreferences) {
      const attemptDir = path.join(tempDir, sanitizePathLabel(formatPreference));
      await fs.mkdir(attemptDir, { recursive: true });
      const args = buildYtDlpArgs(request, options.commandConfig, attemptDir, formatPreference);

      let executed = null;
      try {
        executed = await spawnProcess({
          command: options.commandConfig.command,
          args,
          env: options.commandConfig.env || process.env,
          signal: options.signal
        });
      } catch (error) {
        const writtenFiles = await listDirectoryEntries(attemptDir);
        if (options.signal?.aborted) {
          const timeoutAttempt = buildYtDlpAttemptDetail({
            formatPreference,
            command: options.commandConfig.command,
            args,
            executed: error?.partialResult || null,
            writtenFiles,
            authenticatedModeEnabled: options.commandConfig.authenticatedModeEnabled === true,
            authenticatedAcquisitionUsed: options.commandConfig.useCookies === true,
            acquisitionPathUsed: options.commandConfig.useCookies === true
              ? "authenticated-yt-dlp-captions"
              : "anonymous-yt-dlp-captions",
            error
          });
          timeoutAttempt.failureKind = isYtDlpBotGateFailure(timeoutAttempt)
            ? "bot_gate"
            : "timeout";
          attempts.push(timeoutAttempt);
          syncDetail();
          error.stageDetail = buildYtDlpStageDetail(attempts);
          throw error;
        }
        const detail = buildYtDlpAttemptDetail({
          formatPreference,
          command: options.commandConfig.command,
          args,
          executed: error?.partialResult || null,
          writtenFiles,
          authenticatedModeEnabled: options.commandConfig.authenticatedModeEnabled === true,
          authenticatedAcquisitionUsed: options.commandConfig.useCookies === true,
          acquisitionPathUsed: options.commandConfig.useCookies === true
            ? "authenticated-yt-dlp-captions"
            : "anonymous-yt-dlp-captions",
          error
        });
        attempts.push(detail);
        syncDetail();
        return buildYtDlpFailure(
          "yt_dlp_spawn_failed",
          "The backend could not start the yt-dlp transcript fallback.",
          attempts
        );
      }

      const writtenFiles = await listDirectoryEntries(attemptDir);
      const subtitlePath = await findPreferredSubtitlePath(
        attemptDir,
        request.requestedLanguageCode
      );
      const attemptDetail = buildYtDlpAttemptDetail({
        formatPreference,
        command: options.commandConfig.command,
        args,
        executed,
        writtenFiles,
        chosenSubtitleFile: subtitlePath ? path.basename(subtitlePath) : null,
        authenticatedModeEnabled: options.commandConfig.authenticatedModeEnabled === true,
        authenticatedAcquisitionUsed: options.commandConfig.useCookies === true,
        acquisitionPathUsed: options.commandConfig.useCookies === true
          ? "authenticated-yt-dlp-captions"
          : "anonymous-yt-dlp-captions"
      });
      attempts.push(attemptDetail);
      syncDetail();

      if (subtitlePath) {
        let payloadText = "";
        try {
          payloadText = await fs.readFile(subtitlePath, "utf8");
        } catch (error) {
          if (options.signal?.aborted) {
            throw error;
          }
          attemptDetail.failureKind = "unreadable_subtitle";
          attemptDetail.readError = summarizeError(error);
          syncDetail();
          return buildYtDlpFailure(
            "yt_dlp_unreadable_subtitle",
            "yt-dlp wrote a subtitle file, but the backend could not read it.",
            attempts
          );
        }

        const parsed = parseCaptionPayload(payloadText);
        if (parsed.text) {
          const wroteSubtitleDespiteExit = executed.code !== 0;
          attemptDetail.failureKind = wroteSubtitleDespiteExit
            ? "exit_nonzero_with_subtitle"
            : null;
          attemptDetail.parseResult = "success";
          syncDetail();
          return {
            ok: true,
            text: parsed.text,
            segments: parsed.segments,
            languageCode:
              inferLanguageFromSubtitlePath(subtitlePath) || request.requestedLanguageCode || "en",
            warnings: dedupeList(
              ["backend_yt_dlp_resolver"].concat(
                wroteSubtitleDespiteExit ? ["backend_yt_dlp_nonzero_exit"] : []
              )
            ),
            detail: {
              selectedFormat: formatPreference,
              chosenSubtitleFile: path.basename(subtitlePath),
              attempts
            },
            authenticatedAcquisitionUsed: options.commandConfig.useCookies === true,
            acquisitionPathUsed: options.commandConfig.useCookies === true
              ? "authenticated-yt-dlp-captions"
              : "anonymous-yt-dlp-captions"
          };
        }

        attemptDetail.failureKind = "unreadable_subtitle";
        attemptDetail.parseResult = "empty";
        syncDetail();
      }

      if (executed.code !== 0) {
        if (isYtDlpBotGateFailure(attemptDetail)) {
          attemptDetail.failureKind = "bot_gate";
          syncDetail();
          break;
        }
        attemptDetail.failureKind = "exit_nonzero";
        syncDetail();
        continue;
      }

      if (!subtitlePath) {
        attemptDetail.failureKind = "no_subtitle_file";
        syncDetail();
        continue;
      }
    }

    return buildYtDlpFailureFromAttempts(attempts);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function buildYtDlpArgs(request, commandConfig, outputDir, formatPreference) {
  const args = []
    .concat(commandConfig.prefixArgs || [])
    .concat([
      "--js-runtimes",
      resolveYtDlpJsRuntimes(),
      "--no-progress",
      "--ignore-no-formats-error",
      "--skip-download",
      "--write-subs",
      "--write-auto-sub"
    ]);

  if (commandConfig.useCookies && commandConfig.cookieFilePath) {
    args.push("--cookies", commandConfig.cookieFilePath);
  }

  if (formatPreference && formatPreference !== "best") {
    args.push("--sub-format", formatPreference);
  }

  args.push(
    "--sub-langs",
    buildYtDlpLanguageSpec(request.requestedLanguageCode),
    "-o",
    path.join(outputDir, "%(id)s.%(ext)s"),
    request.url
  );

  return args;
}

function buildYtDlpLanguageSpec(requestedLanguageCode) {
  const normalized = normalizeLanguage(requestedLanguageCode || "en") || "en";
  const requestedBase = normalized.split("-")[0];
  return dedupeList([
    normalized,
    `${requestedBase}-orig`,
    requestedBase,
    "en-orig",
    "en"
  ]).join(",");
}

function findPreferredSubtitlePath(tempDir, requestedLanguageCode) {
  return fs.readdir(tempDir).then((entries) => {
    const subtitleFiles = entries
      .filter((entry) => /\.(json3|vtt|srv3|xml|ttml)$/i.test(entry))
      .sort((left, right) =>
        scoreSubtitleFile(right, requestedLanguageCode) -
        scoreSubtitleFile(left, requestedLanguageCode)
      );

    if (!subtitleFiles.length) {
      return null;
    }

    return path.join(tempDir, subtitleFiles[0]);
  });
}

function scoreSubtitleFile(filename, requestedLanguageCode) {
  const lowerName = String(filename || "").toLowerCase();
  const requested = normalizeLanguage(requestedLanguageCode || "");
  const requestedBase = requested ? requested.split("-")[0] : "";
  let score = extensionPreferenceScore(lowerName);

  if (requested && lowerName.endsWith(`.${requested.toLowerCase()}.json3`)) {
    return score + 50;
  }
  if (
    requestedBase &&
    matchesLanguageSuffix(lowerName, `${requestedBase.toLowerCase()}-orig`)
  ) {
    return score + 40;
  }
  if (requestedBase && matchesLanguageSuffix(lowerName, requestedBase.toLowerCase())) {
    return score + 30;
  }
  if (matchesLanguageSuffix(lowerName, "en-orig")) {
    return score + 20;
  }
  if (matchesLanguageSuffix(lowerName, "en")) {
    return score + 10;
  }
  return score;
}

function inferLanguageFromSubtitlePath(filePath) {
  const match = String(filePath || "").match(
    /\.([a-z]{2,3}(?:-[a-z0-9]+)?)(?:\.[^.]+)?\.(json3|vtt|srv3|xml|ttml)$/i
  );
  if (match?.[1]) {
    return normalizeLanguage(match[1]);
  }
  const fallbackMatch = String(filePath || "").match(
    /\.([a-z]{2,3}(?:-[a-z0-9]+)?)\.(json3|vtt|srv3|xml|ttml)$/i
  );
  if (fallbackMatch?.[1]) {
    return normalizeLanguage(fallbackMatch[1]);
  }
  return normalizeLanguage(match?.[1] || null);
}

function extensionPreferenceScore(filename) {
  if (/\.json3$/i.test(filename)) {
    return 5;
  }
  if (/\.srv3$/i.test(filename)) {
    return 4;
  }
  if (/\.vtt$/i.test(filename)) {
    return 3;
  }
  if (/\.ttml$/i.test(filename)) {
    return 2;
  }
  if (/\.xml$/i.test(filename)) {
    return 1;
  }
  return 0;
}

function matchesLanguageSuffix(filename, languageSuffix) {
  return new RegExp(`\\.${escapeRegExp(languageSuffix)}(?:\\.[^.]+)?\\.(json3|vtt|srv3|xml|ttml)$`, "i")
    .test(filename);
}

async function listDirectoryEntries(directoryPath) {
  try {
    return (await fs.readdir(directoryPath)).sort();
  } catch (error) {
    return [];
  }
}

function sanitizePathLabel(value) {
  return String(value || "attempt")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-") || "attempt";
}

function buildYtDlpAttemptDetail(input) {
  const executed = input.executed || input.error?.partialResult || null;
  return {
    formatPreference: input.formatPreference || null,
    command: input.command || null,
    args: sanitizeCommandArgs(input.args),
    exitCode: typeof executed?.code === "number" ? executed.code : null,
    signal: executed?.signal || null,
    writtenFiles: Array.isArray(input.writtenFiles) ? input.writtenFiles.slice() : [],
    chosenSubtitleFile: input.chosenSubtitleFile || null,
    authenticatedModeEnabled: input.authenticatedModeEnabled === true,
    authenticatedAcquisitionUsed: input.authenticatedAcquisitionUsed === true,
    acquisitionPathUsed: input.acquisitionPathUsed || null,
    stderrTail: tailText(executed?.stderr),
    stdoutTail: tailText(executed?.stdout),
    error: input.error ? summarizeError(input.error) : null
  };
}

function buildYtDlpFailure(errorCode, errorMessage, attempts) {
  return {
    ok: false,
    warnings: [errorCode],
    errorCode,
    errorMessage,
    detail: buildYtDlpStageDetail(attempts),
    authenticatedAcquisitionUsed: Array.isArray(attempts)
      ? attempts.some((attempt) => attempt?.authenticatedAcquisitionUsed === true)
      : false,
    acquisitionPathUsed: Array.isArray(attempts) && attempts.some((attempt) => attempt?.authenticatedAcquisitionUsed === true)
      ? "authenticated-yt-dlp-captions"
      : "anonymous-yt-dlp-captions"
  };
}

function buildYtDlpStageDetail(attempts) {
  const authenticatedAcquisitionUsed = Array.isArray(attempts)
    ? attempts.some((attempt) => attempt?.authenticatedAcquisitionUsed === true)
    : false;
  return {
    attempts,
    authenticatedModeEnabled: Array.isArray(attempts)
      ? attempts.some((attempt) => attempt?.authenticatedModeEnabled === true)
      : false,
    authenticatedAcquisitionUsed,
    acquisitionPathUsed: authenticatedAcquisitionUsed
      ? "authenticated-yt-dlp-captions"
      : "anonymous-yt-dlp-captions",
    botGateDetected: Array.isArray(attempts)
      ? attempts.some((attempt) => attempt.failureKind === "bot_gate")
      : false
  };
}

function buildYtDlpFailureFromAttempts(attempts) {
  const sawBotGate = attempts.some((attempt) => attempt.failureKind === "bot_gate");
  if (sawBotGate) {
    return buildYtDlpFailure(
      "yt_dlp_exit_nonzero",
      "yt-dlp hit YouTube bot protection and could not fetch subtitles without authentication.",
      attempts
    );
  }

  const sawUnreadable = attempts.some((attempt) => attempt.failureKind === "unreadable_subtitle");
  if (sawUnreadable) {
    return buildYtDlpFailure(
      "yt_dlp_unreadable_subtitle",
      "yt-dlp wrote subtitles, but they did not contain usable transcript text.",
      attempts
    );
  }

  const sawZeroExit = attempts.some((attempt) => attempt.exitCode === 0);
  if (sawZeroExit) {
    return buildYtDlpFailure(
      "yt_dlp_no_subtitle_file",
      "yt-dlp completed, but no usable subtitle file was written.",
      attempts
    );
  }

  return buildYtDlpFailure(
    "yt_dlp_exit_nonzero",
    readProcessFailureMessage(
      attempts.map((attempt) => attempt.stderrTail).filter(Boolean).join("\n"),
      attempts.map((attempt) => attempt.stdoutTail).filter(Boolean).join("\n")
    ),
    attempts
  );
}

function resolveAsrCommandConfig(options) {
  const directCommand = options.asrCommand || process.env.SCRIPTLENS_BACKEND_ASR_COMMAND;
  const argsTemplate = parseCommandArgsTemplate(
    options.asrArgs,
    process.env.SCRIPTLENS_BACKEND_ASR_ARGS_JSON,
    process.env.SCRIPTLENS_BACKEND_ASR_ARGS
  );
  if (Array.isArray(directCommand) && directCommand.length) {
    return {
      command: String(directCommand[0]),
      prefixArgs: directCommand.slice(1).map((value) => String(value)),
      argsTemplate,
      env: process.env,
      source: "custom-command"
    };
  }
  if (typeof directCommand === "string" && directCommand.trim()) {
    return {
      command: directCommand.trim(),
      prefixArgs: [],
      argsTemplate,
      env: process.env,
      source: "custom-command"
    };
  }

  const helperPath =
    String(
      options.asrHelperPath ||
        process.env.SCRIPTLENS_BACKEND_ASR_HELPER_PATH ||
        path.join(process.cwd(), "backend", "asr-faster-whisper.py")
    ).trim() || path.join(process.cwd(), "backend", "asr-faster-whisper.py");
  return {
    command:
      String(
        options.asrPythonCommand ||
          process.env.SCRIPTLENS_BACKEND_ASR_PYTHON ||
          (process.platform === "win32" ? "python" : "python3")
      ).trim() || (process.platform === "win32" ? "python" : "python3"),
    prefixArgs: [helperPath],
    argsTemplate: [],
    env: process.env,
    source: "faster-whisper-helper",
    defaultHelper: true
  };
}

function resolveBackendCapabilitySnapshot(options = {}) {
  const policy = options.policy || resolveOperationalPolicy(options.policyOverrides);
  const authConfig = resolveBackendAuthConfig(policy);
  const ytDlpConfig = resolveYtDlpCommandConfig({
    ...options,
    policy
  });
  const asrConfig = resolveAsrCommandConfig(options);
  const asrHelperPath =
    asrConfig?.defaultHelper && Array.isArray(asrConfig.prefixArgs)
      ? String(asrConfig.prefixArgs[0] || "").trim()
      : "";

  const chromiumLauncher = options.chromiumLauncher || chromium;
  let headlessExecutablePresent = false;
  try {
    const executablePath =
      typeof chromiumLauncher.executablePath === "function"
        ? chromiumLauncher.executablePath()
        : null;
    headlessExecutablePresent = executablePath
      ? fsSync.existsSync(executablePath)
      : false;
  } catch {
    headlessExecutablePresent = false;
  }

  return {
    auth: {
      mode: authConfig.mode,
      cookieFileConfigured: Boolean(authConfig.cookieFilePath),
      enabled: authConfig.enabled,
      useForYtDlp: authConfig.useForYtDlp,
      useForBrowserSession: authConfig.useForBrowserSession
    },
    ytDlp: {
      available: Boolean(ytDlpConfig),
      source: ytDlpConfig?.source || null,
      command: summarizeCommandIdentity(ytDlpConfig?.command),
      prefixArgs: summarizePrefixArgs(ytDlpConfig?.prefixArgs),
      authenticatedModeEnabled: ytDlpConfig?.authenticatedModeEnabled === true,
      useCookies: ytDlpConfig?.useCookies === true
    },
    headless: {
      executablePresent: headlessExecutablePresent
    },
    asr: {
      enabled: options.enableAutomaticAsr === true,
      configured: Boolean(asrConfig),
      source: asrConfig?.source || null,
      command: summarizeCommandIdentity(asrConfig?.command),
      prefixArgs: summarizePrefixArgs(asrConfig?.prefixArgs),
      helperScriptPresent: asrHelperPath ? fsSync.existsSync(asrHelperPath) : null
    }
  };
}

function summarizeCommandIdentity(command) {
  const value = String(command || "").trim();
  if (!value) {
    return null;
  }
  return path.basename(value);
}

function summarizePrefixArgs(prefixArgs) {
  if (!Array.isArray(prefixArgs) || !prefixArgs.length) {
    return [];
  }
  return prefixArgs.map((value) => {
    const text = String(value || "").trim();
    if (!text) {
      return "";
    }
    if (/[/\\]/.test(text)) {
      return path.basename(text);
    }
    return text;
  });
}

async function downloadAudioForAsr(request, options) {
  const outputDir = options.outputDir || path.join(os.tmpdir(), "scriptlens-asr-audio");
  await fs.mkdir(outputDir, { recursive: true });
  const primaryAttempt = await downloadAudioWithYtDlp(request, {
    ...options,
    outputDir
  });
  if (primaryAttempt.ok) {
    return {
      ...primaryAttempt,
      detail: buildMergedAsrAudioDetail({
        selected: primaryAttempt,
        ytDlpAttempt: primaryAttempt,
        browserSessionAttempt: null,
        acquisitionStrategy: "yt-dlp"
      })
    };
  }

  if (!shouldTryBrowserSessionAudioFallback(primaryAttempt, options)) {
    return {
      ...primaryAttempt,
      detail: buildMergedAsrAudioDetail({
        selected: primaryAttempt,
        ytDlpAttempt: primaryAttempt,
        browserSessionAttempt: null,
        acquisitionStrategy: null
      })
    };
  }

  const browserSessionAttempt = await downloadAudioViaBrowserSessionFallback(request, {
    ...options,
    outputDir
  });
  if (browserSessionAttempt.ok) {
    return {
      ...browserSessionAttempt,
      warnings: dedupeList(
        []
          .concat(primaryAttempt.warnings || [])
          .concat(browserSessionAttempt.warnings || [])
          .concat(["asr_audio_browser_session_fallback"])
      ),
      detail: buildMergedAsrAudioDetail({
        selected: browserSessionAttempt,
        ytDlpAttempt: primaryAttempt,
        browserSessionAttempt,
        acquisitionStrategy: "browser-session"
      })
    };
  }

  return {
    ok: false,
    warnings: dedupeList(
      []
        .concat(primaryAttempt.warnings || [])
        .concat(browserSessionAttempt.warnings || [])
    ),
    errorCode: browserSessionAttempt.errorCode || primaryAttempt.errorCode,
    errorMessage: browserSessionAttempt.errorMessage || primaryAttempt.errorMessage,
    detail: buildMergedAsrAudioDetail({
      selected: browserSessionAttempt,
      ytDlpAttempt: primaryAttempt,
      browserSessionAttempt,
      acquisitionStrategy: null
    }),
    videoDurationSeconds:
      browserSessionAttempt.videoDurationSeconds ||
      primaryAttempt.videoDurationSeconds ||
      options.pageData?.videoDurationSeconds ||
      null
  };
}

async function downloadAudioWithYtDlp(request, options) {
  if (!options.commandConfig) {
    return {
      ok: false,
      warnings: ["asr_audio_download_unconfigured"],
      errorCode: "asr_audio_download_unconfigured",
      errorMessage: "The backend does not have yt-dlp configured for audio acquisition.",
      detail: {
        commandMissing: true,
        acquisitionStrategy: "yt-dlp",
        failureKind: "command_missing"
      },
      videoDurationSeconds: options.pageData?.videoDurationSeconds || null
    };
  }

  const args = buildAsrAudioArgs(request, options.commandConfig, options.outputDir);
  let executed = null;
  try {
    executed = await spawnProcess({
      command: options.commandConfig.command,
      args,
      env: options.commandConfig.env || process.env,
      signal: options.signal
    });
  } catch (error) {
    const detail = buildAsrAudioDownloadDetail({
      command: options.commandConfig.command,
      args,
      error,
      authenticatedModeEnabled: options.commandConfig.authenticatedModeEnabled === true,
      authenticatedAcquisitionUsed: options.commandConfig.useCookies === true,
      acquisitionPathUsed: options.commandConfig.useCookies === true
        ? "authenticated-yt-dlp-audio"
        : "anonymous-yt-dlp-audio"
    });
    detail.acquisitionStrategy = "yt-dlp";
    detail.failureKind = "spawn_failed";
    return {
      ok: false,
      warnings: ["asr_audio_download_spawn_failed"],
      errorCode: "asr_audio_download_spawn_failed",
      errorMessage: "The backend could not start the ASR audio download step.",
      detail,
      videoDurationSeconds: options.pageData?.videoDurationSeconds || null
    };
  }

  const writtenFiles = await listDirectoryEntries(options.outputDir);
  const audioPath = await findPreferredAudioPath(options.outputDir);
  const detail = buildAsrAudioDownloadDetail({
    command: options.commandConfig.command,
    args,
    executed,
    writtenFiles,
    selectedAudioFile: audioPath ? path.basename(audioPath) : null,
    authenticatedModeEnabled: options.commandConfig.authenticatedModeEnabled === true,
    authenticatedAcquisitionUsed: options.commandConfig.useCookies === true,
    acquisitionPathUsed: options.commandConfig.useCookies === true
      ? "authenticated-yt-dlp-audio"
      : "anonymous-yt-dlp-audio"
  });
  detail.acquisitionStrategy = "yt-dlp";
  detail.botGateDetected = isYtDlpBotGateFailure(detail);

  if (executed.code !== 0) {
    detail.failureKind = detail.botGateDetected ? "bot_gate" : "exit_nonzero";
    return {
      ok: false,
      warnings: [detail.botGateDetected ? "asr_audio_download_bot_gate" : "asr_audio_download_failed"],
      errorCode: detail.botGateDetected ? "asr_audio_download_bot_gate" : "asr_audio_download_failed",
      errorMessage: detail.botGateDetected
        ? "yt-dlp hit YouTube bot protection while downloading audio for ASR."
        : readProcessFailureMessage(executed.stderr, executed.stdout),
      detail,
      videoDurationSeconds: options.pageData?.videoDurationSeconds || null
    };
  }

  if (!audioPath) {
    detail.failureKind = "audio_missing";
    return {
      ok: false,
      warnings: ["asr_audio_missing"],
      errorCode: "asr_audio_missing",
      errorMessage: "yt-dlp completed, but no usable audio file was written for ASR.",
      detail,
      videoDurationSeconds: options.pageData?.videoDurationSeconds || null
    };
  }

  detail.failureKind = null;
  return {
    ok: true,
    audioFilePath: audioPath,
    detail,
    authenticatedAcquisitionUsed: options.commandConfig.useCookies === true,
    acquisitionPathUsed: options.commandConfig.useCookies === true
      ? "authenticated-yt-dlp-audio"
      : "anonymous-yt-dlp-audio",
    videoDurationSeconds: options.pageData?.videoDurationSeconds || null
  };
}

function buildAsrAudioArgs(request, commandConfig, outputDir) {
  const args = []
    .concat(commandConfig.prefixArgs || [])
    .concat([
      "--js-runtimes",
      resolveYtDlpJsRuntimes(),
      "--no-playlist",
      "--no-progress",
      "--no-warnings"
    ]);
  if (commandConfig.useCookies && commandConfig.cookieFilePath) {
    args.push("--cookies", commandConfig.cookieFilePath);
  }
  args.push(
    "-f",
    "bestaudio/best",
    "-o",
    path.join(outputDir, "%(id)s.%(ext)s"),
    request.url
  );
  return args;
}

function resolveYtDlpJsRuntimes() {
  return String(process.env.SCRIPTLENS_YTDLP_JS_RUNTIMES || "node").trim() || "node";
}

async function findPreferredAudioPath(directoryPath) {
  try {
    const entries = await fs.readdir(directoryPath);
    const audioFiles = entries
      .filter((entry) => /\.(mp3|m4a|wav|flac|opus|ogg|webm|mp4|aac)$/i.test(entry))
      .sort((left, right) => scoreAudioFile(right) - scoreAudioFile(left));
    return audioFiles.length ? path.join(directoryPath, audioFiles[0]) : null;
  } catch (error) {
    return null;
  }
}

function scoreAudioFile(filename) {
  const lowerName = String(filename || "").toLowerCase();
  if (/\.mp3$/i.test(lowerName)) {
    return 6;
  }
  if (/\.m4a$/i.test(lowerName)) {
    return 5;
  }
  if (/\.wav$/i.test(lowerName)) {
    return 4;
  }
  if (/\.flac$/i.test(lowerName)) {
    return 3;
  }
  if (/\.opus$/i.test(lowerName)) {
    return 2;
  }
  return 1;
}

function buildAsrAudioDownloadDetail(input) {
  return {
    command: input.command || null,
    args: sanitizeCommandArgs(input.args),
    exitCode:
      typeof input.executed?.code === "number" ? input.executed.code : null,
    signal: input.executed?.signal || null,
    writtenFiles: Array.isArray(input.writtenFiles) ? input.writtenFiles.slice() : [],
    selectedAudioFile: input.selectedAudioFile || null,
    authenticatedModeEnabled: input.authenticatedModeEnabled === true,
    authenticatedAcquisitionUsed: input.authenticatedAcquisitionUsed === true,
    acquisitionPathUsed: input.acquisitionPathUsed || null,
    stderrTail: tailText(input.executed?.stderr),
    stdoutTail: tailText(input.executed?.stdout),
    error: input.error ? summarizeError(input.error) : null
  };
}

function buildMergedAsrAudioDetail(input) {
  const selected = normalizeTelemetryDetail(input.selected?.detail || null) || {};
  const ytDlpDetail = normalizeTelemetryDetail(input.ytDlpAttempt?.detail || null);
  const browserSessionDetail = normalizeTelemetryDetail(input.browserSessionAttempt?.detail || null);
  const authenticatedAcquisitionUsed =
    selected.authenticatedAcquisitionUsed === true ||
    ytDlpDetail?.authenticatedAcquisitionUsed === true ||
    browserSessionDetail?.authenticatedAcquisitionUsed === true;
  return {
    ...selected,
    acquisitionStrategy: input.acquisitionStrategy || selected.acquisitionStrategy || null,
    authenticatedModeEnabled:
      selected.authenticatedModeEnabled === true ||
      ytDlpDetail?.authenticatedModeEnabled === true ||
      browserSessionDetail?.authenticatedModeEnabled === true,
    authenticatedAcquisitionUsed,
    acquisitionPathUsed:
      selected.acquisitionPathUsed ||
      browserSessionDetail?.acquisitionPathUsed ||
      ytDlpDetail?.acquisitionPathUsed ||
      null,
    botGateDetected:
      Boolean(ytDlpDetail?.botGateDetected) ||
      input.ytDlpAttempt?.errorCode === "asr_audio_download_bot_gate",
    selectedAudioFile:
      selected.selectedAudioFile ||
      (input.selected?.audioFilePath ? path.basename(input.selected.audioFilePath) : null),
    selectedMimeType: selected.selectedMimeType || input.selected?.mimeType || null,
    selectedContainer: selected.selectedContainer || input.selected?.container || null,
    ytDlp: ytDlpDetail,
    browserSession: browserSessionDetail
  };
}

function shouldTryBrowserSessionAudioFallback(primaryAttempt, options) {
  const hasFallback =
    typeof options.browserSessionAudioResolver === "function" ||
    (typeof options.fetchImpl === "function" && options.chromiumLauncher);
  if (!hasFallback) {
    return false;
  }
  if (!primaryAttempt) {
    return true;
  }
  return primaryAttempt.ok !== true;
}

async function downloadAudioViaBrowserSessionFallback(request, options) {
  if (typeof options.browserSessionAudioResolver === "function") {
    return options.browserSessionAudioResolver({
      request,
      pageData: options.pageData || {},
      signal: options.signal,
      outputDir: options.outputDir
    });
  }

  if (!options.chromiumLauncher || typeof options.fetchImpl !== "function") {
    return {
      ok: false,
      warnings: ["asr_audio_browser_session_unconfigured"],
      errorCode: "asr_audio_browser_session_unconfigured",
      errorMessage: "The backend does not have a browser-session audio fallback configured.",
      detail: {
        acquisitionStrategy: "browser-session",
        failureKind: "unconfigured"
      },
      videoDurationSeconds: options.pageData?.videoDurationSeconds || null
    };
  }

  const headlessConfig = resolveHeadlessConfig(request.policy);
  const authConfig = resolveBackendAuthConfig(request.policy);
  const detail = {
    acquisitionStrategy: "browser-session",
    usedFallback: true,
    launchOptions: summarizeHeadlessLaunchOptions(headlessConfig),
    steps: [],
    pageSnapshots: [],
    mediaRequests: [],
    lastKnownState: null,
    selectedCandidate: null,
    download: null
  };

  let browser = null;
  let context = null;
  let cleanupAbort = () => {};
  let disposeMediaProbe = () => {};
  let authSession = {
    ok: true,
    authenticatedModeEnabled: authConfig.enabled,
    authenticatedAcquisitionUsed: false,
    acquisitionPathUsed: null,
    detail: {
      authenticatedModeEnabled: authConfig.enabled,
      authenticatedAcquisitionUsed: false,
      acquisitionPathUsed: null
    }
  };

  try {
    const launchStartedAt = Date.now();
    try {
      browser = await options.chromiumLauncher.launch({
        headless: true,
        chromiumSandbox: headlessConfig.chromiumSandbox,
        args: headlessConfig.launchArgs
      });
    } catch (error) {
      recordHeadlessStep(detail, "launch", launchStartedAt, "failure", {
        errorCode: "asr_audio_browser_session_launch_failed",
        error: summarizeError(error)
      });
      return {
        ok: false,
        warnings: ["asr_audio_browser_session_launch_failed"],
        errorCode: "asr_audio_browser_session_launch_failed",
        errorMessage: "The browser-session audio fallback could not launch Chromium.",
        detail,
        videoDurationSeconds:
          detail.lastKnownState?.videoDurationSeconds || options.pageData?.videoDurationSeconds || null
      };
    }
    recordHeadlessStep(detail, "launch", launchStartedAt, "success");
    cleanupAbort = attachBrowserAbort(options.signal, browser);

    context = await browser.newContext({
      locale: "en-US",
      viewport: { width: 1440, height: 1100 },
      userAgent: WATCH_PAGE_HEADERS["user-agent"]
    });
    const authStartedAt = Date.now();
    authSession = await maybeApplyAuthenticatedBrowserSession(context, {
      requestUrl: request.url,
      policy: request.policy
    });
    detail.authentication = authSession.detail || null;
    recordHeadlessStep(
      detail,
      "authSession",
      authStartedAt,
      authSession.ok ? "success" : "failure",
      authSession.detail || null
    );

    const page = await context.newPage();
    const mediaProbe = createHeadlessMediaProbe(page, detail);
    disposeMediaProbe = mediaProbe.dispose;

    const gotoStartedAt = Date.now();
    try {
      await page.goto(request.url, {
        waitUntil: "domcontentloaded",
        timeout: headlessConfig.navigationTimeoutMs
      });
      recordHeadlessStep(detail, "goto", gotoStartedAt, "success");
      await captureAndRecordHeadlessSnapshot(page, detail, "audio-after-goto");
    } catch (error) {
      recordHeadlessStep(detail, "goto", gotoStartedAt, "failure", {
        errorCode: "asr_audio_browser_session_navigation_failed",
        error: summarizeError(error)
      });
      return {
        ok: false,
        warnings: ["asr_audio_browser_session_navigation_failed"],
        errorCode: "asr_audio_browser_session_navigation_failed",
        errorMessage: "The browser-session audio fallback could not load the YouTube watch page.",
        detail,
        videoDurationSeconds:
          detail.lastKnownState?.videoDurationSeconds || options.pageData?.videoDurationSeconds || null
      };
    }

    const consentStartedAt = Date.now();
    try {
      const consentResult = await maybeAcceptConsent(page);
      recordHeadlessStep(detail, "consent", consentStartedAt, "success", consentResult);
      await captureAndRecordHeadlessSnapshot(page, detail, "audio-after-consent");
    } catch (error) {
      recordHeadlessStep(detail, "consent", consentStartedAt, "failure", {
        errorCode: "asr_audio_browser_session_consent_failed",
        error: summarizeError(error)
      });
      return {
        ok: false,
        warnings: ["asr_audio_browser_session_consent_failed"],
        errorCode: "asr_audio_browser_session_consent_failed",
        errorMessage: "The browser-session audio fallback hit a consent flow it could not complete.",
        detail,
        videoDurationSeconds:
          detail.lastKnownState?.videoDurationSeconds || options.pageData?.videoDurationSeconds || null
      };
    }

    if (headlessConfig.settleMs > 0) {
      await page.waitForTimeout(headlessConfig.settleMs).catch(() => {});
    }

    const playbackStartedAt = Date.now();
    try {
      const playbackResult = await primeHeadlessMediaPlayback(page);
      recordHeadlessStep(detail, "primePlayback", playbackStartedAt, "success", playbackResult);
    } catch (error) {
      recordHeadlessStep(detail, "primePlayback", playbackStartedAt, "failure", {
        errorCode: "asr_audio_browser_session_playback_failed",
        error: summarizeError(error)
      });
    }
    await captureAndRecordHeadlessSnapshot(page, detail, "audio-after-prime-playback");
    if (isYouTubeBotGatePageState(detail.lastKnownState)) {
      return {
        ok: false,
        warnings: ["asr_audio_browser_session_bot_gate"],
        errorCode: "asr_audio_browser_session_bot_gate",
        errorMessage: "YouTube blocked the browser-session audio fallback before media playback could start.",
        detail,
        authenticatedAcquisitionUsed: authSession.authenticatedAcquisitionUsed,
        acquisitionPathUsed: authSession.acquisitionPathUsed,
        videoDurationSeconds:
          detail.lastKnownState?.videoDurationSeconds || options.pageData?.videoDurationSeconds || null
      };
    }

    const waitStartedAt = Date.now();
    const candidateResult = await waitForHeadlessMediaCandidate(
      page,
      mediaProbe,
      Math.max(1000, headlessConfig.transcriptWaitMs),
      detail,
      options.signal
    );
    if (!candidateResult.ok) {
      recordHeadlessStep(detail, "waitMedia", waitStartedAt, "failure", {
        errorCode: candidateResult.errorCode,
        observedMediaCount: candidateResult.observedMediaCount,
        pageState: candidateResult.pageState || detail.lastKnownState || null
      });
      return {
        ok: false,
        warnings: [candidateResult.errorCode],
        errorCode: candidateResult.errorCode,
        errorMessage: candidateResult.errorMessage,
        detail,
        authenticatedAcquisitionUsed: authSession.authenticatedAcquisitionUsed,
        acquisitionPathUsed: authSession.acquisitionPathUsed,
        videoDurationSeconds:
          candidateResult.pageState?.videoDurationSeconds ||
          detail.lastKnownState?.videoDurationSeconds ||
          options.pageData?.videoDurationSeconds ||
          null
      };
    }
    detail.selectedCandidate = summarizeBrowserSessionMediaCandidate(candidateResult.candidate);
    recordHeadlessStep(detail, "waitMedia", waitStartedAt, "success", {
      observedMediaCount: Array.isArray(detail.mediaRequests) ? detail.mediaRequests.length : 0,
      selectedCandidate: detail.selectedCandidate
    });

    const downloadStartedAt = Date.now();
    const downloaded = await downloadObservedBrowserSessionMedia(candidateResult.candidate, {
      fetchImpl: options.fetchImpl,
      outputDir: options.outputDir,
      signal: options.signal,
      watchUrl: request.url
    });
    detail.download = normalizeTelemetryDetail(downloaded?.detail || null);
    if (!downloaded.ok) {
      recordHeadlessStep(detail, "downloadMedia", downloadStartedAt, "failure", {
        errorCode: downloaded.errorCode,
        detail: downloaded.detail || null
      });
      return {
        ok: false,
        warnings: dedupeList(downloaded.warnings || ["asr_audio_browser_session_download_failed"]),
        errorCode: downloaded.errorCode || "asr_audio_browser_session_download_failed",
        errorMessage:
          downloaded.errorMessage ||
          "The browser-session audio fallback found media, but could not download it.",
        detail,
        authenticatedAcquisitionUsed:
          authSession.authenticatedAcquisitionUsed ||
          downloaded.authenticatedAcquisitionUsed === true,
        acquisitionPathUsed:
          downloaded.acquisitionPathUsed || authSession.acquisitionPathUsed,
        videoDurationSeconds:
          downloaded.videoDurationSeconds ||
          detail.lastKnownState?.videoDurationSeconds ||
          options.pageData?.videoDurationSeconds ||
          null
      };
    }
    recordHeadlessStep(detail, "downloadMedia", downloadStartedAt, "success", downloaded.detail);
    detail.selectedAudioFile = path.basename(downloaded.audioFilePath);
    detail.selectedMimeType = downloaded.mimeType || null;
    detail.selectedContainer = downloaded.container || null;

    return {
      ok: true,
      warnings: ["asr_audio_browser_session_fallback"],
      audioFilePath: downloaded.audioFilePath,
      mimeType: downloaded.mimeType || null,
      container: downloaded.container || null,
      detail,
      authenticatedAcquisitionUsed:
        authSession.authenticatedAcquisitionUsed ||
        downloaded.authenticatedAcquisitionUsed === true,
      acquisitionPathUsed:
        downloaded.acquisitionPathUsed ||
        authSession.acquisitionPathUsed ||
        "browser-session-audio",
      videoDurationSeconds:
        downloaded.videoDurationSeconds ||
        detail.lastKnownState?.videoDurationSeconds ||
        options.pageData?.videoDurationSeconds ||
        null
    };
  } finally {
    disposeMediaProbe();
    cleanupAbort();
    if (context) {
      await context.close().catch(() => {});
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

async function primeHeadlessMediaPlayback(page) {
  return withPromiseTimeout(
    page.evaluate(async () => {
      const sanitize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const result = {
        foundVideo: false,
        invokedPlay: false,
        clickedPlayButton: false,
        playError: null,
        readyState: null,
        networkState: null,
        paused: null,
        currentTime: null,
        src: null
      };
      const video = document.querySelector("video");
      const playButton = document.querySelector(".ytp-play-button");
      result.foundVideo = Boolean(video);
      if (playButton) {
        const ariaLabel = sanitize(playButton.getAttribute("aria-label") || playButton.textContent || "");
        result.playButtonLabel = ariaLabel || null;
        if (/play/i.test(ariaLabel)) {
          playButton.click();
          result.clickedPlayButton = true;
        }
      }
      if (!video) {
        return result;
      }
      video.muted = true;
      video.volume = 0;
      try {
        result.invokedPlay = true;
        const playback = video.play();
        if (playback && typeof playback.then === "function") {
          await playback;
        }
      } catch (error) {
        result.playError = sanitize(error?.message || String(error));
      }
      result.readyState = Number(video.readyState || 0);
      result.networkState = Number(video.networkState || 0);
      result.paused = Boolean(video.paused);
      result.currentTime = Number(video.currentTime || 0);
      result.src = sanitize(video.currentSrc || video.src || "") || null;
      return result;
    }),
    2500,
    {
      foundVideo: false,
      invokedPlay: false,
      clickedPlayButton: false,
      playError: "timeout"
    }
  );
}

async function waitForHeadlessMediaCandidate(page, mediaProbe, timeoutMs, sessionDetail, signal) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (signal?.aborted) {
      const error = signal.reason instanceof Error ? signal.reason : new Error("aborted");
      error.stageDetail = sessionDetail;
      throw error;
    }

    const candidate = mediaProbe.getBestCandidate();
    if (candidate) {
      return {
        ok: true,
        candidate
      };
    }

    await page.waitForTimeout(Math.min(250, timeoutMs)).catch(() => {});
  }

  const pageState = await captureAndRecordHeadlessSnapshot(page, sessionDetail, "audio-media-timeout");
  return {
    ok: false,
    errorCode: isYouTubeBotGatePageState(pageState)
      ? "asr_audio_browser_session_bot_gate"
      : "asr_audio_browser_session_media_missing",
    errorMessage: isYouTubeBotGatePageState(pageState)
      ? "YouTube blocked the browser-session audio fallback before usable media could be observed."
      : "The browser session did not surface a usable audio media request for ASR.",
    pageState,
    observedMediaCount: mediaProbe.getObservedCount()
  };
}

function createHeadlessMediaProbe(page, sessionDetail) {
  const observed = [];
  const requestMap = new WeakMap();

  const syncObserved = () => {
    sessionDetail.mediaRequests = normalizeTelemetryDetail(observed.map((entry) => entry.telemetry)) || [];
  };

  const ensureEntry = (request) => {
    let runtime = requestMap.get(request);
    if (!runtime) {
      const telemetry = {
        url: truncateText(request.url(), 240),
        method: request.method(),
        resourceType: request.resourceType(),
        status: null,
        ok: null,
        mimeType: null,
        queryMimeType: normalizeMediaMimeType(readQueryParam(request.url(), "mime")),
        contentLength: null,
        container: null,
        isAudioCandidate: false,
        failureCode: null,
        requestFailure: null
      };
      runtime = {
        url: request.url(),
        requestHeaders: summarizeObservedMediaHeaders(request.headers()),
        downloadHeaders: pickBrowserSessionDownloadHeaders(request.headers()),
        telemetry
      };
      observed.push(runtime);
      requestMap.set(request, runtime);
      syncObserved();
    }
    return runtime;
  };

  const onRequest = (request) => {
    if (!isHeadlessMediaRequest(request.url())) {
      return;
    }
    ensureEntry(request);
  };

  const onRequestFailed = (request) => {
    if (!isHeadlessMediaRequest(request.url())) {
      return;
    }
    const runtime = ensureEntry(request);
    runtime.telemetry.requestFailure = truncateText(request.failure()?.errorText || "", 240);
    runtime.telemetry.failureCode = "asr_audio_browser_session_request_failed";
    syncObserved();
  };

  const onResponse = (response) => {
    if (!isHeadlessMediaRequest(response.url())) {
      return;
    }
    const runtime = ensureEntry(response.request());
    const responseHeaders = response.headers();
    const candidate = buildBrowserSessionMediaCandidate({
      url: runtime.url,
      status: response.status(),
      ok: response.ok(),
      resourceType: runtime.telemetry.resourceType,
      requestHeaders: runtime.requestHeaders,
      downloadHeaders: runtime.downloadHeaders,
      responseHeaders
    });

    runtime.candidate = candidate;
    runtime.telemetry.status = candidate.status;
    runtime.telemetry.ok = candidate.ok;
    runtime.telemetry.mimeType = candidate.mimeType;
    runtime.telemetry.queryMimeType = candidate.queryMimeType;
    runtime.telemetry.contentLength = candidate.contentLength;
    runtime.telemetry.container = candidate.container;
    runtime.telemetry.isAudioCandidate = candidate.isAudioCandidate;
    syncObserved();
  };

  page.on("request", onRequest);
  page.on("requestfailed", onRequestFailed);
  page.on("response", onResponse);

  return {
    getBestCandidate: () =>
      selectBrowserSessionMediaCandidate(
        observed
          .map((entry) => entry.candidate)
          .filter(Boolean)
      ),
    getObservedCount: () => observed.length,
    dispose: () => {
      page.off("request", onRequest);
      page.off("requestfailed", onRequestFailed);
      page.off("response", onResponse);
    }
  };
}

function buildBrowserSessionMediaCandidate(input) {
  const queryMimeType = normalizeMediaMimeType(readQueryParam(input.url, "mime"));
  const headerMimeType = normalizeMediaMimeType(input.responseHeaders?.["content-type"]);
  const mimeType = headerMimeType || queryMimeType || null;
  const contentLength =
    toFiniteNumber(input.responseHeaders?.["content-length"]) ||
    toFiniteNumber(readQueryParam(input.url, "clen")) ||
    toFiniteNumber(parseContentRangeHeader(input.responseHeaders?.["content-range"])?.total) ||
    null;
  const container = inferAudioContainer(mimeType, input.url);
  const isAudioCandidate = shouldTreatAsAudioCandidate({
    mimeType,
    queryMimeType,
    container
  });
  return {
    url: input.url,
    status: Number(input.status || 0) || null,
    ok: input.ok === true,
    resourceType: input.resourceType || null,
    requestHeaders: input.requestHeaders || {},
    downloadHeaders: input.downloadHeaders || {},
    responseHeaders: summarizeObservedMediaHeaders(input.responseHeaders || {}),
    mimeType,
    queryMimeType,
    contentLength,
    container,
    isAudioCandidate,
    score: scoreBrowserSessionMediaCandidate({
      status: input.status,
      ok: input.ok,
      resourceType: input.resourceType,
      mimeType,
      queryMimeType,
      contentLength,
      container,
      url: input.url
    })
  };
}

function selectBrowserSessionMediaCandidate(candidates) {
  return (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => candidate && candidate.ok && candidate.isAudioCandidate)
    .sort((left, right) => {
      const scoreDelta = (right.score || 0) - (left.score || 0);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      return (right.contentLength || 0) - (left.contentLength || 0);
    })[0] || null;
}

async function downloadObservedBrowserSessionMedia(candidate, options) {
  if (!candidate?.url || typeof options.fetchImpl !== "function") {
    return {
      ok: false,
      warnings: ["asr_audio_browser_session_download_unconfigured"],
      errorCode: "asr_audio_browser_session_download_unconfigured",
      errorMessage: "The browser-session audio fallback is missing its download configuration.",
      detail: {
        acquisitionStrategy: "browser-session",
        failureKind: "unconfigured"
      }
    };
  }

  const outputDir = options.outputDir || path.join(os.tmpdir(), "scriptlens-asr-audio");
  await fs.mkdir(outputDir, { recursive: true });
  const extension = inferAudioContainer(candidate.mimeType, candidate.url) || "bin";
  const outputPath = path.join(outputDir, `scriptlens-browser-audio.${extension}`);
  const chunkSizeBytes = 8 * 1024 * 1024;
  const totalBytes = toFiniteNumber(candidate.contentLength) || null;
  const requests = [];
  let downloadedBytes = 0;
  let currentOffset = 0;
  let requestCount = 0;

  await fs.rm(outputPath, { force: true }).catch(() => {});

  while (true) {
    requestCount += 1;
    const rangeHeader =
      totalBytes && totalBytes > chunkSizeBytes
        ? `bytes=${currentOffset}-${Math.min(currentOffset + chunkSizeBytes - 1, totalBytes - 1)}`
        : requestCount === 1
          ? null
          : `bytes=${currentOffset}-${currentOffset + chunkSizeBytes - 1}`;

    let response;
    try {
      response = await options.fetchImpl(candidate.url, {
        headers: buildBrowserSessionDownloadHeaders(
          candidate.downloadHeaders || candidate.requestHeaders,
          options.watchUrl,
          rangeHeader
        ),
        redirect: "follow",
        signal: options.signal
      });
    } catch (error) {
      return {
        ok: false,
        warnings: ["asr_audio_browser_session_download_failed"],
        errorCode: "asr_audio_browser_session_download_failed",
        errorMessage: "The backend could not fetch the browser-session media URL for ASR.",
        detail: {
          acquisitionStrategy: "browser-session",
          selectedCandidate: summarizeBrowserSessionMediaCandidate(candidate),
          requestCount,
          requests,
          error: summarizeError(error),
          failureKind: "fetch_failed"
        }
      };
    }

    const contentRange = parseContentRangeHeader(response.headers.get("content-range"));
    const buffer = Buffer.from(await response.arrayBuffer());
    requests.push({
      status: response.status,
      ok: response.ok,
      contentType: normalizeMediaMimeType(response.headers.get("content-type")),
      contentLength: toFiniteNumber(response.headers.get("content-length")) || buffer.length,
      contentRange: response.headers.get("content-range") || null,
      bytesWritten: buffer.length,
      rangeHeader
    });

    if (!response.ok || !buffer.length) {
      return {
        ok: false,
        warnings: ["asr_audio_browser_session_download_failed"],
        errorCode:
          response.status === 403
            ? "asr_audio_browser_session_http_403"
            : "asr_audio_browser_session_download_failed",
        errorMessage:
          response.status === 403
            ? "The browser-session media URL was observed, but the backend fetch was blocked."
            : "The backend could not download a usable browser-session media asset for ASR.",
        detail: {
          acquisitionStrategy: "browser-session",
          selectedCandidate: summarizeBrowserSessionMediaCandidate(candidate),
          requestCount,
          requests,
          failureKind: !response.ok ? "http_failure" : "empty_body"
        }
      };
    }

    await fs.appendFile(outputPath, buffer);
    downloadedBytes += buffer.length;

    if (!totalBytes) {
      break;
    }
    if (response.status === 200) {
      break;
    }

    const observedTotal = toFiniteNumber(contentRange?.total) || totalBytes;
    currentOffset += buffer.length;
    if (currentOffset >= observedTotal) {
      break;
    }
  }

  return {
    ok: true,
    audioFilePath: outputPath,
    mimeType: candidate.mimeType || null,
    container: extension,
    detail: {
      acquisitionStrategy: "browser-session",
      selectedCandidate: summarizeBrowserSessionMediaCandidate(candidate),
      selectedAudioFile: path.basename(outputPath),
      selectedMimeType: candidate.mimeType || null,
      selectedContainer: extension,
      requestCount,
      downloadedBytes,
      requests,
      failureKind: null
    }
  };
}

function buildBrowserSessionDownloadHeaders(requestHeaders, watchUrl, rangeHeader) {
  const headers = {
    "accept-language": WATCH_PAGE_HEADERS["accept-language"],
    "user-agent": WATCH_PAGE_HEADERS["user-agent"],
    accept: "*/*",
    referer: watchUrl || "https://www.youtube.com/",
    origin: "https://www.youtube.com"
  };

  for (const key of ["accept", "accept-language", "cookie", "origin", "referer", "user-agent"]) {
    if (requestHeaders?.[key]) {
      headers[key] = requestHeaders[key];
    }
  }
  if (rangeHeader) {
    headers.range = rangeHeader;
  }
  return headers;
}

function summarizeObservedMediaHeaders(headers) {
  const source = headers && typeof headers === "object" ? headers : {};
  const result = {};
  for (const key of ["accept", "accept-language", "content-length", "content-range", "content-type", "origin", "range", "referer", "user-agent"]) {
    const value = source[key] ?? source[key.toLowerCase()] ?? source[key.toUpperCase()];
    if (value !== undefined && value !== null && String(value).trim()) {
      result[key.toLowerCase()] = truncateText(String(value), 240);
    }
  }
  return result;
}

function pickBrowserSessionDownloadHeaders(headers) {
  const source = headers && typeof headers === "object" ? headers : {};
  const result = {};
  for (const key of ["accept", "accept-language", "cookie", "origin", "referer", "user-agent"]) {
    const value = source[key] ?? source[key.toLowerCase()] ?? source[key.toUpperCase()];
    if (value !== undefined && value !== null && String(value).trim()) {
      result[key.toLowerCase()] = String(value);
    }
  }
  return result;
}

function normalizeMediaMimeType(value) {
  const text = String(value || "").split(";")[0].trim().toLowerCase();
  return text || null;
}

function shouldTreatAsAudioCandidate(input) {
  const mimeType = normalizeMediaMimeType(input.mimeType) || normalizeMediaMimeType(input.queryMimeType);
  if (mimeType && mimeType.startsWith("audio/")) {
    return true;
  }
  const itag = String(readQueryParam(input.url, "itag") || "").trim();
  if (["139", "140", "141", "249", "250", "251", "256", "258", "325", "328"].includes(itag)) {
    return true;
  }
  return ["m4a", "aac", "mp3", "opus", "ogg"].includes(String(input.container || "").toLowerCase()) &&
    !/^video\//i.test(String(input.queryMimeType || input.mimeType || ""));
}

function scoreBrowserSessionMediaCandidate(candidate) {
  let score = 0;
  if (candidate.ok) {
    score += 20;
  }
  if (Number(candidate.status) === 200) {
    score += 20;
  } else if (Number(candidate.status) === 206) {
    score += 16;
  }
  if (candidate.resourceType === "media") {
    score += 8;
  }
  if (shouldTreatAsAudioCandidate(candidate)) {
    score += 40;
  }
  if (candidate.container === "m4a" || candidate.container === "mp4") {
    score += 10;
  } else if (candidate.container === "webm") {
    score += 8;
  } else if (candidate.container === "opus") {
    score += 7;
  }
  if (candidate.contentLength) {
    score += Math.min(24, Math.round(candidate.contentLength / (1024 * 1024)));
  }
  if (/googlevideo/i.test(String(candidate.url || ""))) {
    score += 5;
  }
  return score;
}

function inferAudioContainer(mimeType, mediaUrl) {
  const normalizedMime = normalizeMediaMimeType(mimeType);
  if (normalizedMime === "audio/mp4" || normalizedMime === "video/mp4") {
    return "m4a";
  }
  if (normalizedMime === "audio/webm" || normalizedMime === "video/webm") {
    return "webm";
  }
  if (normalizedMime === "audio/ogg") {
    return "ogg";
  }
  if (normalizedMime === "audio/mpeg") {
    return "mp3";
  }

  const mimeQuery = normalizeMediaMimeType(readQueryParam(mediaUrl, "mime"));
  if (mimeQuery && mimeQuery !== normalizedMime) {
    return inferAudioContainer(mimeQuery, null);
  }

  try {
    const pathname = new URL(String(mediaUrl || "")).pathname || "";
    const match = pathname.match(/\.([a-z0-9]{2,5})$/i);
    return match?.[1]?.toLowerCase() || null;
  } catch (error) {
    return null;
  }
}

function summarizeBrowserSessionMediaCandidate(candidate) {
  if (!candidate) {
    return null;
  }
  return {
    url: truncateText(candidate.url || "", 240),
    status: candidate.status || null,
    ok: candidate.ok === true,
    mimeType: candidate.mimeType || null,
    queryMimeType: candidate.queryMimeType || null,
    container: candidate.container || null,
    contentLength: candidate.contentLength || null,
    score: candidate.score || null
  };
}

function isYouTubeBotGatePageState(pageState) {
  const bodySnippet = String(pageState?.bodySnippet || "");
  return /sign in to confirm you.?re not a bot/i.test(bodySnippet);
}

function readQueryParam(inputUrl, key) {
  try {
    const parsed = new URL(String(inputUrl || ""));
    return parsed.searchParams.get(key);
  } catch (error) {
    return null;
  }
}

function parseContentRangeHeader(value) {
  const text = String(value || "");
  const match = text.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
  if (!match) {
    return null;
  }
  return {
    start: toFiniteNumber(match[1]),
    end: toFiniteNumber(match[2]),
    total: match[3] === "*" ? null : toFiniteNumber(match[3])
  };
}

function buildAsrCommandArgs(request, commandConfig, context) {
  if (commandConfig.defaultHelper) {
    const args = []
      .concat(commandConfig.prefixArgs || [])
      .concat([
        "--audio-path",
        context.audioPath,
        "--output-path",
        context.outputPath
      ]);
    if (request.requestedLanguageCode) {
      args.push("--requested-language-code", request.requestedLanguageCode);
    }
    if (request.traceId) {
      args.push("--trace-id", request.traceId);
    }
    if (request.videoId) {
      args.push("--video-id", request.videoId);
    }
    return args;
  }

  const tokens = {
    audioPath: context.audioPath,
    outputPath: context.outputPath,
    languageCode:
      request.requestedLanguageCode || context.pageData?.languageCode || "",
    requestedLanguageCode: request.requestedLanguageCode || "",
    traceId: request.traceId || "",
    videoId: request.videoId || "",
    durationSeconds: String(context.pageData?.videoDurationSeconds || "")
  };
  return []
    .concat(commandConfig.prefixArgs || [])
    .concat(
      (Array.isArray(commandConfig.argsTemplate) ? commandConfig.argsTemplate : [])
        .map((value) => replaceTemplateTokens(value, tokens))
        .filter((value) => value !== "")
    );
}

function parseCommandArgsTemplate(optionArgs, envJson, envText) {
  if (Array.isArray(optionArgs)) {
    return optionArgs.map((value) => String(value));
  }
  if (typeof optionArgs === "string" && optionArgs.trim()) {
    return splitCommandArgs(optionArgs);
  }
  if (typeof envJson === "string" && envJson.trim()) {
    try {
      const parsed = JSON.parse(envJson);
      if (Array.isArray(parsed)) {
        return parsed.map((value) => String(value));
      }
    } catch (error) {
      // Fall through to the plain-text parser.
    }
  }
  if (typeof envText === "string" && envText.trim()) {
    return splitCommandArgs(envText);
  }
  return [];
}

function splitCommandArgs(value) {
  const matches = String(value || "").match(/"[^"]*"|'[^']*'|\S+/g) || [];
  return matches.map((entry) => entry.replace(/^['"]|['"]$/g, ""));
}

function replaceTemplateTokens(value, tokens) {
  return String(value || "").replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) =>
    Object.prototype.hasOwnProperty.call(tokens, key) ? String(tokens[key] || "") : ""
  );
}

function buildAsrInvocationDetail(input) {
  return {
    source: input.source || null,
    command: input.command || null,
    args: Array.isArray(input.args) ? input.args.slice() : [],
    exitCode:
      typeof input.executed?.code === "number" ? input.executed.code : null,
    signal: input.executed?.signal || null,
    outputFile: input.outputPath ? path.basename(input.outputPath) : null,
    outputExists: Boolean(input.outputPath),
    stderrTail: tailText(input.executed?.stderr),
    stdoutTail: tailText(input.executed?.stdout),
    error: input.error ? summarizeError(input.error) : null
  };
}

async function readAsrPayload(stdout, outputPath) {
  if (outputPath) {
    try {
      const fileText = await fs.readFile(outputPath, "utf8");
      if (String(fileText || "").trim()) {
        return fileText;
      }
    } catch (error) {
      // Fall back to stdout.
    }
  }
  return String(stdout || "");
}

function parseAsrPayload(source) {
  const text = String(source || "").trim();
  if (!text) {
    return { text: "", segments: [] };
  }

  if (!text.startsWith("{") && !text.startsWith("[")) {
    return {
      text: sanitizeText(text),
      segments: normalizeSegments([
        {
          startMs: 0,
          durationMs: null,
          text
        }
      ]),
      languageCode: null,
      originalLanguageCode: null,
      sourceConfidence: "low",
      warnings: []
    };
  }

  try {
    const payload = JSON.parse(text);
    const segments = normalizeSegments(
      (Array.isArray(payload?.segments) ? payload.segments : []).map((segment) => {
        const startMs =
          toFiniteNumber(segment?.startMs) ??
          secondsToMs(segment?.startSeconds) ??
          secondsToMs(segment?.start);
        const endMs =
          toFiniteNumber(segment?.endMs) ??
          secondsToMs(segment?.endSeconds) ??
          secondsToMs(segment?.end);
        const durationMs =
          toFiniteNumber(segment?.durationMs) ??
          secondsToMs(segment?.durationSeconds) ??
          secondsToMs(segment?.duration) ??
          (isFiniteNumber(startMs) && isFiniteNumber(endMs) ? Math.max(0, endMs - startMs) : null);
        return {
          startMs,
          durationMs,
          text: segment?.text || ""
        };
      })
    );
    return {
      text: sanitizeText(payload?.text || segments.map((segment) => segment.text).join("\n")),
      segments,
      languageCode: normalizeLanguage(payload?.languageCode || payload?.language),
      originalLanguageCode: normalizeLanguage(
        payload?.originalLanguageCode || payload?.originalLanguage || payload?.languageCode || payload?.language
      ),
      sourceConfidence: normalizeConfidence(payload?.sourceConfidence) || "low",
      warnings: Array.isArray(payload?.warnings) ? dedupeList(payload.warnings) : [],
      segmentQualityScore: toFiniteNumber(payload?.segmentQualityScore),
      detail:
        payload?.detail && typeof payload.detail === "object" && !Array.isArray(payload.detail)
          ? payload.detail
          : null
    };
  } catch (error) {
    return {
      text: "",
      segments: [],
      warnings: ["asr_output_invalid_json"]
    };
  }
}

function readAsrFailureMessage(stderr, stdout) {
  const source = sanitizeText(String(stderr || stdout || ""));
  if (!source) {
    return "The configured ASR command failed.";
  }

  const lines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-3).join(" ");
}

function secondsToMs(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 1000) : null;
}

function tailText(value, maxLength = 400) {
  const text = sanitizeText(String(value || ""));
  if (!text) {
    return "";
  }
  return text.length <= maxLength ? text : text.slice(text.length - maxLength);
}

function sanitizeCommandArgs(args) {
  const values = Array.isArray(args) ? args.slice() : [];
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === "--cookies" && index + 1 < values.length) {
      values[index + 1] = "[redacted]";
    }
  }
  return values;
}

function truncateText(value, maxLength = 400) {
  const text = sanitizeText(String(value || ""));
  if (!text) {
    return "";
  }
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function spawnProcess(options) {
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args || [], {
      env: options.env || process.env,
      windowsHide: true,
      detached: process.platform !== "win32"
    });
    const stdout = [];
    const stderr = [];
    let settled = false;

    const cleanupAbort = attachProcessAbort(options.signal, child, () => {
      if (!settled) {
        settled = true;
        const error = new Error("timeout");
        error.partialResult = {
          code: null,
          signal: null,
          stdout: stdout.join(""),
          stderr: stderr.join("")
        };
        reject(error);
      }
    });

    child.stdout?.on("data", (chunk) => stdout.push(String(chunk || "")));
    child.stderr?.on("data", (chunk) => stderr.push(String(chunk || "")));
    child.once("error", (error) => {
      cleanupAbort();
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once("close", (code, signal) => {
      cleanupAbort();
      if (!settled) {
        settled = true;
        resolve({
          code: Number.isFinite(code) ? code : 0,
          signal: signal || null,
          stdout: stdout.join(""),
          stderr: stderr.join("")
        });
      }
    });
  });
}

function attachProcessAbort(signal, child, onAbort) {
  if (!signal) {
    return () => {};
  }

  const abort = () => {
    terminateChildProcess(child);
    if (typeof onAbort === "function") {
      onAbort();
    }
  };

  if (signal.aborted) {
    abort();
    return () => {};
  }

  signal.addEventListener("abort", abort, { once: true });
  return () => {
    signal.removeEventListener("abort", abort);
  };
}

function terminateChildProcess(child) {
  if (!child || child.killed) {
    return;
  }

  if (process.platform !== "win32" && Number.isFinite(child.pid)) {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch (error) {
      // Fall back to direct termination below.
    }
  }

  try {
    child.kill("SIGTERM");
  } catch (error) {
    // Ignore kill races on already-closed processes.
  }
}

function readProcessFailureMessage(stderr, stdout) {
  const source = sanitizeText(String(stderr || stdout || ""));
  if (!source) {
    return "The yt-dlp transcript fallback failed.";
  }

  const lines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-3).join(" ");
}

function parseCaptionPayload(source) {
  const text = String(source || "").trim();
  if (!text) {
    return { text: "", segments: [] };
  }
  if (text.startsWith("{")) {
    return parseJsonCaptionPayload(text);
  }
  if (text.startsWith("WEBVTT")) {
    return parseVttCaptionPayload(text);
  }
  return parseXmlCaptionPayload(text);
}

function parseJsonCaptionPayload(source) {
  try {
    const parsed = JSON.parse(source);
    const segments = (parsed?.events || [])
      .map((event) => {
        const text = sanitizeText(
          ((event?.segs || [])
            .map((part) => decodeEntities(part?.utf8 || ""))
            .join(""))
        );

        if (!text) {
          return null;
        }

        return {
          startMs: toFiniteNumber(event?.tStartMs),
          durationMs: toFiniteNumber(event?.dDurationMs),
          text
        };
      })
      .filter(Boolean);
    return finalizeCaptionSegments(segments);
  } catch (error) {
    return { text: "", segments: [] };
  }
}

function parseXmlCaptionPayload(source) {
  const pattern = /<(text|p)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  const segments = [];
  let match = null;

  while ((match = pattern.exec(source))) {
    const text = sanitizeText(decodeEntities(stripHtml(match[3] || "")));
    if (!text) {
      continue;
    }
    segments.push({
      startMs: parseAttributeTime(match[2], ["t", "start", "begin"]),
      durationMs: parseAttributeTime(match[2], ["d", "dur"]),
      text
    });
  }

  return finalizeCaptionSegments(segments);
}

function parseVttCaptionPayload(source) {
  const lines = String(source || "").split(/\r?\n/);
  const segments = [];
  let currentCue = null;

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      if (currentCue?.text) {
        segments.push(currentCue);
      }
      currentCue = null;
      return;
    }

    if (trimmed === "WEBVTT" || /^\d+$/.test(trimmed) || /^(NOTE|STYLE|REGION)\b/.test(trimmed)) {
      return;
    }

    const timing = trimmed.match(
      /^((?:\d{2}:)?\d{2}:\d{2}\.\d{3})\s+-->\s+((?:\d{2}:)?\d{2}:\d{2}\.\d{3})/
    );
    if (timing) {
      currentCue = {
        startMs: parseVttTime(timing[1]),
        durationMs: Math.max(0, parseVttTime(timing[2]) - parseVttTime(timing[1])),
        text: ""
      };
      return;
    }

    if (!currentCue) {
      return;
    }

    currentCue.text = sanitizeText(
      [currentCue.text, decodeEntities(stripHtml(trimmed))].filter(Boolean).join(" ")
    );
  });

  if (currentCue?.text) {
    segments.push(currentCue);
  }

  return finalizeCaptionSegments(segments);
}

function finalizeCaptionSegments(segments) {
  const normalized = normalizeSegments(segments);
  return {
    text: sanitizeText(normalized.map((segment) => segment.text).join("\n")),
    segments: normalized
  };
}

function pickPreferredTrack(tracks, requestedLanguageCode) {
  const normalizedTracks = (Array.isArray(tracks) ? tracks : []).map((track) => ({
    ...track,
    languageCode: normalizeLanguage(track.languageCode)
  }));
  const requested = normalizeLanguage(requestedLanguageCode);
  const manualTracks = normalizedTracks.filter((track) => track.kind !== "asr");
  const generatedTracks = normalizedTracks.filter((track) => track.kind === "asr");
  const requestedManual = manualTracks.find((track) => languageMatches(track.languageCode, requested));
  const requestedGenerated = generatedTracks.find((track) =>
    languageMatches(track.languageCode, requested)
  );
  const englishManual = manualTracks.find((track) => languageMatches(track.languageCode, "en"));
  const englishGenerated = generatedTracks.find((track) =>
    languageMatches(track.languageCode, "en")
  );

  return (
    requestedManual ||
    requestedGenerated ||
    englishManual ||
    englishGenerated ||
    manualTracks[0] ||
    generatedTracks[0] ||
    null
  );
}

function readCaptionTracks(playerResponse) {
  return Array.isArray(
    playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks
  )
    ? playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks
    : [];
}

function readInnertubeValue(pageData, key) {
  return (
    pageData?.ytcfg?.[key] ||
    pageData?.ytcfg?.WEB_PLAYER_CONTEXT_CONFIGS?.WEB_PLAYER_CONTEXT_CONFIG_ID_KEVLAR_WATCH?.[key] ||
    null
  );
}

function readClientContext(pageData, clientName, clientVersion) {
  if (pageData?.ytcfg?.INNERTUBE_CONTEXT?.client) {
    return pageData.ytcfg.INNERTUBE_CONTEXT;
  }

  if (!clientName || !clientVersion) {
    return null;
  }

  return {
    client: {
      clientName,
      clientVersion,
      hl: "en",
      gl: "US"
    }
  };
}

function findTranscriptParams(source) {
  const queue = [source];
  const seen = new Set();

  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (
      current.getTranscriptEndpoint &&
      typeof current.getTranscriptEndpoint.params === "string"
    ) {
      return current.getTranscriptEndpoint.params;
    }

    Object.keys(current).forEach((key) => {
      const value = current[key];
      if (value && typeof value === "object") {
        queue.push(value);
      }
    });
  }

  return "";
}

async function readYoutubeiFailure(response) {
  let payload = null;
  try {
    payload = await response.json();
  } catch (error) {
    payload = null;
  }

  const descriptor = `${response.status} ${payload?.error?.message || payload?.error?.status || ""}`.toUpperCase();
  if (descriptor.includes("FAILED_PRECONDITION")) {
    return {
      warnings: ["youtubei_failed_precondition"],
      errorCode: "youtubei_failed_precondition",
      errorMessage: "The reconstructed youtubei transcript request failed a precondition check."
    };
  }

  return {
    warnings: ["youtubei_failed"],
    errorCode: `youtubei_http_${response.status}`,
    errorMessage: `The youtubei transcript endpoint returned ${response.status}.`
  };
}

function parseYoutubeiTranscript(payload) {
  const segments = [];
  collectTranscriptRenderers(payload, segments);
  const normalizedSegments = normalizeSegments(segments);

  return {
    text: sanitizeText(normalizedSegments.map((segment) => segment.text).join("\n")),
    segments: normalizedSegments,
    languageCode: findFirstScalar(payload, "languageCode"),
    originalLanguageCode: findFirstScalar(payload, "originalLanguageCode"),
    isGenerated: findFirstScalar(payload, "kind") === "asr",
    isTranslated: Boolean(findFirstScalar(payload, "isTranslated")),
    isMachineTranslated: Boolean(findFirstScalar(payload, "isMachineTranslated")),
    videoDurationSeconds: null
  };
}

function collectTranscriptRenderers(node, output) {
  if (!node || typeof node !== "object") {
    return;
  }

  if (node.transcriptSegmentRenderer || node.transcriptCueRenderer) {
    const renderer = node.transcriptSegmentRenderer || node.transcriptCueRenderer;
    const text = sanitizeText(readRunsText(renderer.snippet) || readRunsText(renderer.cue));
    if (text) {
      output.push({
        startMs:
          toFiniteNumber(renderer.startMs) ||
          parseTimestampLabel(readRunsText(renderer.startTimeText)) ||
          parseTimestampLabel(readRunsText(renderer.startOffsetText)),
        durationMs: toFiniteNumber(renderer.durationMs),
        text
      });
    }
  }

  Object.keys(node).forEach((key) => {
    const value = node[key];
    if (Array.isArray(value)) {
      value.forEach((entry) => collectTranscriptRenderers(entry, output));
      return;
    }
    if (value && typeof value === "object") {
      collectTranscriptRenderers(value, output);
    }
  });
}

function findFirstScalar(node, keyName) {
  const queue = [node];
  const seen = new Set();

  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (Object.prototype.hasOwnProperty.call(current, keyName)) {
      return current[keyName];
    }

    Object.keys(current).forEach((key) => {
      const value = current[key];
      if (value && typeof value === "object") {
        queue.push(value);
      }
    });
  }

  return null;
}

async function maybeAcceptConsent(page) {
  const buttons = [
    page.getByRole("button", { name: /Accept all/i }),
    page.getByRole("button", { name: /I agree/i })
  ];

  for (const locator of buttons) {
    if (await locator.count().catch(() => 0)) {
      const buttonLabel = await locator.first().textContent().catch(() => "");
      await locator.first().click({ timeout: 1000 }).catch(() => {});
      await page.waitForTimeout(400);
      return {
        accepted: true,
        buttonLabel: sanitizeText(buttonLabel)
      };
    }
  }

  return {
    accepted: false,
    buttonLabel: null
  };
}

async function maybeApplyAuthenticatedBrowserSession(context, input) {
  const authConfig = resolveBackendAuthConfig(input.policy);
  const baseDetail = {
    authenticatedModeEnabled: authConfig.enabled,
    authenticatedAcquisitionUsed: false,
    acquisitionPathUsed: null
  };
  if (!authConfig.enabled || !authConfig.useForBrowserSession) {
    return {
      ok: true,
      ...baseDetail,
      detail: {
        ...baseDetail,
        mode: authConfig.mode,
        browserSessionEnabled: authConfig.useForBrowserSession
      }
    };
  }

  try {
    const cookies = await loadBrowserSessionCookies(authConfig.cookieFilePath, input.requestUrl);
    if (!cookies.length) {
      return {
        ok: false,
        ...baseDetail,
        detail: {
          ...baseDetail,
          mode: authConfig.mode,
          browserSessionEnabled: authConfig.useForBrowserSession,
          warningCode: "auth_cookie_file_empty"
        }
      };
    }
    await context.addCookies(cookies);
    return {
      ok: true,
      authenticatedModeEnabled: true,
      authenticatedAcquisitionUsed: true,
      acquisitionPathUsed: "authenticated-browser-session",
      detail: {
        authenticatedModeEnabled: true,
        authenticatedAcquisitionUsed: true,
        acquisitionPathUsed: "authenticated-browser-session",
        mode: authConfig.mode,
        browserSessionEnabled: authConfig.useForBrowserSession,
        cookieCount: cookies.length
      }
    };
  } catch (error) {
    return {
      ok: false,
      ...baseDetail,
      detail: {
        ...baseDetail,
        mode: authConfig.mode,
        browserSessionEnabled: authConfig.useForBrowserSession,
        warningCode: "auth_cookie_load_failed",
        error: summarizeError(error)
      }
    };
  }
}

async function loadBrowserSessionCookies(cookieFilePath, requestUrl) {
  const source = await fs.readFile(cookieFilePath, "utf8");
  const requestHost = readRequestHostname(requestUrl);
  return source
    .split(/\r?\n/)
    .map((line) => parseCookieFileLine(line))
    .filter(Boolean)
    .filter((cookie) => shouldIncludeCookie(cookie, requestHost));
}

function parseCookieFileLine(line) {
  const text = String(line || "").trim();
  if (!text || (text.startsWith("#") && !text.startsWith("#HttpOnly_"))) {
    return null;
  }

  const parts = text.split("\t");
  if (parts.length < 7) {
    return null;
  }

  let [domain, includeSubdomains, pathValue, secureFlag, expires, name, value] = parts;
  let httpOnly = false;
  if (domain.startsWith("#HttpOnly_")) {
    httpOnly = true;
    domain = domain.slice("#HttpOnly_".length);
  }
  domain = String(domain || "").trim();
  name = String(name || "").trim();
  value = String(value || "");
  if (!domain || !name) {
    return null;
  }

  const cookie = {
    name,
    value,
    domain,
    path: String(pathValue || "/").trim() || "/",
    httpOnly,
    secure: /^true$/i.test(String(secureFlag || "")),
    sameSite: "Lax"
  };
  const expiresValue = Number(expires);
  if (Number.isFinite(expiresValue) && expiresValue > 0) {
    cookie.expires = expiresValue;
  }
  if (/^false$/i.test(String(includeSubdomains || "")) && cookie.domain.startsWith(".")) {
    cookie.domain = cookie.domain.slice(1);
  }
  return cookie;
}

function readRequestHostname(requestUrl) {
  try {
    return new URL(String(requestUrl || "")).hostname.toLowerCase();
  } catch (error) {
    return "";
  }
}

function shouldIncludeCookie(cookie, requestHost) {
  const domain = String(cookie?.domain || "").trim().toLowerCase();
  if (!domain) {
    return false;
  }
  if (!requestHost) {
    return true;
  }
  const normalizedDomain = domain.startsWith(".") ? domain.slice(1) : domain;
  return (
    requestHost === normalizedDomain ||
    requestHost.endsWith(`.${normalizedDomain}`) ||
    normalizedDomain.endsWith("youtube.com") ||
    normalizedDomain.endsWith("google.com") ||
    normalizedDomain.endsWith("googlevideo.com")
  );
}

function resolveHeadlessConfig(policy) {
  const config = (policy || RECOVERY_POLICY).backend?.headless || {};
  const launchArgs = dedupeList([]
    .concat(Array.isArray(config.launchArgs) ? config.launchArgs : [])
    .concat(Array.isArray(config.extraLaunchArgs) ? config.extraLaunchArgs : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean));

  return {
    chromiumSandbox: config.chromiumSandbox === true,
    navigationTimeoutMs: clampNumber(
      config.navigationTimeoutMs,
      1000,
      60000,
      15000
    ),
    transcriptWaitMs: clampNumber(
      config.transcriptWaitMs,
      250,
      30000,
      6000
    ),
    settleMs: clampNumber(
      config.settleMs,
      0,
      10000,
      1500
    ),
    launchArgs
  };
}

function summarizeHeadlessLaunchOptions(config) {
  return {
    chromiumSandbox: Boolean(config.chromiumSandbox),
    navigationTimeoutMs: config.navigationTimeoutMs,
    transcriptWaitMs: config.transcriptWaitMs,
    settleMs: config.settleMs,
    args: Array.isArray(config.launchArgs) ? config.launchArgs.slice() : []
  };
}

function recordHeadlessStep(headlessDetail, step, startedAt, outcome, detail) {
  headlessDetail.steps.push({
    step,
    outcome,
    durationMs: Math.max(0, Date.now() - startedAt),
    detail: normalizeTelemetryDetail(detail)
  });
}

function buildHeadlessFailure(errorCode, errorMessage, pageData, headlessDetail) {
  return {
    ok: false,
    warnings: [errorCode],
    errorCode,
    errorMessage,
    pageData: mergeHeadlessPageData(pageData, null, headlessDetail),
    detail: headlessDetail
  };
}

function mergeHeadlessPageData(basePageData, overridePageData, headlessDetail, explicitDurationSeconds) {
  const merged = {
    ...(basePageData || {}),
    ...(overridePageData || {})
  };

  const inferredDurationSeconds =
    toFiniteNumber(explicitDurationSeconds) ||
    toFiniteNumber(overridePageData?.videoDurationSeconds) ||
    toFiniteNumber(basePageData?.videoDurationSeconds) ||
    toFiniteNumber(headlessDetail?.lastKnownState?.videoDurationSeconds) ||
    toFiniteNumber(
      Array.isArray(headlessDetail?.pageSnapshots)
        ? headlessDetail.pageSnapshots
            .slice()
            .reverse()
            .map((snapshot) => snapshot?.pageState?.videoDurationSeconds)
            .find((value) => Number.isFinite(Number(value)))
        : null
    ) ||
    null;

  if (isFiniteNumber(inferredDurationSeconds)) {
    merged.videoDurationSeconds = inferredDurationSeconds;
  }

  return merged;
}

async function openTranscriptPanel(page, options = {}) {
  const attempts = [];
  if (await withPromiseTimeout(waitForTranscriptSegments(page, 300), 500, false)) {
    return {
      opened: true,
      route: "already-open",
      attempts
    };
  }

  const expandResult = await withPromiseTimeout(
    ensureDescriptionExpanded(page),
    1200,
    {
      expanded: false,
      route: "timeout",
      selector: null,
      buttonLabel: null
    }
  );
  if (expandResult?.expanded) {
    await page.waitForTimeout(350).catch(() => {});
  }

  const directSelectors = [
    "button[aria-label*='transcript' i]",
    "button[title*='transcript' i]",
    "ytd-video-description-transcript-section-renderer button"
  ];

  for (const selector of directSelectors) {
    const locator = page.locator(selector).first();
    const clicked = await clickLocatorQuickly(locator);
    attempts.push({
      route: "direct-selector",
      selector,
      clicked
    });
    if (clicked) {
      return {
        opened: true,
        route: "direct-selector",
        selector,
        expand: expandResult,
        attempts
      };
    }
  }

  const evaluateClick = await clickTranscriptButtonViaEvaluate(page);
  attempts.push({
    route: "evaluate-click",
    selector: evaluateClick?.selector || null,
    clicked: Boolean(evaluateClick?.clicked),
    panelOpened: Boolean(evaluateClick?.panelOpened),
    transcriptSelected: Boolean(evaluateClick?.transcriptSelected),
    candidateCount: evaluateClick?.candidateCount || 0,
    attemptCount: Array.isArray(evaluateClick?.attempts) ? evaluateClick.attempts.length : 0
  });
  if (evaluateClick?.clicked) {
    const panelVisible = await waitForTranscriptPanelVisible(page, 1500);
    return {
      opened: panelVisible || evaluateClick?.panelOpened || evaluateClick?.transcriptSelected,
      route: "evaluate-click",
      selector: evaluateClick.selector || null,
      buttonLabel: evaluateClick.buttonLabel || null,
      expand: expandResult,
      panelOpened: panelVisible || evaluateClick?.panelOpened || false,
      transcriptSelected: Boolean(evaluateClick?.transcriptSelected),
      evaluateAttempts: Array.isArray(evaluateClick?.attempts)
        ? evaluateClick.attempts.slice(0, 8)
        : [],
      attempts
    };
  }

  return {
    opened: false,
    route: null,
    expand: expandResult,
    attempts
  };
}

async function clickLocatorQuickly(locator, timeoutMs = 300) {
  if (!locator) {
    return false;
  }

  const count = await withPromiseTimeout(locator.count().catch(() => 0), timeoutMs, 0);
  if (!count) {
    return false;
  }

  const target = typeof locator.first === "function" ? locator.first() : locator;
  const isVisible = await withPromiseTimeout(
    target.isVisible({ timeout: timeoutMs }).catch(() => false),
    timeoutMs + 100,
    false
  );
  if (!isVisible) {
    return false;
  }

  return withPromiseTimeout(
    target
      .click({ timeout: timeoutMs, force: true })
      .then(() => true)
      .catch(() => false),
    timeoutMs + 100,
    false
  );
}

async function waitForTranscriptSegments(page, timeoutMs) {
  try {
    await page.waitForFunction(() => {
      return document.querySelectorAll("ytd-transcript-segment-renderer").length > 0;
    }, { timeout: timeoutMs });
    return true;
  } catch (error) {
    return false;
  }
}

function updateStageDetailRef(detailRef, detail) {
  if (detailRef && typeof detailRef === "object") {
    detailRef.current = detail;
  }
}

async function captureAndRecordHeadlessSnapshot(page, headlessDetail, label) {
  if (!page || !headlessDetail) {
    return null;
  }
  const pageState = await captureHeadlessPageState(page);
  if (!pageState) {
    return null;
  }
  headlessDetail.lastKnownState = pageState;
  headlessDetail.pageSnapshots.push({
    label,
    capturedAt: Date.now(),
    pageState
  });
  return pageState;
}

async function captureHeadlessPageState(page) {
  if (!page) {
    return null;
  }

  try {
    return await page.evaluate(() => {
      const sanitize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const parseClockDuration = (value) => {
        const text = sanitize(value);
        if (!text) {
          return null;
        }
        const match = text.match(/^(\d{1,2}:)?\d{1,2}:\d{2}$/);
        if (!match) {
          return null;
        }
        const parts = text.split(":").map((part) => Number(part));
        if (parts.some((part) => !Number.isFinite(part))) {
          return null;
        }
        if (parts.length === 2) {
          return (parts[0] * 60) + parts[1];
        }
        if (parts.length === 3) {
          return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
        }
        return null;
      };
      const parseIsoDuration = (value) => {
        const text = sanitize(value);
        const match = text.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
        if (!match) {
          return null;
        }
        return ((Number(match[1] || 0) * 3600) + (Number(match[2] || 0) * 60) + Number(match[3] || 0)) || null;
      };
      const parseDurationFromText = (value) => {
        const text = sanitize(value);
        if (!text) {
          return null;
        }
        const direct = parseClockDuration(text) || parseIsoDuration(text);
        if (direct) {
          return direct;
        }
        const pairMatch = text.match(/\b\d{1,2}:\d{2}(?::\d{2})?\s*\/\s*(\d{1,2}:\d{2}(?::\d{2})?)\b/);
        if (pairMatch?.[1]) {
          return parseClockDuration(pairMatch[1]);
        }
        const allMatches = text.match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g) || [];
        for (let index = allMatches.length - 1; index >= 0; index -= 1) {
          const parsed = parseClockDuration(allMatches[index]);
          if (parsed) {
            return parsed;
          }
        }
        return null;
      };
      const readVideoDurationSeconds = () => {
        const directDuration = Number(
          globalThis.ytInitialPlayerResponse?.videoDetails?.lengthSeconds ||
            globalThis.ytplayer?.config?.args?.length_seconds ||
            0
        ) || null;
        if (directDuration) {
          return directDuration;
        }
        const playerDuration = Number(
          document.querySelector("#movie_player")?.getDuration?.() ||
            globalThis.ytInitialPlayerResponse?.microformat?.playerMicroformatRenderer?.lengthSeconds ||
            0
        ) || null;
        if (playerDuration) {
          return Math.round(playerDuration);
        }
        const videoDuration = Number(document.querySelector("video")?.duration || 0) || null;
        if (videoDuration) {
          return Math.round(videoDuration);
        }
        const metaDuration = parseIsoDuration(
          document.querySelector('meta[itemprop=\"duration\"]')?.getAttribute("content") || ""
        );
        if (metaDuration) {
          return metaDuration;
        }
        const timeDuration = parseDurationFromText(
          document.querySelector(".ytp-time-duration")?.textContent || ""
        );
        if (timeDuration) {
          return timeDuration;
        }
        return null;
      };
      const isVisible = (element) => {
        if (!element || typeof element.getBoundingClientRect !== "function") {
          return false;
        }
        const style = globalThis.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return Boolean(
          style &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number(rect.width) > 0 &&
            Number(rect.height) > 0
        );
      };
      const summarizeButtons = (nodes) =>
        nodes.slice(0, 4).map((node) => ({
          label: sanitize(
            node.getAttribute("aria-label") ||
              node.getAttribute("title") ||
              node.textContent ||
              ""
          ).slice(0, 120),
          visible: isVisible(node)
        }));
      const transcriptButtons = Array.from(document.querySelectorAll("button, tp-yt-paper-button"))
        .filter((node) => /transcript/i.test(
          [
            node.getAttribute("aria-label"),
            node.getAttribute("title"),
            node.textContent
          ]
            .filter(Boolean)
            .join(" ")
        ));
      const descriptionTranscriptButtons = Array.from(
        document.querySelectorAll("ytd-video-description-transcript-section-renderer button")
      );
      const expandButtons = Array.from(
        document.querySelectorAll(
          "#description-inline-expander #expand, ytd-text-inline-expander #expand, ytd-expandable-video-description-body-renderer #expand, #meta-contents #expand"
        )
      );
      const transcriptPanels = Array.from(
        document.querySelectorAll(
          "ytd-engagement-panel-section-list-renderer[target-id], ytd-engagement-panel-section-list-renderer, ytd-transcript-search-panel-renderer, [target-id*='transcript' i]"
        )
      )
        .filter((node) => /transcript/i.test(
          [
            node.getAttribute("target-id"),
            node.getAttribute("visibility"),
            node.id,
            node.tagName
          ]
            .filter(Boolean)
            .join(" ")
        ))
        .slice(0, 6)
        .map((node) => {
          const style = globalThis.getComputedStyle(node);
          return {
            targetId: sanitize(node.getAttribute("target-id") || node.id || node.tagName),
            display: style?.display || null,
            visibility: style?.visibility || null,
            hidden: node.hasAttribute("hidden"),
            ariaHidden: node.getAttribute("aria-hidden"),
            visible: isVisible(node)
          };
        });

      return {
        title: sanitize(document.title).slice(0, 160),
        url: sanitize(globalThis.location?.href || "").slice(0, 240),
        languageCode: sanitize(document.documentElement.lang || "") || null,
        videoDurationSeconds: readVideoDurationSeconds(),
        bodySnippet: sanitize(document.body?.innerText || "").slice(0, 240),
        transcriptButtons: {
          total: transcriptButtons.length,
          visible: transcriptButtons.filter((node) => isVisible(node)).length,
          labels: summarizeButtons(transcriptButtons)
        },
        descriptionTranscriptButtons: {
          total: descriptionTranscriptButtons.length,
          visible: descriptionTranscriptButtons.filter((node) => isVisible(node)).length,
          labels: summarizeButtons(descriptionTranscriptButtons)
        },
        expandButtons: {
          total: expandButtons.length,
          visible: expandButtons.filter((node) => isVisible(node)).length,
          labels: summarizeButtons(expandButtons)
        },
        transcriptPanels,
        segmentCount: document.querySelectorAll("ytd-transcript-segment-renderer").length
      };
    });
  } catch (error) {
    return {
      captureError: summarizeError(error)
    };
  }
}

function createHeadlessTranscriptProbe(page, headlessDetail) {
  const requests = [];
  const requestMap = new WeakMap();
  let lastFailure = null;

  const syncRequests = () => {
    headlessDetail.transcriptRequests = normalizeTelemetryDetail(requests) || [];
  };

  const ensureEntry = (request) => {
    let entry = requestMap.get(request);
    if (!entry) {
      entry = {
        url: truncateText(request.url(), 240),
        method: request.method(),
        postDataSnippet: truncateText(request.postData() || "", 240),
        status: null,
        ok: null,
        responseBodySnippet: "",
        requestFailure: null,
        failureCode: null
      };
      requests.push(entry);
      requestMap.set(request, entry);
      syncRequests();
    }
    return entry;
  };

  const onRequest = (request) => {
    if (!isHeadlessTranscriptRequest(request.url())) {
      return;
    }
    ensureEntry(request);
  };

  const onRequestFailed = (request) => {
    if (!isHeadlessTranscriptRequest(request.url())) {
      return;
    }
    const entry = ensureEntry(request);
    entry.requestFailure = truncateText(request.failure()?.errorText || "", 240);
    entry.failureCode = "backend_headless_transcript_request_failed";
    lastFailure = {
      errorCode: "backend_headless_transcript_request_failed",
      errorMessage: "The headless transcript request failed before transcript data was returned.",
      transcriptRequest: normalizeTelemetryDetail(entry)
    };
    syncRequests();
  };

  const onResponse = async (response) => {
    if (!isHeadlessTranscriptRequest(response.url())) {
      return;
    }
    const request = response.request();
    const entry = ensureEntry(request);
    entry.status = response.status();
    entry.ok = response.ok();
    let bodyText = "";
    try {
      bodyText = await response.text();
    } catch (error) {
      bodyText = "";
    }
    entry.responseBodySnippet = truncateText(bodyText, 240);
    const failure = classifyHeadlessTranscriptFailure(response.status(), bodyText);
    if (failure) {
      entry.failureCode = failure.errorCode;
      lastFailure = {
        errorCode: failure.errorCode,
        errorMessage: failure.errorMessage,
        transcriptRequest: normalizeTelemetryDetail(entry)
      };
    }
    syncRequests();
  };

  page.on("request", onRequest);
  page.on("requestfailed", onRequestFailed);
  page.on("response", onResponse);

  return {
    getFailure: () => (lastFailure ? normalizeTelemetryDetail(lastFailure) : null),
    dispose: () => {
      page.off("request", onRequest);
      page.off("requestfailed", onRequestFailed);
      page.off("response", onResponse);
    }
  };
}

async function waitForHeadlessTranscriptOutcome(
  page,
  transcriptProbe,
  timeoutMs,
  headlessDetail,
  signal
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (signal?.aborted) {
      const error = signal.reason instanceof Error ? signal.reason : new Error("aborted");
      error.stageDetail = headlessDetail;
      throw error;
    }
    const segmentCount = await readHeadlessTranscriptSegmentCount(page);
    if (segmentCount > 0) {
      return {
        ok: true,
        segmentCount
      };
    }

    const failure = transcriptProbe.getFailure();
    if (failure?.errorCode) {
      const pageState = await captureAndRecordHeadlessSnapshot(
        page,
        headlessDetail,
        "transcript-request-failed"
      );
      return {
        ok: false,
        errorCode: failure.errorCode,
        errorMessage: failure.errorMessage,
        pageState
      };
    }

    await page.waitForTimeout(Math.min(250, timeoutMs)).catch(() => {});
  }

  const pageState = await captureAndRecordHeadlessSnapshot(
    page,
    headlessDetail,
    "wait-segments-timeout"
  );
  return {
    ok: false,
    errorCode: "backend_headless_segments_missing",
    errorMessage: "The transcript controls opened, but no transcript segments were rendered.",
    pageState
  };
}

async function readHeadlessTranscriptSegmentCount(page) {
  try {
    return await page.evaluate(
      () => document.querySelectorAll("ytd-transcript-segment-renderer").length
    );
  } catch (error) {
    return 0;
  }
}

function isHeadlessTranscriptRequest(url) {
  return /youtubei\/v1\/get_transcript/i.test(String(url || ""));
}

function isHeadlessMediaRequest(url) {
  const text = String(url || "");
  return /videoplayback/i.test(text) && /googlevideo/i.test(text);
}

function classifyHeadlessTranscriptFailure(status, responseBody) {
  const code = Number(status);
  const bodyText = String(responseBody || "");
  if (!Number.isFinite(code) || code < 400) {
    return null;
  }
  if (code === 400 && /FAILED_PRECONDITION/i.test(bodyText)) {
    return {
      errorCode: "backend_headless_transcript_failed_precondition",
      errorMessage: "YouTube refused transcript data for this video after the transcript panel was opened."
    };
  }
  if (code === 400) {
    return {
      errorCode: "backend_headless_transcript_http_400",
      errorMessage: "YouTube rejected the transcript request after the transcript panel was opened."
    };
  }
  if (code === 403) {
    return {
      errorCode: "backend_headless_transcript_http_403",
      errorMessage: "YouTube blocked the transcript request after the transcript panel was opened."
    };
  }
  return {
    errorCode: `backend_headless_transcript_http_${code}`,
    errorMessage: `The transcript request failed with HTTP ${code} after the transcript panel was opened.`
  };
}

async function ensureDescriptionExpanded(page) {
  const selectors = [
    "#description-inline-expander #expand",
    "ytd-text-inline-expander #expand",
    "ytd-expandable-video-description-body-renderer #expand",
    "#meta-contents #expand"
  ];

  try {
    const evaluated = await withPromiseTimeout(
      page.evaluate((inputSelectors) => {
        const sanitize = (value) => String(value || "").replace(/\s+/g, " ").trim();
        for (const selector of inputSelectors) {
          const element = document.querySelector(selector);
          if (!element) {
            continue;
          }
          element.click();
          return {
            expanded: true,
            route: "evaluate-click",
            selector,
            buttonLabel: sanitize(element.textContent || element.getAttribute("aria-label") || "")
          };
        }
        return {
          expanded: false,
          route: null,
          selector: null,
          buttonLabel: null
        };
      }, selectors),
      800,
      {
        expanded: false,
        route: "timeout",
        selector: null,
        buttonLabel: null
      }
    );
    return evaluated;
  } catch (error) {
    return {
      expanded: false,
      route: "evaluate-error",
      selector: null,
      error: summarizeError(error)
    };
  }
}

async function clickTranscriptButtonViaEvaluate(page) {
  try {
    return await page.evaluate(() => {
      const sanitize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const panel = () =>
        document.querySelector(
          "ytd-engagement-panel-section-list-renderer[target-id='engagement-panel-searchable-transcript']"
        );
      const panelState = () => {
        const node = panel();
        if (!node) {
          return {
            visible: false,
            display: null,
            visibility: null,
            panelVisibility: null,
            segmentCount: document.querySelectorAll("ytd-transcript-segment-renderer").length,
            transcriptSelected:
              document.querySelector(
                "chip-shape button[aria-label*='Transcript' i], button[aria-label*='Transcript' i][role='tab']"
              )?.getAttribute("aria-selected") === "true"
          };
        }
        const style = globalThis.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return {
          visible:
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number(rect.width) > 0 &&
            Number(rect.height) > 0,
          display: style.display || null,
          visibility: style.visibility || null,
          panelVisibility: node.getAttribute("visibility") || null,
          segmentCount: document.querySelectorAll("ytd-transcript-segment-renderer").length,
          transcriptSelected:
            document.querySelector(
              "chip-shape button[aria-label*='Transcript' i], button[aria-label*='Transcript' i][role='tab']"
            )?.getAttribute("aria-selected") === "true"
        };
      };
      const fireClickSequence = (element) => {
        if (!element) {
          return false;
        }
        const eventTargets = [element];
        if (element.parentElement) {
          eventTargets.push(element.parentElement);
        }
        if (typeof element.closest === "function") {
          const shell = element.closest(
            "chip-shape, yt-button-shape, [role='button'], [role='tab'], ytd-video-description-transcript-section-renderer"
          );
          if (shell) {
            eventTargets.push(shell);
          }
        }
        const seen = new Set();
        eventTargets.forEach((target) => {
          if (!target || seen.has(target)) {
            return;
          }
          seen.add(target);
          ["pointerdown", "mousedown", "mouseup", "click"].forEach((type) => {
            target.dispatchEvent(
              new MouseEvent(type, {
                bubbles: true,
                cancelable: true,
                composed: true,
                view: window
              })
            );
          });
          if (typeof target.click === "function") {
            target.click();
          }
        });
        return true;
      };
      const selectors = [
        "ytd-video-description-transcript-section-renderer button",
        "#description-inline-expander ytd-video-description-transcript-section-renderer button",
        "button[aria-label*='transcript' i]",
        "button[title*='transcript' i]",
        "button[role='tab'][aria-label*='transcript' i]"
      ];
      const candidates = [];
      const seenNodes = new Set();
      selectors.forEach((selector) => {
        document.querySelectorAll(selector).forEach((element) => {
          if (!element || seenNodes.has(element)) {
            return;
          }
          seenNodes.add(element);
          candidates.push({
            selector,
            element
          });
        });
      });
      const attempts = [];
      for (const candidate of candidates.slice(0, 12)) {
        const before = panelState();
        const clicked = fireClickSequence(candidate.element);
        const after = panelState();
        const buttonLabel = sanitize(
          candidate.element.getAttribute("aria-label") ||
            candidate.element.getAttribute("title") ||
            candidate.element.textContent ||
            ""
        ).slice(0, 120);
        attempts.push({
          selector: candidate.selector,
          buttonLabel,
          clicked,
          before,
          after
        });
        if (
          clicked &&
          (after.visible ||
            after.panelVisibility === "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED" ||
            after.segmentCount > 0 ||
            after.transcriptSelected)
        ) {
          return {
            clicked: true,
            selector: candidate.selector,
            buttonLabel,
            panelOpened:
              after.visible ||
              after.panelVisibility === "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED" ||
              after.segmentCount > 0,
            transcriptSelected: after.transcriptSelected,
            candidateCount: candidates.length,
            attempts
          };
        }
      }
      return {
        clicked: false,
        selector: null,
        buttonLabel: null,
        panelOpened: false,
        transcriptSelected: false,
        candidateCount: candidates.length,
        attempts
      };
    });
  } catch (error) {
    return {
      clicked: false,
      selector: null,
      buttonLabel: null,
      panelOpened: false,
      transcriptSelected: false,
      candidateCount: 0,
      attempts: [],
      error: summarizeError(error)
    };
  }
}

async function waitForTranscriptPanelVisible(page, timeoutMs) {
  try {
    await page.waitForFunction(() => {
      const panel = document.querySelector(
        "ytd-engagement-panel-section-list-renderer[target-id='engagement-panel-searchable-transcript']"
      );
      if (!panel) {
        return false;
      }
      const style = globalThis.getComputedStyle(panel);
      const rect = panel.getBoundingClientRect();
      return (
        panel.getAttribute("visibility") === "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED" ||
        (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(rect.width) > 0 &&
          Number(rect.height) > 0
        ) ||
        document.querySelectorAll("ytd-transcript-segment-renderer").length > 0
      );
    }, { timeout: timeoutMs });
    return true;
  } catch (error) {
    return false;
  }
}

async function requestTranscriptViaAuthenticatedPage(page, request) {
  try {
    const result = await page.evaluate(async (requestedLanguageCode) => {
      const sanitize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const ytcfgData = globalThis.ytcfg?.data_ || globalThis.ytcfg?.data || {};
      const initialData = globalThis.ytInitialData || null;
      const playerResponse = globalThis.ytInitialPlayerResponse || null;
      const findTranscriptParams = (source) => {
        const queue = [source];
        const seen = new Set();
        while (queue.length) {
          const current = queue.shift();
          if (!current || typeof current !== "object" || seen.has(current)) {
            continue;
          }
          seen.add(current);
          if (
            current.getTranscriptEndpoint &&
            typeof current.getTranscriptEndpoint.params === "string"
          ) {
            return current.getTranscriptEndpoint.params;
          }
          Object.keys(current).forEach((key) => {
            const value = current[key];
            if (value && typeof value === "object") {
              queue.push(value);
            }
          });
        }
        return "";
      };
      const apiKey =
        ytcfgData.INNERTUBE_API_KEY ||
        ytcfgData.WEB_PLAYER_CONTEXT_CONFIGS?.WEB_PLAYER_CONTEXT_CONFIG_ID_KEVLAR_WATCH?.INNERTUBE_API_KEY ||
        null;
      const clientName =
        ytcfgData.INNERTUBE_CONTEXT_CLIENT_NAME ||
        ytcfgData.WEB_PLAYER_CONTEXT_CONFIGS?.WEB_PLAYER_CONTEXT_CONFIG_ID_KEVLAR_WATCH?.INNERTUBE_CONTEXT_CLIENT_NAME ||
        "WEB";
      const clientVersion =
        ytcfgData.INNERTUBE_CONTEXT_CLIENT_VERSION ||
        ytcfgData.WEB_PLAYER_CONTEXT_CONFIGS?.WEB_PLAYER_CONTEXT_CONFIG_ID_KEVLAR_WATCH?.INNERTUBE_CONTEXT_CLIENT_VERSION ||
        null;
      const transcriptParams = findTranscriptParams(initialData || playerResponse);
      const contextClient =
        ytcfgData.INNERTUBE_CONTEXT ||
        {
          client: {
            clientName,
            clientVersion,
            hl: document.documentElement.lang || "en",
            gl: "US"
          }
        };
      const videoDurationSeconds =
        Number(
          playerResponse?.videoDetails?.lengthSeconds ||
          globalThis.ytplayer?.config?.args?.length_seconds ||
          0
        ) || null;

      if (!apiKey || !clientVersion || !transcriptParams) {
        return {
          ok: false,
          errorCode: !transcriptParams
            ? "backend_headless_page_transcript_params_missing"
            : "backend_headless_page_transcript_bootstrap_incomplete",
          detail: {
            apiKeyPresent: Boolean(apiKey),
            clientVersionPresent: Boolean(clientVersion),
            transcriptParamsFound: Boolean(transcriptParams),
            videoDurationSeconds
          }
        };
      }

      try {
        const response = await fetch(
          `https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false&key=${encodeURIComponent(apiKey)}`,
          {
            method: "POST",
            credentials: "include",
            headers: {
              "content-type": "application/json",
              "x-youtube-client-name": String(clientName),
              "x-youtube-client-version": String(clientVersion)
            },
            body: JSON.stringify({
              context: contextClient,
              params: transcriptParams,
              requestedLanguageCode: requestedLanguageCode || undefined
            })
          }
        );
        const text = await response.text();
        if (!response.ok) {
          return {
            ok: false,
            errorCode:
              response.status === 400 && /FAILED_PRECONDITION/i.test(text)
                ? "backend_headless_page_transcript_failed_precondition"
                : `backend_headless_page_transcript_http_${response.status}`,
            detail: {
              transcriptParamsFound: true,
              responseStatus: response.status,
              bodySnippet: text.slice(0, 240),
              videoDurationSeconds
            }
          };
        }
        return {
          ok: true,
          payload: JSON.parse(text),
          detail: {
            transcriptParamsFound: true,
            responseStatus: response.status,
            videoDurationSeconds
          }
        };
      } catch (error) {
        return {
          ok: false,
          errorCode: "backend_headless_page_transcript_request_failed",
          detail: {
            transcriptParamsFound: true,
            error: sanitize(error && (error.stack || error.message || error)),
            videoDurationSeconds
          }
        };
      }
    }, request.requestedLanguageCode || "");
    return {
      ...result,
      videoDurationSeconds: result?.detail?.videoDurationSeconds || null
    };
  } catch (error) {
    return {
      ok: false,
      errorCode: "backend_headless_page_transcript_request_failed",
      detail: {
        error: summarizeError(error),
        transcriptParamsFound: false
      },
      videoDurationSeconds: null
    };
  }
}

function isYtDlpBotGateFailure(attemptDetail) {
  const text = [
    attemptDetail?.stderrTail,
    attemptDetail?.stdoutTail
  ]
    .filter(Boolean)
    .join("\n");
  return /sign in to confirm you.?re not a bot|confirm you are not a bot/i.test(text);
}

function withPromiseTimeout(promise, timeoutMs, fallbackValue) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => {
      setTimeout(() => resolve(fallbackValue), Math.max(1, timeoutMs));
    })
  ]);
}

function extractAssignedObject(source, markers) {
  const text = String(source || "");

  for (const marker of markers) {
    const index = text.indexOf(marker);
    if (index === -1) {
      continue;
    }

    const braceIndex = text.indexOf("{", index + marker.length);
    if (braceIndex === -1) {
      continue;
    }

    const objectText = extractJsonLikeObject(text, braceIndex);
    if (!objectText) {
      continue;
    }

    try {
      return JSON.parse(objectText);
    } catch (error) {
      continue;
    }
  }

  return null;
}

function extractYtcfg(source) {
  const text = String(source || "");
  const result = {};
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const markerIndex = text.indexOf("ytcfg.set(", searchFrom);
    if (markerIndex === -1) {
      break;
    }

    const braceIndex = text.indexOf("{", markerIndex);
    if (braceIndex === -1) {
      break;
    }

    const objectText = extractJsonLikeObject(text, braceIndex);
    if (!objectText) {
      searchFrom = markerIndex + 8;
      continue;
    }

    try {
      Object.assign(result, JSON.parse(objectText));
    } catch (error) {
      // Ignore invalid config fragments and keep walking.
    }

    searchFrom = braceIndex + objectText.length;
  }

  return result;
}

function extractJsonLikeObject(source, startIndex) {
  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (inString) {
      if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(startIndex, index + 1);
      }
    }
  }

  return "";
}

function normalizeRequest(input, policy) {
  const analysisMode =
    input?.analysisMode || Policy.ANALYSIS_MODES.youtubeTranscriptFirst;
  const maxAutomaticAsrDurationSeconds = clampNumber(
    input?.maxAutomaticAsrDurationSeconds,
    60,
    (policy || RECOVERY_POLICY).backend.maxVideoLengthSeconds.absolute,
    (policy || RECOVERY_POLICY).backend.maxVideoLengthSeconds.automaticAsr
  );
  const url = normalizeWatchUrl(input?.url, input?.videoId);
  const videoId = normalizeVideoId(input?.videoId || extractVideoId(url));
  return {
    url,
    videoId,
    policy: policy || RECOVERY_POLICY,
    requestedLanguageCode: normalizeLanguage(input?.requestedLanguageCode),
    includeTimestamps: input?.includeTimestamps !== false,
    analysisMode,
    surface: String(input?.surface || "unknown").trim().toLowerCase() || "unknown",
    clientInstanceId: String(input?.clientInstanceId || "").trim(),
    allowAutomaticAsr: analysisMode === Policy.ANALYSIS_MODES.youtubeTranscriptFirst
      ? input?.allowAutomaticAsr !== false
      : false,
    maxAutomaticAsrDurationSeconds,
    extensionVersion: String(input?.extensionVersion || "").trim(),
    traceId:
      String(input?.traceId || "").trim() ||
      `backend-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
  };
}

function normalizeWatchUrl(url, videoId) {
  const safeUrl = String(url || "").trim();
  if (safeUrl) {
    try {
      const parsed = new URL(safeUrl);
      if (parsed.pathname === "/watch" && parsed.searchParams.get("v")) {
        return `https://www.youtube.com/watch?v=${parsed.searchParams.get("v")}`;
      }
      const shortsMatch = parsed.pathname.match(/^\/shorts\/([^/?#]+)/);
      if (shortsMatch) {
        return `https://www.youtube.com/watch?v=${shortsMatch[1]}`;
      }
    } catch (error) {
      // Fall through to the explicit video ID path.
    }
  }

  const normalizedVideoId = normalizeVideoId(videoId);
  return normalizedVideoId
    ? `https://www.youtube.com/watch?v=${normalizedVideoId}`
    : "";
}

function extractVideoId(url) {
  try {
    const parsed = new URL(String(url || ""));
    if (parsed.pathname === "/watch") {
      return parsed.searchParams.get("v") || "";
    }
    const shortsMatch = parsed.pathname.match(/^\/shorts\/([^/?#]+)/);
    return shortsMatch ? shortsMatch[1] : "";
  } catch (error) {
    return "";
  }
}

function normalizeVideoId(value) {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9_-]{6,}$/.test(text) ? text : "";
}

function normalizeSegments(segments) {
  return (Array.isArray(segments) ? segments : [])
    .map((segment) => ({
      startMs: toFiniteNumber(segment?.startMs),
      durationMs: toFiniteNumber(segment?.durationMs),
      text: sanitizeText(segment?.text || "")
    }))
    .filter((segment) => Boolean(segment.text));
}

function computeCoverageRatio(input) {
  if (isFiniteNumber(input.transcriptSpanSeconds) && isFiniteNumber(input.videoDurationSeconds)) {
    return roundTo(
      clamp(input.transcriptSpanSeconds / Math.max(1, input.videoDurationSeconds), 0, 1),
      3
    );
  }

  if (input.segmentCount > 0) {
    return roundTo(
      clamp(Math.max(input.segmentCount / 48, countWords(input.text) / 900), 0, 1),
      3
    );
  }

  return null;
}

function computeTranscriptSpanSeconds(segments) {
  const withTimestamps = segments.filter((segment) => isFiniteNumber(segment.startMs));
  if (!withTimestamps.length) {
    return null;
  }

  const startMs = Math.min(...withTimestamps.map((segment) => segment.startMs));
  const endMs = Math.max(
    ...withTimestamps.map((segment) => segment.startMs + Math.max(segment.durationMs || 0, 0))
  );

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return null;
  }

  return roundTo((endMs - startMs) / 1000, 1);
}

function computeSegmentQualityScore(segments) {
  if (!segments.length) {
    return 0;
  }

  const timestampRatio =
    segments.filter((segment) => isFiniteNumber(segment.startMs)).length / segments.length;
  const avgWords = average(
    segments.map((segment) => Math.max(1, countWords(segment.text || "")))
  );
  const nearEmptyRatio =
    segments.filter((segment) => countWords(segment.text || "") <= 1).length / segments.length;
  const monotonicity = computeMonotonicity(segments);
  const countScore = normalizeRange(segments.length, 4, 48) * 25;
  const timestampScore = timestampRatio * 30;
  const continuityScore = monotonicity * 15;
  const densityScore = Math.max(0, 20 - Math.abs(avgWords - 10) * 2);
  const emptyPenalty = nearEmptyRatio * 20;

  return Math.round(clamp(countScore + timestampScore + continuityScore + densityScore - emptyPenalty, 0, 100));
}

function computeMonotonicity(segments) {
  const values = segments.map((segment) => segment.startMs).filter(isFiniteNumber);
  if (values.length <= 1) {
    return 0;
  }

  let monotonicPairs = 0;
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] >= values[index - 1]) {
      monotonicPairs += 1;
    }
  }

  return monotonicPairs / Math.max(1, values.length - 1);
}

function deriveQuality(input) {
  if (!input.text) {
    return "enhanced-extraction-unavailable";
  }
  if (input.qualityGate && input.qualityGate.eligible === false) {
    return "partial-transcript";
  }

  if (
    normalizeConfidence(input.sourceConfidence) === "high" &&
    (((input.coverageRatio || 0) >= 0.45) || ((input.transcriptSpanSeconds || 0) >= 120)) &&
    (input.segmentQualityScore || 0) >= 60
  ) {
    return "strong-transcript";
  }

  return "partial-transcript";
}

function readRunsText(value) {
  if (!value) {
    return "";
  }
  if (typeof value.simpleText === "string") {
    return value.simpleText;
  }
  if (Array.isArray(value.runs)) {
    return value.runs.map((part) => part.text || "").join("");
  }
  return "";
}

function parseTimestampLabel(value) {
  const text = sanitizeText(value);
  if (!text) {
    return null;
  }
  const parts = text.split(":").map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) {
    return null;
  }

  let seconds = 0;
  while (parts.length) {
    seconds = seconds * 60 + parts.shift();
  }
  return seconds * 1000;
}

function parseAttributeTime(attributes, names) {
  const source = String(attributes || "");
  for (const name of names) {
    const match = source.match(new RegExp(`${name}=["']([^"']+)["']`, "i"));
    if (!match) {
      continue;
    }
    const parsed = parseTimeValue(match[1]);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

function parseTimeValue(value) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }
  if (/^\d+(?:\.\d+)?ms$/i.test(text)) {
    return Number.parseFloat(text);
  }
  if (/^\d+(?:\.\d+)?s$/i.test(text)) {
    return Number.parseFloat(text) * 1000;
  }
  if (/^\d+$/.test(text)) {
    return Number(text);
  }
  if (/^\d{2}:\d{2}:\d{2}\.\d{3}$/.test(text) || /^\d{2}:\d{2}\.\d{3}$/.test(text)) {
    return parseVttTime(text);
  }
  return null;
}

function parseVttTime(value) {
  const parts = String(value || "").split(":").map((part) => part.trim());
  if (parts.length < 2 || parts.length > 3) {
    return null;
  }

  const secondsPart = parts.pop();
  const minutesPart = parts.pop();
  const hoursPart = parts.pop() || "0";
  const [seconds, millis] = secondsPart.split(".");

  return (
    Number(hoursPart) * 60 * 60 * 1000 +
    Number(minutesPart) * 60 * 1000 +
    Number(seconds || 0) * 1000 +
    Number(millis || 0)
  );
}

function sanitizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function countWords(value) {
  const text = sanitizeText(value);
  return text ? text.split(/\s+/).length : 0;
}

function countSentenceUnits(value) {
  const text = sanitizeText(value);
  if (!text) {
    return 0;
  }
  return text
    .split(/(?<=[.!?])\s+/)
    .map((part) => sanitizeText(part))
    .filter(Boolean).length;
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code) || 0))
    .replace(/\u00a0/g, " ");
}

function stripHtml(value) {
  return String(value || "").replace(/<[^>]+>/g, " ");
}

function normalizeLanguage(value) {
  const text = String(value || "").trim().toLowerCase();
  return text || null;
}

function normalizeConfidence(value) {
  const text = String(value || "").trim().toLowerCase();
  return text === "high" || text === "medium" || text === "low" ? text : null;
}

function confidenceRank(value) {
  if (value === "high") {
    return 3;
  }
  if (value === "medium") {
    return 2;
  }
  if (value === "low") {
    return 1;
  }
  return 0;
}

function qualityRank(value) {
  if (value === "strong-transcript") {
    return 3;
  }
  if (value === "partial-transcript") {
    return 2;
  }
  if (value === "weak-fallback") {
    return 1;
  }
  return 0;
}

function computeUniqueSegmentRatio(segments) {
  const normalized = (Array.isArray(segments) ? segments : [])
    .map((segment) => sanitizeText(segment?.text || "").toLowerCase())
    .filter(Boolean);
  if (!normalized.length) {
    return null;
  }
  return roundTo(new Set(normalized).size / normalized.length, 3);
}

function computeAverageWordsPerSegment(segments) {
  const values = (Array.isArray(segments) ? segments : [])
    .map((segment) => countWords(segment?.text || ""))
    .filter((value) => value > 0);
  if (!values.length) {
    return null;
  }
  return roundTo(average(values), 2);
}

function computeNonLetterCharacterRatio(value) {
  const text = String(value || "");
  if (!text) {
    return null;
  }
  const nonLetterMatches = text.match(/[^A-Za-z\s]/g);
  return roundTo((nonLetterMatches ? nonLetterMatches.length : 0) / text.length, 3);
}

function languageMatches(value, target) {
  if (!value || !target) {
    return false;
  }
  return value === target || value.startsWith(`${target}-`);
}

function average(values) {
  if (!Array.isArray(values) || !values.length) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function normalizeRange(value, min, max) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return clamp((value - min) / Math.max(1, max - min), 0, 1);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return clamp(number, min, max);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundTo(value, precision) {
  if (!Number.isFinite(value)) {
    return null;
  }
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function formatComparableNumber(value) {
  return isFiniteNumber(value) ? Number(value).toFixed(2) : "n/a";
}

function dedupeList(values) {
  const seen = new Set();
  return (Array.isArray(values) ? values : []).filter((value) => {
    const key = String(value || "");
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function linkAbortSignal(parentSignal, controller) {
  if (!parentSignal) {
    return () => {};
  }

  const onAbort = () => {
    controller.abort(parentSignal.reason);
  };

  if (parentSignal.aborted) {
    onAbort();
    return () => {};
  }

  parentSignal.addEventListener("abort", onAbort, { once: true });
  return () => parentSignal.removeEventListener("abort", onAbort);
}

function attachBrowserAbort(signal, browser) {
  if (!signal) {
    return () => {};
  }

  const onAbort = () => {
    browser.close().catch(() => {});
  };

  if (signal.aborted) {
    onAbort();
    return () => {};
  }

  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

function createAbortTimeout(controller, timeoutMs) {
  return setTimeout(() => {
    controller.abort(new Error("timeout"));
  }, timeoutMs);
}

function waitForAbort(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason || new Error("aborted"));
      return;
    }

    signal.addEventListener(
      "abort",
      () => reject(signal.reason || new Error("aborted")),
      { once: true }
    );
  });
}

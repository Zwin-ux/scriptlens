importScripts(
  "runtime-config.js",
  "utils/debug.js",
  "shared/contracts.js",
  "utils/text.js",
  "utils/stats.js",
  "detector/patterns.js",
  "detector/heuristics.js",
  "detector/scoring.js",
  "detector/analyze.js",
  "detector/detect.js",
  "transcript/policy.js",
  "transcript/normalize.js",
  "transcript/strategies/youtubei.js",
  "transcript/strategies/captionTrack.js",
  "transcript/strategies/domTranscript.js",
  "transcript/strategies/descriptionTranscript.js",
  "transcript/strategies/titleDescription.js",
  "transcript/providers/youtubeResolver.js",
  "transcript/providers/backendResolver.js",
  "transcript/providers/nativeHelper.js",
  "transcript/acquire.js",
  "shared/service-worker-report.js"
);

const Debug = globalThis.ScriptLensDebug || {};
const Contracts = globalThis.ScriptLensContracts || {};
const ServiceWorkerReport = globalThis.ScriptLensServiceWorkerReport || {};
const RuntimeConfig = globalThis.ScriptLensRuntimeConfig || {};
const TranscriptPolicy = globalThis.ScriptLens?.transcript?.policy || {};
const RECOVERY_POLICY = TranscriptPolicy.resolvePolicy
  ? TranscriptPolicy.resolvePolicy()
  : null;
const logger = Debug.createLogger
  ? Debug.createLogger("service-worker")
  : console;
if (Debug.installGlobalErrorHandlers) {
  Debug.installGlobalErrorHandlers("service-worker");
}

const STORAGE_KEYS = {
  settings: "settings",
  recentReports: "recentReports",
  debugReports: "debugReports",
  sitePreferences: "sitePreferences",
  uiHints: "uiHints"
};

const SESSION_KEYS = {
  panelLaunchRequest: "panelLaunchRequest"
};

const DEFAULT_BACKEND_ENDPOINT =
  typeof RuntimeConfig.defaultBackendTranscriptEndpoint === "string"
    ? RuntimeConfig.defaultBackendTranscriptEndpoint.trim()
    : "";
const DEFAULT_BACKEND_RECOVERY_ENABLED =
  Boolean(DEFAULT_BACKEND_ENDPOINT) &&
  RuntimeConfig.allowBackendTranscriptFallbackByDefault !== false;
const ENABLE_DEFUDDLE_EXPERIMENT = RuntimeConfig.enableDefuddleExperiment === true;

const DEFAULT_SETTINGS = {
  sensitivity: "medium",
  maxTextLength: 18000,
  minCharacters: 180,
  minWords: 40,
  recentReportsLimit: 5,
  debugMode: false,
  allowBackendTranscriptFallback: DEFAULT_BACKEND_RECOVERY_ENABLED,
  backendTranscriptEndpoint: DEFAULT_BACKEND_ENDPOINT,
  clientInstanceId: ""
};

const DEFAULT_UI_HINTS = {
  sidePanelIntroDismissed: false,
  popupIntroDismissed: false,
  youtubeIntroDismissed: false,
  lowQualityHintDismissed: false,
  nativeHelperHintDismissed: false
};

const DISCLAIMER =
  "This score reflects AI-like writing patterns, not proof of authorship.";

chrome.runtime.onInstalled.addListener(async () => {
  logger.info("onInstalled", {
    version: chrome.runtime.getManifest()?.version || "0.0.0"
  });
  const localValues = await localGet([
    STORAGE_KEYS.settings,
    STORAGE_KEYS.recentReports,
    STORAGE_KEYS.debugReports,
    STORAGE_KEYS.sitePreferences,
    STORAGE_KEYS.uiHints
  ]);

  const nextValues = {};
  if (!localValues[STORAGE_KEYS.settings]) {
    nextValues[STORAGE_KEYS.settings] = DEFAULT_SETTINGS;
  }
  if (!Array.isArray(localValues[STORAGE_KEYS.recentReports])) {
    nextValues[STORAGE_KEYS.recentReports] = [];
  }
  if (!Array.isArray(localValues[STORAGE_KEYS.debugReports])) {
    nextValues[STORAGE_KEYS.debugReports] = [];
  }
  if (!localValues[STORAGE_KEYS.sitePreferences]) {
    nextValues[STORAGE_KEYS.sitePreferences] = {};
  }
  if (!localValues[STORAGE_KEYS.uiHints]) {
    nextValues[STORAGE_KEYS.uiHints] = DEFAULT_UI_HINTS;
  }

  if (Object.keys(nextValues).length) {
    await localSet(nextValues);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  logger.info("runtime message", {
    type: message?.type || "",
    senderTabId: sender?.tab?.id || null,
    senderUrl: sender?.tab?.url || "",
    explicitTabId: Number(message?.tabId) || null
  });
  handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((error) => {
      logger.error("runtime message failed", {
        type: message?.type || "",
        error: serializeError(error)
      });
      sendResponse({
        ok: false,
        error: error?.message || "Unexpected extension error."
      });
    });

  return true;
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "popup:init":
      return buildSurfaceInitResponse(message || {}, false, sender);
    case "popup:analyze":
      return handleAnalyze(message || {}, {
        sender,
        surface: "popup",
        allowDomTranscriptLoader: true
      });
    case "panel:init":
      return buildSurfaceInitResponse(message || {}, true, sender);
    case "panel:open":
      return openWorkspace(message || {}, sender);
    case "panel:analyze":
      return handleAnalyze(message || {}, {
        sender,
        surface: "panel",
        allowDomTranscriptLoader: true
      });
    case "inline:init":
      return buildInlineInitResponse(message || {}, sender);
    case "inline:analyze":
      return handleAnalyze(message || {}, {
        sender,
        preferSenderTab: true,
        surface: "inline",
        allowDomTranscriptLoader: false
      });
    case "video:sources":
      {
        const pageContext = await getHydratedPageContext(
          await resolveContextTab(message || {}, sender)
        );
        return {
          ok: true,
          pageContext,
          video: pageContext?.video || null
        };
      }
    case "sitePreferences:get":
      return {
        ok: true,
        sitePreference: await getSitePreference(message.hostname || (await getCurrentHost()))
      };
    case "sitePreferences:set":
      return {
        ok: true,
        sitePreference: await saveSitePreference(
          message.hostname || (await getCurrentHost()),
          message.updates || {}
        )
      };
    case "uiHints:update":
      return {
        ok: true,
        uiHints: await updateUiHints(message.updates || {})
      };
    case "debug:getHistory":
      return {
        ok: true,
        history: Debug.getHistory ? Debug.getHistory() : []
      };
    case "settings:update":
      return handleSettingsUpdate(message || {}, sender);
    default:
      return {
        ok: false,
        error: "Unsupported action."
      };
  }
}

async function buildSurfaceInitResponse(message, includeLaunchRequest, sender) {
  const targetTab = await resolveContextTab(message, sender);
  const pageContext = await getHydratedPageContext(targetTab);
  const response = await buildSurfacePayload(pageContext);

  if (includeLaunchRequest) {
    response.launchRequest = await loadLaunchRequest();
  }

  return response;
}

async function buildInlineInitResponse(message, sender) {
  const targetTab = await resolveContextTab(message, sender, true);
  const pageContext = await getHydratedPageContext(targetTab);
  const settings = await loadSettings();
  logger.info("inline init resolved", {
    targetTabId: targetTab?.id || null,
    supported: Boolean(pageContext?.supported),
    videoId: pageContext?.video?.videoId || null,
    transcriptAvailable: Boolean(pageContext?.transcriptAvailable)
  });
  return {
    ok: true,
    inlineSettings: {
      allowBackendTranscriptFallback: Boolean(settings.allowBackendTranscriptFallback)
    },
    pageContext
  };
}

async function handleSettingsUpdate(message, sender) {
  await saveSettings(message.settings || {});
  const pageContext = await getHydratedPageContext(
    await resolveContextTab(message, sender)
  );
  return buildSurfacePayload(pageContext);
}

async function openWorkspace(message, sender) {
  const request = message?.request || null;
  const shouldOpenPanel = !message?.skipOpen;
  const gestureTab = sender?.tab?.id ? sender.tab : null;

  const tab = await resolveTabForLaunch(message, sender);
  if (!tab?.id) {
    return {
      ok: false,
      error: "No active browser tab is available."
    };
  }

  const pageContext = await getHydratedPageContext(tab);
  const normalizedRequest = request
    ? resolveRequestedAction(pageContext, request)
    : pageContext.recommendedRequest || null;

  if (normalizedRequest) {
    await saveLaunchRequest({
      tabId: tab.id,
      windowId: tab.windowId,
      request: normalizedRequest,
      createdAt: Date.now()
    });
  } else {
    await clearLaunchRequest();
  }

  logger.info("workspace request prepared", {
    tabId: tab.id,
    request: summarizeRequest(normalizedRequest)
  });

  if (shouldOpenPanel) {
    const windowId =
      gestureTab?.windowId ?? tab?.windowId ?? Number(message?.windowId);
    if (!Number.isFinite(windowId)) {
      return {
        ok: false,
        error: "A user-driven browser tab is required to open the workspace.",
        pageContext,
        launchRequest: normalizedRequest
      };
    }

    try {
      await openSidePanel(windowId);
      logger.info("workspace opened", {
        windowId
      });
    } catch (error) {
      logger.warn("workspace open failed", {
        windowId,
        tabId: tab.id,
        request: summarizeRequest(normalizedRequest),
        error: serializeError(error)
      });
      return {
        ok: false,
        error:
          "ScriptLens prepared the workspace, but Chrome blocked the side panel from opening. Use the toolbar icon to open it.",
        pageContext,
        launchRequest: normalizedRequest
      };
    }
  }

  return {
    ok: true,
    pageContext,
    launchRequest: normalizedRequest
  };
}

async function handleAnalyze(message, options = {}) {
  const settings = await loadSettings();
  const request = message.request || {};
  const traceId = Debug.createTraceId
    ? Debug.createTraceId(message?.type || request?.mode || "analyze")
    : `trace-${Date.now()}`;
  const analysisOptions = normalizeAnalysisOptions(options);
  const targetTab = await resolveContextTab(
    message,
    options.sender,
    options.preferSenderTab
  ).catch(() => null);
  const pageContext = targetTab ? await getHydratedPageContext(targetTab) : null;
  const normalizedRequest = resolveRequestedAction(pageContext, request);

  if (!normalizedRequest) {
    logger.warn("analyze request rejected", {
      traceId,
      request: summarizeRequest(request),
      pageContext: summarizePageContext(pageContext)
    });
    return {
      ok: false,
      error: "No suitable source is available for analysis."
    };
  }

  logger.info("analyze request started", {
    traceId,
    surface: analysisOptions.surface,
    allowDomTranscriptLoader: analysisOptions.allowDomTranscriptLoader,
    request: summarizeRequest(normalizedRequest),
    targetTabId: targetTab?.id || null,
    pageContext: summarizePageContext(pageContext)
  });

  let analysis;
  if (normalizedRequest.mode === "manual") {
    analysis = await analyzeDirectText(normalizedRequest.text, settings, {
      sourceType: "manual",
      sourceLabel: "Pasted text",
      title: "Pasted text"
    });
  } else if (normalizedRequest.mode === "selection") {
    analysis = await analyzeSelection(targetTab, settings);
  } else if (normalizedRequest.mode === "page") {
    analysis = await analyzePage(targetTab, settings);
  } else if (normalizedRequest.mode === "youtube") {
    analysis = await analyzeYouTube(
      targetTab,
      normalizedRequest,
      settings,
      traceId,
      analysisOptions
    );
  } else {
    analysis = {
      ok: false,
      error: "Unsupported analysis source."
    };
  }

  if (!analysis.ok) {
    logger.warn("analyze request failed", {
      traceId,
      request: summarizeRequest(normalizedRequest),
      error: analysis.error || "",
      acquisition: summarizeAcquisition(analysis.acquisition)
    });
    return {
      ok: false,
      error: analysis.error,
      failureCategory:
        Contracts.resolveFailureCategory?.({
          errorCode: analysis.acquisition?.errorCode,
          failureReason: analysis.acquisition?.failureReason,
          winnerReason: analysis.acquisition?.winnerReason
        }) || null,
      acquisition: analysis.acquisition || null,
      settings,
      pageContext
    };
  }

  await persistRecentReport(analysis.report, settings.recentReportsLimit);
  if (settings.debugMode) {
    await persistDebugReport(analysis.report);
  }

  logger.info("analyze request succeeded", {
    traceId,
    request: summarizeRequest(normalizedRequest),
    report: summarizeReportForLog(analysis.report)
  });

  return {
    report: analysis.report,
    ...(await buildSurfacePayload(
      targetTab ? await getHydratedPageContext(targetTab) : null
    ))
  };
}

async function buildSurfacePayload(pageContext) {
  const recentReports = await loadRecentReports();
  const resolvedPageContext = pageContext || { supported: false, hostname: "" };

  return {
    ok: true,
    settings: await loadSettings(),
    recentReports,
    lastReport: recentReports[0] || null,
    pageContext: resolvedPageContext,
    sitePreference: await getSitePreference(normalizeHost(resolvedPageContext.hostname || "")),
    uiHints: await loadUiHints()
  };
}

async function analyzeSelection(tab, settings) {
  const payload = await requestTabExtraction(tab?.id, { type: "extract:selection" });
  if (!payload?.ok) {
    return {
      ok: false,
      error: payload?.error || "No live text selection found on the page."
    };
  }

  return analyzeDirectText(payload.text, settings, payload.meta || {});
}

async function analyzePage(tab, settings) {
  const payload = await requestTabExtraction(tab?.id, {
    type: "extract:page",
    enableDefuddleExperiment: ENABLE_DEFUDDLE_EXPERIMENT
  });
  if (!payload?.ok) {
    return {
      ok: false,
      error: payload?.error || "No visible page text could be extracted."
    };
  }

  logger.info("direct page payload extracted", {
    tabId: tab?.id || null,
    extractor: payload?.meta?.extractor || "legacy",
    extractorWarnings: Array.isArray(payload?.meta?.extractorWarnings)
      ? payload.meta.extractorWarnings
      : [],
    extractorDurationMs: payload?.meta?.extractorDurationMs ?? null
  });

  return analyzeDirectText(payload.text, settings, payload.meta || {});
}

async function analyzeDirectText(text, settings, sourceMeta) {
  const acquisition = buildDirectAcquisition(text, settings, sourceMeta);

  if (!acquisition.ok || !acquisition.text) {
    return {
      ok: false,
      error: "No usable content could be extracted from this source."
    };
  }

  const sourceLabel = buildAnalysisDisplaySource(acquisition, sourceMeta?.title || "");
  const detectionResult = globalThis.AIScriptDetector.detect.runDetection(acquisition.text, {
    ...settings,
    source: sourceLabel,
    sourceConfidence: acquisition.sourceConfidence
  });

  if (!detectionResult.ok) {
    return {
      ok: false,
      error: detectionResult.error
    };
  }

  return {
    ok: true,
    report: buildAnalysisReport({
      title: sourceMeta.title || sourceLabel,
      sourceLabel,
      acquisition,
      directMeta: sourceMeta,
      detection: detectionResult.detection,
      legacyReport: detectionResult.legacyReport,
      settings
    })
  };
}

function buildDirectAcquisition(text, settings, sourceMeta, overrides = {}) {
  return globalThis.ScriptLens.transcript.normalize.normalizeDirectAcquisition(
    {
      kind: mapDirectKind(sourceMeta),
      sourceType: sourceMeta?.sourceType,
      sourceLabel: overrides.sourceLabel || sourceMeta?.sourceLabel,
      title: sourceMeta?.title,
      text,
      coverageRatio: sourceMeta?.coverageRatio,
      blockCount: sourceMeta?.blockCount,
      warnings: []
        .concat(sourceMeta?.extractorWarnings || [])
        .concat(overrides.warnings || []),
      resolverPath: sourceMeta?.extractor
        ? [`directExtractor:${sourceMeta.extractor}`]
        : [],
      winnerSelectedBy: Array.isArray(overrides.winnerSelectedBy)
        ? overrides.winnerSelectedBy
        : sourceMeta?.extractor === "defuddle"
          ? ["defuddle-direct-extraction"]
          : []
    },
    {
      maxTextLength: settings.maxTextLength,
      analysisMode:
        TranscriptPolicy.ANALYSIS_MODES?.genericText || "generic-text"
    }
  );
}

async function analyzeYouTube(tab, request, settings, traceId, options = {}) {
  const adapterResponse = await requestTabExtraction(tab?.id, { type: "youtube:page-adapter" });
  if (!adapterResponse?.ok || !adapterResponse.adapter) {
    logger.warn("youtube adapter unavailable", {
      traceId,
      tabId: tab?.id || null,
      response: adapterResponse || null
    });
    return {
      ok: false,
      error:
        adapterResponse?.error ||
        "Open a YouTube watch page to analyze transcript-aware video text."
    };
  }

  const adapter = adapterResponse.adapter;
  logger.info("youtube adapter resolved", {
    traceId,
    tabId: tab?.id || null,
    surface: options.surface || "unknown",
    adapter: summarizeAdapter(adapter),
    request: summarizeRequest(request)
  });
  const navigationGuard = createNavigationAbortController(tab.id, adapter.videoId);
  let acquisition;
  try {
    acquisition = await resolveYouTubeAcquisition(
      adapter,
      tab.id,
      request,
      settings,
      navigationGuard.signal,
      traceId,
      options
    );
  } finally {
    navigationGuard.stop();
  }

  if (navigationGuard.signal.aborted) {
    logger.warn("youtube analysis aborted by navigation", {
      traceId,
      tabId: tab?.id || null,
      adapterVideoId: adapter.videoId || ""
    });
    return {
      ok: false,
      error: "The YouTube tab changed while ScriptLens was resolving sources. Try again on the current video."
    };
  }

  const latestTab = await getTabById(tab.id).catch(() => null);
  if (latestTab?.url && extractVideoIdFromUrl(latestTab.url) !== adapter.videoId) {
    logger.warn("youtube analysis video changed after acquisition", {
      traceId,
      tabId: tab?.id || null,
      expectedVideoId: adapter.videoId || "",
      actualVideoId: extractVideoIdFromUrl(latestTab.url) || ""
    });
    return {
      ok: false,
      error: "The YouTube tab changed while ScriptLens was resolving sources. Try again on the current video."
    };
  }

  if (!acquisition.ok || !acquisition.text) {
    logger.warn("youtube acquisition unavailable", {
      traceId,
      tabId: tab?.id || null,
      acquisition: summarizeAcquisition(acquisition)
    });
    return {
      ok: false,
      error: buildAcquisitionFailureMessage(acquisition),
      acquisition
    };
  }

  const sourceLabel = buildYouTubeSourceLabel(adapter.title, acquisition);
  const detectionResult = globalThis.AIScriptDetector.detect.runDetection(acquisition.text, {
    ...settings,
    source: sourceLabel,
    sourceConfidence: acquisition.sourceConfidence
  });

  if (!detectionResult.ok) {
    const insufficientInputReport = buildInsufficientInputReport({
      acquisition,
      detectionError: detectionResult.error,
      title: adapter.title,
      sourceLabel,
      settings,
      sourceType: "youtube"
    });
    if (insufficientInputReport) {
      logger.info("youtube analysis returned unscored transcript report", {
        traceId,
        tabId: tab?.id || null,
        acquisition: summarizeAcquisition(acquisition),
        scoringStatus: insufficientInputReport.scoringStatus,
        scoringError: insufficientInputReport.scoringError || ""
      });
      return {
        ok: true,
        report: insufficientInputReport
      };
    }
    logger.warn("youtube detection failed", {
      traceId,
      tabId: tab?.id || null,
      error: detectionResult.error || "",
      acquisition: summarizeAcquisition(acquisition)
    });
    return {
      ok: false,
      error: detectionResult.error,
      acquisition
    };
  }

  logger.info("youtube analysis produced report", {
    traceId,
    tabId: tab?.id || null,
    acquisition: summarizeAcquisition(acquisition),
    score: detectionResult.detection?.aiScore || 0,
    verdict: detectionResult.detection?.verdict || ""
  });

  return {
    ok: true,
    report: buildAnalysisReport({
      title: adapter.title,
      sourceLabel,
      acquisition,
      directMeta: buildYouTubeDirectReportMeta(acquisition),
      detection: detectionResult.detection,
      legacyReport: detectionResult.legacyReport,
      settings
    })
  };
}

async function resolveYouTubeAcquisition(
  adapter,
  tabId,
  request,
  settings,
  signal,
  traceId,
  options = {}
) {
  const includeSources = normalizeVideoSources(request.includeSources);
  const transcriptRequested = includeSources.includes("transcript");
  const analysisMode = transcriptRequested
    ? TranscriptPolicy.ANALYSIS_MODES?.youtubeTranscriptFirst || "youtube-transcript-first"
    : TranscriptPolicy.ANALYSIS_MODES?.genericText || "generic-text";
  const requestedLanguageCode = transcriptRequested
    ? resolveRequestedTranscriptLanguageCode(adapter, request)
    : null;
  const requireTranscript = request.requireTranscript !== false;
  const allowFallbackText = Boolean(request.allowFallbackText) || !transcriptRequested;
  const allowDomTranscriptLoader = options.allowDomTranscriptLoader !== false;
  let acquisition = null;

  logger.info("youtube acquisition started", {
    traceId,
    tabId: tabId || null,
    surface: options.surface || "unknown",
    includeSources,
    analysisMode,
    requestedLanguageCode,
    requireTranscript,
    allowFallbackText,
    allowDomTranscriptLoader,
    adapter: summarizeAdapter(adapter)
  });

  if (transcriptRequested) {
    acquisition = await globalThis.ScriptLens.transcript.acquire.resolveBestTranscript({
      adapter,
      maxTextLength: settings.maxTextLength,
      requestedLanguageCode,
      transcriptBias: request.transcriptBias || "manual-en",
      preferredTrackBaseUrl: request.trackBaseUrl || "",
      signal,
      analysisMode,
      surface: options.surface || "unknown",
      clientInstanceId: settings.clientInstanceId || "",
      allowAutomaticAsr: transcriptRequested,
      maxAutomaticAsrDurationSeconds: selectAutomaticAsrDurationLimit(options.surface),
      allowBackendTranscriptFallback: Boolean(settings.allowBackendTranscriptFallback),
      backendEndpoint: settings.backendTranscriptEndpoint || "",
      extensionVersion: chrome.runtime.getManifest()?.version || "0.1.0",
      traceId,
      refreshAdapter: async () => {
        const refreshed = await requestTabExtraction(tabId, { type: "youtube:page-adapter" });
        return refreshed?.ok ? refreshed.adapter : adapter;
      },
      pageFetch: async ({ url }) => {
        if (!url) {
          return {
            ok: false,
            error: "Missing YouTube fetch URL."
          };
        }
        return await requestTabExtraction(tabId, {
          type: "youtube:fetch-url",
          url
        });
      },
      domTranscriptLoader: allowDomTranscriptLoader
        ? async () => {
            const opened = await requestTabExtraction(tabId, {
              type: "youtube:open-transcript-panel"
            });
            return opened?.ok ? opened.adapter : adapter;
          }
        : null
    });

    logger.info("youtube transcript resolution finished", {
      traceId,
      tabId: tabId || null,
      acquisition: summarizeAcquisition(acquisition)
    });

    if (acquisition.ok && acquisition.text) {
      return acquisition;
    }
  }

  if (requireTranscript && !allowFallbackText) {
    return acquisition ||
      globalThis.ScriptLens.transcript.normalize.buildUnavailableResult({
        provider: "youtubeResolver",
        providerClass: "local",
        strategy: "transcript-unavailable",
        sourceLabel: "Transcript unavailable",
        requestedLanguageCode,
        videoDurationSeconds: adapter.videoDurationSeconds || null,
        warnings: ["transcript_required"],
        errors: acquisition?.errors || [],
        resolverAttempts: acquisition?.resolverAttempts || [],
        resolverPath: acquisition?.resolverPath || [],
        winnerSelectedBy: acquisition?.winnerSelectedBy || ["transcript-required"],
        failureReason: acquisition?.failureReason || "transcript_required"
      });
  }

  const defuddleFallback =
    transcriptRequested &&
    acquisition &&
    !acquisition.ok &&
    ENABLE_DEFUDDLE_EXPERIMENT &&
    tabId
      ? await buildDefuddleFallbackAcquisition(
          tabId,
          adapter,
          settings,
          acquisition,
          traceId
        )
      : null;
  if (defuddleFallback?.ok) {
    return defuddleFallback;
  }

  const fallbackSources = resolveFallbackSources(includeSources, adapter, allowFallbackText);
  const fallback = buildWeakFallbackAcquisition(
    adapter,
    fallbackSources,
    settings.maxTextLength,
    requestedLanguageCode
  );
  logger.info("youtube fallback candidate built", {
    traceId,
    tabId: tabId || null,
    fallbackSources,
    acquisition: summarizeAcquisition(fallback)
  });
  if (fallback.ok) {
    if (acquisition) {
      fallback.errors = []
        .concat(acquisition.errors || [])
        .concat(fallback.errors || []);
      fallback.resolverAttempts = []
        .concat(acquisition.resolverAttempts || [])
        .concat(fallback.resolverAttempts || []);
      fallback.resolverPath = []
        .concat(acquisition.resolverPath || [])
        .concat(fallback.resolverPath || []);
      fallback.winnerSelectedBy = ["fallback-after-transcript-failure"];
      fallback.failureReason = acquisition.failureReason || null;
      fallback.warnings = dedupeList(
        (fallback.warnings || []).concat(["user_fallback_override"])
      );
    }
    return fallback;
  }

  return acquisition || fallback;
}

async function buildDefuddleFallbackAcquisition(
  tabId,
  adapter,
  settings,
  transcriptFailure,
  traceId
) {
  const payload = await requestTabExtraction(tabId, {
    type: "extract:page",
    enableDefuddleExperiment: true
  });

  logger.info("youtube defuddle fallback payload", {
    traceId,
    tabId: tabId || null,
    ok: Boolean(payload?.ok),
    extractor: payload?.meta?.extractor || "",
    warnings: Array.isArray(payload?.meta?.extractorWarnings)
      ? payload.meta.extractorWarnings
      : [],
    extractorDurationMs: payload?.meta?.extractorDurationMs ?? null
  });

  if (!payload?.ok || !payload?.text || payload?.meta?.extractor !== "defuddle") {
    return null;
  }

  const sourceMeta = {
    ...(payload.meta || {}),
    sourceLabel:
      payload.meta?.contentKind === "article-content"
        ? "Extracted article content"
        : "Extracted page content",
    title: adapter?.title || payload.meta?.title || ""
  };
  const directAcquisition = buildDirectAcquisition(
    payload.text,
    settings,
    sourceMeta,
    {
      warnings: ["fallback_source", "user_fallback_override"],
      winnerSelectedBy: ["defuddle-page-fallback"]
    }
  );

  if (!directAcquisition.ok || !directAcquisition.text) {
    return null;
  }

  if (transcriptFailure) {
    directAcquisition.errors = []
      .concat(transcriptFailure.errors || [])
      .concat(directAcquisition.errors || []);
    directAcquisition.resolverAttempts = []
      .concat(transcriptFailure.resolverAttempts || [])
      .concat(directAcquisition.resolverAttempts || []);
    directAcquisition.resolverPath = []
      .concat(transcriptFailure.resolverPath || [])
      .concat(directAcquisition.resolverPath || []);
    directAcquisition.failureReason = transcriptFailure.failureReason || null;
  }

  directAcquisition.directMeta = {
    extractor: sourceMeta.extractor || null,
    extractorWarnings: Array.isArray(sourceMeta.extractorWarnings)
      ? sourceMeta.extractorWarnings.slice()
      : [],
    extractorDurationMs: sourceMeta.extractorDurationMs ?? null,
    legacyExtractorDurationMs: sourceMeta.legacyExtractorDurationMs ?? null,
    defuddleExtractorDurationMs: sourceMeta.defuddleExtractorDurationMs ?? null,
    defuddleAttempted: sourceMeta.defuddleAttempted === true
  };

  return directAcquisition;
}

function buildYouTubeDirectReportMeta(acquisition) {
  const directMeta = acquisition?.directMeta || {};
  const inferredExtractor = inferDirectExtractor(acquisition);
  const extractor = directMeta.extractor || inferredExtractor || null;

  return {
    sourceType: "youtube",
    extractor,
    extractorWarnings: Array.isArray(directMeta.extractorWarnings)
      ? directMeta.extractorWarnings.slice()
      : [],
    extractorDurationMs: directMeta.extractorDurationMs ?? null,
    legacyExtractorDurationMs: directMeta.legacyExtractorDurationMs ?? null,
    defuddleExtractorDurationMs: directMeta.defuddleExtractorDurationMs ?? null,
    defuddleAttempted:
      directMeta.defuddleAttempted === true || extractor === "defuddle"
  };
}

function inferDirectExtractor(acquisition) {
  const resolverPath = Array.isArray(acquisition?.resolverPath)
    ? acquisition.resolverPath
    : [];
  const directEntry = resolverPath.find((entry) => /^directExtractor:/.test(String(entry || "")));
  if (!directEntry) {
    return null;
  }
  const [, extractor] = String(directEntry).split(":", 2);
  return extractor || null;
}

function buildWeakFallbackAcquisition(
  adapter,
  includeSources,
  maxTextLength,
  requestedLanguageCode
) {
  const useDescription = includeSources.includes("description") && adapter.description;
  const useTitle = includeSources.includes("title") && adapter.title;

  if (!useDescription && !useTitle) {
    return globalThis.ScriptLens.transcript.normalize.buildUnavailableResult({
      provider: "youtubeResolver",
      providerClass: "local",
      strategy: "title-description",
      sourceLabel: "Transcript unavailable",
      requestedLanguageCode: requestedLanguageCode || null,
      videoDurationSeconds: adapter.videoDurationSeconds || null,
      warnings: ["transcript_unavailable"],
      errors: [],
      resolverAttempts: [],
      resolverPath: [],
      winnerSelectedBy: [],
      failureReason: "transcript_unavailable"
    });
  }

  const parts = [];
  let sourceLabel = "Title + description fallback";

  if (useTitle) {
    parts.push(adapter.title);
  }
  if (useDescription) {
    parts.push(adapter.description);
  }

  if (useDescription && !useTitle) {
    sourceLabel = "Description fallback";
  } else if (useTitle && !useDescription) {
    sourceLabel = "Title fallback";
  }

  return globalThis.ScriptLens.transcript.normalize.stripInternalFields(
    globalThis.ScriptLens.transcript.normalize.normalizeCandidate(
      {
        ok: true,
        provider: "youtubeResolver",
        providerClass: "local",
        strategy: "title-description",
        analysisMode:
          TranscriptPolicy.ANALYSIS_MODES?.genericText || "generic-text",
        sourceLabel,
        languageCode: adapter.bootstrapSnapshot?.hl || null,
        originalLanguageCode: adapter.bootstrapSnapshot?.hl || null,
        requestedLanguageCode: requestedLanguageCode || null,
        isGenerated: null,
        isTranslated: false,
        isMachineTranslated: false,
        videoDurationSeconds: adapter.videoDurationSeconds || null,
        segments: [],
        text: parts.join("\n\n"),
        warnings: ["fallback_source", "weak_evidence", "user_fallback_override"]
      },
      {
        maxTextLength,
        analysisMode:
          TranscriptPolicy.ANALYSIS_MODES?.genericText || "generic-text"
      }
    )
  );
}

function resolveRequestedTranscriptLanguageCode(adapter, request) {
  const explicitRequestCode = normalizeLanguageCode(
    request?.requestedLanguageCode || request?.languageCode || ""
  );
  if (explicitRequestCode) {
    return explicitRequestCode;
  }

  const preferredTrackBaseUrl = String(request?.trackBaseUrl || "").trim();
  if (preferredTrackBaseUrl === "visible-dom-transcript") {
    return (
      normalizeLanguageCode(adapter?.domTranscriptLanguageCode || "") ||
      normalizeLanguageCode(adapter?.bootstrapSnapshot?.hl || "")
    );
  }
  if (preferredTrackBaseUrl === "description-transcript") {
    return normalizeLanguageCode(adapter?.bootstrapSnapshot?.hl || "");
  }

  const captionTracks = Array.isArray(adapter?.bootstrapSnapshot?.captionTracks)
    ? adapter.bootstrapSnapshot.captionTracks
    : [];
  const preferredTrackPicker =
    globalThis.ScriptLens?.transcript?.strategies?.captionTrack?.pickPreferredTrack;
  const preferredTrack =
    typeof preferredTrackPicker === "function"
      ? preferredTrackPicker(captionTracks, {
          requestedLanguageCode: null,
          preferredTrackBaseUrl,
          preferredBias: request?.transcriptBias || "manual-en"
        })
      : null;
  const preferredTrackCode = normalizeLanguageCode(preferredTrack?.languageCode || "");
  if (preferredTrackCode) {
    return preferredTrackCode;
  }

  const transcriptBias = String(request?.transcriptBias || "").toLowerCase();
  if (/^(manual|auto)[-_]en$/.test(transcriptBias)) {
    return "en";
  }

  return null;
}

function normalizeLanguageCode(value) {
  const text = String(value || "")
    .trim()
    .toLowerCase();
  if (!text) {
    return null;
  }
  const [base, region] = text.split(/[-_]/);
  if (!base) {
    return null;
  }
  return region ? `${base}-${region}` : base;
}

function resolveFallbackSources(includeSources, adapter, allowFallbackText) {
  const explicitSources = includeSources.filter((source) => source === "description" || source === "title");
  if (explicitSources.length) {
    return explicitSources;
  }

  if (!allowFallbackText) {
    return [];
  }

  return ["description", "title"].filter((source) => {
    if (source === "description") {
      return Boolean(adapter.description);
    }
    if (source === "title") {
      return Boolean(adapter.title);
    }
    return false;
  });
}

function buildAnalysisReport(input) {
  if (ServiceWorkerReport.buildAnalysisReport) {
    return ServiceWorkerReport.buildAnalysisReport(input, {
      disclaimer: DISCLAIMER
    });
  }
  const acquisition = input.acquisition;
  const detection = input.detection;
  const legacyReport = input.legacyReport || {};
  const inputQuality = buildInputQuality(acquisition, legacyReport.metadata);
  const interpretation = buildInterpretation(acquisition, inputQuality);
  const sourceInfo = buildSourceInfo(acquisition);

  return {
    acquisition,
    detection,
    analysisMode:
      acquisition?.analysisMode ||
      input.directMeta?.analysisMode ||
      (input.directMeta?.sourceType === "youtube"
        ? TranscriptPolicy.ANALYSIS_MODES?.youtubeTranscriptFirst || "youtube-transcript-first"
        : TranscriptPolicy.ANALYSIS_MODES?.genericText || "generic-text"),
    inputQuality,
    interpretation,
    metadata: {
      ...(legacyReport.metadata || {}),
      sensitivity: input.settings.sensitivity
    },
    disclaimer: DISCLAIMER,
    source: input.sourceLabel,
    sourceInfo,
    score: detection.aiScore ?? null,
    verdict: detection.verdict,
    explanation: detection.explanation,
    topReasons: detection.reasons,
    categoryScores: detection.categoryScores,
    triggeredPatterns: detection.triggeredPatterns,
    flaggedSentences: detection.flaggedSentences,
    scoringStatus: detection.scoringStatus || "scored",
    scoringError: detection.scoringError || "",
    scoringSummary: detection.scoringSummary || "",
    quality: {
      label: inputQuality.label,
      summary: inputQuality.summary,
      reasons: inputQuality.reasons
    },
    sourceMeta: {
      kind: acquisition?.kind || mapDirectKind(input.directMeta),
      sourceType: input.directMeta?.sourceType || "",
      includedSources: Array.isArray(input.directMeta?.includedSources)
        ? input.directMeta.includedSources.slice()
        : [],
      provider: acquisition?.provider || null,
      providerClass: acquisition?.providerClass || "local",
      strategy: acquisition?.strategy || null,
      sourceConfidence: acquisition?.sourceConfidence || null,
      quality: acquisition?.quality || null,
      acquisitionState: acquisition?.acquisitionState || null,
      transcriptRequiredSatisfied: acquisition?.transcriptRequiredSatisfied ?? true,
      failureReason: acquisition?.failureReason || null,
      recoveryTier:
        acquisition?.kind === "transcript"
          ? acquisition?.recoveryTier || "local"
          : acquisition?.recoveryTier || null,
      originKind: acquisition?.originKind || null,
      sourceTrustTier: acquisition?.sourceTrustTier || null,
      winnerReason: acquisition?.winnerReason || null,
      languageCode: acquisition?.languageCode || null,
      originalLanguageCode: acquisition?.originalLanguageCode || null,
      segmentCount: acquisition?.segmentCount || 0,
      coverageRatio: acquisition?.coverageRatio ?? null,
      transcriptSpanSeconds: acquisition?.transcriptSpanSeconds ?? null,
      qualityGate: acquisition?.qualityGate || null
    }
  };
}

function buildInsufficientInputReport(input) {
  if (ServiceWorkerReport.buildInsufficientInputReport) {
    return ServiceWorkerReport.buildInsufficientInputReport(input, {
      disclaimer: DISCLAIMER
    });
  }
  if (
    input?.acquisition?.kind !== "transcript" ||
    !isInsufficientInputError(input?.detectionError)
  ) {
    return null;
  }

  const textApi = globalThis.AIScriptDetector?.text;
  const normalizedText = textApi?.sanitizeInput
    ? textApi.sanitizeInput(input.acquisition.text || "")
    : String(input.acquisition.text || "").trim();
  const wordCount = textApi?.countWords ? textApi.countWords(normalizedText) : 0;
  const sentenceCount = textApi?.splitSentences
    ? textApi.splitSentences(normalizedText).length
    : 0;
  const scoringSummary =
    "ScriptLens recovered a transcript, but this video does not contain enough spoken text for a reliable score.";

  return buildAnalysisReport({
    title: input.title,
    sourceLabel: input.sourceLabel,
    acquisition: {
      ...input.acquisition,
      warnings: Array.isArray(input.acquisition.warnings)
        ? Array.from(new Set([...input.acquisition.warnings, "insufficient_scoring_input"]))
        : ["insufficient_scoring_input"]
    },
    directMeta: {
      sourceType: input.sourceType || "youtube"
    },
    detection: {
      aiScore: null,
      detectorConfidence: "not scored",
      verdict: "Not enough spoken text",
      explanation: scoringSummary,
      reasons: [
        "ScriptLens recovered transcript text for this video.",
        input.detectionError
      ].filter(Boolean),
      categoryScores: {},
      triggeredPatterns: [],
      flaggedSentences: [],
      scoringStatus: "insufficient-input",
      scoringError: input.detectionError || "",
      scoringSummary
    },
    legacyReport: {
      metadata: {
        wordCount,
        sentenceCount
      }
    },
    settings: input.settings
  });
}

function isInsufficientInputError(value) {
  const message = String(value || "").trim();
  return (
    message === "The text is too short for a useful heuristic read. Try at least 40 words or 180 characters." ||
    message === "Add a few more complete sentences for a reliable score."
  );
}

function buildInputQuality(acquisition, metadata) {
  const reducedTrustAudio = acquisition?.sourceTrustTier === "audio-derived";
  const reducedTrustHeadless = acquisition?.sourceTrustTier === "headless-derived";
  if (acquisition.quality === "strong-transcript") {
    return {
      label: "Strong input",
      summary:
        acquisition.kind === "transcript"
          ? reducedTrustAudio
            ? "This analysis is grounded in an audio-derived transcript that passed quality checks, but it still carries reduced trust compared with caption or direct transcript sources."
            : reducedTrustHeadless
              ? "This analysis is grounded in a transcript recovered through a headless path, so trust is lower than a direct YouTube transcript or manual captions."
              : acquisition.providerClass === "backend"
                ? "This analysis is grounded in a strong recovered transcript because the local path needed help."
                : "This analysis is grounded in a strong transcript source with meaningful coverage."
          : "This analysis uses a relatively clean and substantive direct content source.",
      reasons: buildAcquisitionReasons(acquisition)
    };
  }

  if (acquisition.quality === "partial-transcript") {
    return {
      label: "Useful input",
      summary:
        acquisition.kind === "transcript"
          ? reducedTrustAudio
            ? "This analysis uses audio-derived transcript recovery. Treat it as reduced trust even though ScriptLens had enough material to score it."
            : reducedTrustHeadless
              ? "This analysis uses transcript material recovered through a headless path, so trust is lower than direct transcript or manual caption recovery."
              : acquisition.providerClass === "backend"
                ? "This analysis uses recovered transcript material because the on-page transcript path was incomplete."
                : "This analysis uses transcript material, but coverage or segment quality is still limited."
          : "This analysis uses useful local content, but source cleanliness and sample size still shape the score.",
      reasons: buildAcquisitionReasons(acquisition)
    };
  }

  return {
    label: "Weak input",
    summary:
      acquisition.quality === "enhanced-extraction-unavailable"
        ? acquisition.kind === "transcript"
          ? buildTranscriptUnavailableMessage(acquisition)
          : "ScriptLens could not retrieve a reliable source from this page."
        : acquisition.kind === "transcript"
          ? "This score is directional only because ScriptLens had to rely on title and description fallback instead of a real transcript."
          : "This score is directional only because the available content is short, noisy, or limited in context.",
    reasons: buildAcquisitionReasons(acquisition)
  };
}

function buildAcquisitionReasons(acquisition) {
  const reasons = [];
  reasons.push(`${capitalize(formatSourceKind(acquisition.kind))}: ${acquisition.sourceLabel}.`);
  reasons.push(`Source confidence: ${capitalize(acquisition.sourceConfidence)}.`);
  if (acquisition.originKind) {
    reasons.push(`Recovery tier: ${acquisition.recoveryTier || "local"} via ${acquisition.originKind}.`);
  }
  if (acquisition.winnerReason) {
    reasons.push(`Winner reason: ${acquisition.winnerReason}.`);
  }

  if (typeof acquisition.coverageRatio === "number") {
    reasons.push(`Coverage ratio: ${Math.round(acquisition.coverageRatio * 100)}%.`);
  }
  if (acquisition.kind === "transcript" && acquisition.segmentCount) {
    reasons.push(`Captured ${acquisition.segmentCount} normalized segments.`);
  }
  if (acquisition.providerClass === "backend") {
    reasons.push("Recovered transcript text was used after the on-page transcript path came back weak or unavailable.");
  }
  if (acquisition.sourceTrustTier === "audio-derived") {
    reasons.push("Audio-derived transcript recovery always carries reduced trust compared with caption or direct transcript sources.");
  }
  if (acquisition.sourceTrustTier === "headless-derived") {
    reasons.push("Headless transcript recovery is treated as weaker than direct transcript and manual caption sources.");
  }
  if (acquisition.isGenerated === true) {
    reasons.push("The winning source uses generated captions.");
  }
  if (acquisition.kind === "selection") {
    reasons.push("Only the selected passage was analyzed, so broader page context is excluded.");
  }
  if (acquisition.kind === "manual-input") {
    reasons.push("Pasted text avoids page extraction noise and is scored directly.");
  }
  if (acquisition.warnings?.includes("fallback_source")) {
    reasons.push("Fallback context was used instead of a full transcript.");
  }

  return reasons.slice(0, 4);
}

function buildInterpretation(acquisition, inputQuality) {
  const weakEvidence = acquisition?.quality === "weak-fallback";
  const transcriptMissing = acquisition?.quality === "enhanced-extraction-unavailable";
  const contentSource = acquisition?.kind && acquisition.kind !== "transcript";

  return {
    means:
      "The score reflects how strongly the writing matches AI-like patterns in structure, phrasing, and rhythm.",
    notMeans:
      "It is not proof of authorship and should not be treated as a definitive human-vs-AI judgment.",
    falsePositives: [
      "Highly polished scripts, voiceovers, study guides, and SEO copy can trigger strong pattern matches.",
      weakEvidence
        ? contentSource
          ? "Short or noisy page captures can overstate patterns because there is less surrounding context."
          : "Short title and description fallbacks can overstate packaging signals without enough transcript context."
        : contentSource
          ? "Heavily edited article or page content can read more uniform than the original authored workflow."
          : "Edited transcripts can sound more uniform than the original spoken performance.",
      "Heavily edited marketing or educational copy can read as more templated than its source."
    ],
    trustMore: transcriptMissing
      ? [
          contentSource
            ? "Use a longer direct text sample or a cleaner article page when possible."
            : "Use a video with readable captions or a visible transcript panel when possible.",
          "Longer direct text samples usually produce a more stable result."
        ]
      : inputQuality.label === "Strong input"
        ? [
            "The source is relatively clean and long enough to surface repeated structure instead of one-off phrasing.",
            "Transcript provenance and confidence are separate from AI-likelihood, so read both together."
          ]
        : [
            contentSource
              ? "Use longer text and cleaner article or page captures for a more stable result."
              : "Use longer text and cleaner transcript sources for a more stable result.",
            contentSource
              ? "Short selections and noisy page captures should be treated as weak evidence."
              : "Fallback title and description analysis should be treated as weak evidence."
          ]
  };
}

function buildSourceInfo(acquisition) {
  return {
    kind: acquisition.kind || null,
    analysisMode: acquisition.analysisMode || null,
    sourceLabel: acquisition.sourceLabel,
    sourceConfidence: acquisition.sourceConfidence,
    quality: acquisition.quality,
    provider: acquisition.provider,
    providerClass: acquisition.providerClass || "local",
    strategy: acquisition.strategy,
    acquisitionState: acquisition.acquisitionState || null,
    transcriptRequiredSatisfied: acquisition.transcriptRequiredSatisfied ?? true,
    failureReason: acquisition.failureReason || null,
    recoveryTier:
      acquisition.kind === "transcript"
        ? acquisition.recoveryTier || "local"
        : acquisition.recoveryTier || null,
    originKind: acquisition.originKind || null,
    sourceTrustTier: acquisition.sourceTrustTier || null,
    winnerReason: acquisition.winnerReason || null,
    languageCode: acquisition.languageCode,
    originalLanguageCode: acquisition.originalLanguageCode,
    isGenerated: acquisition.isGenerated,
    isTranslated: acquisition.isTranslated,
    warnings: acquisition.warnings || [],
    requestShapeValidation: acquisition.requestShapeValidation || null,
    qualityGate: acquisition.qualityGate || null
  };
}

function buildAcquisitionFailureMessage(acquisition) {
  if (ServiceWorkerReport.buildAcquisitionFailureMessage) {
    return ServiceWorkerReport.buildAcquisitionFailureMessage(acquisition);
  }
  if (!acquisition) {
    return "No usable text could be extracted.";
  }
  if (acquisition.quality === "enhanced-extraction-unavailable") {
    return acquisition.kind === "transcript"
      ? acquisition.failureReason === "transcript_required"
        ? "ScriptLens could not get a transcript for this video, and the current settings did not allow a title or description fallback."
        : buildTranscriptUnavailableMessage(acquisition)
      : "ScriptLens could not retrieve a reliable source from this page.";
  }
  return "No usable video text could be extracted from the selected sources.";
}

function buildTranscriptUnavailableMessage(acquisition) {
  if (ServiceWorkerReport.buildTranscriptUnavailableMessage) {
    return ServiceWorkerReport.buildTranscriptUnavailableMessage(acquisition);
  }
  const failureReason = String(acquisition?.failureReason || "").trim();
  const warnings = Array.isArray(acquisition?.warnings) ? acquisition.warnings : [];
  const hasCode = (code) => failureReason === code || warnings.includes(code);

  if (
    hasCode("caption_fetch_failed") ||
    hasCode("youtubei_failed_precondition") ||
    hasCode("youtubei_failed")
  ) {
    return "ScriptLens found transcript info for this video, but YouTube did not return enough transcript text to score right now.";
  }

  if (hasCode("backend_timeout")) {
    return "ScriptLens found transcript info for this video, but the optional recovery step did not finish in time.";
  }

  if (hasCode("language_mismatch") || hasCode("language_requested_mismatch")) {
    return "ScriptLens found transcript material, but it did not match the requested language closely enough to score safely.";
  }

  if (hasCode("quality_gate_rejected")) {
    return "ScriptLens found transcript material, but it was too weak or degraded to score safely.";
  }

  return "ScriptLens could not retrieve a usable transcript for this video right now.";
}

function buildDirectSourceLabel(sourceMeta) {
  if (ServiceWorkerReport.buildDirectSourceLabel) {
    return ServiceWorkerReport.buildDirectSourceLabel(sourceMeta);
  }
  return buildAnalysisDisplaySource(
    {
      kind: mapDirectKind(sourceMeta),
      sourceLabel: sourceMeta?.sourceLabel || "Local analysis"
    },
    sourceMeta?.title || ""
  );
}

function buildYouTubeSourceLabel(title, acquisition) {
  return `YouTube video - ${title} - ${acquisition.sourceLabel}`;
}

function buildAnalysisDisplaySource(acquisition, title) {
  if (ServiceWorkerReport.buildAnalysisDisplaySource) {
    return ServiceWorkerReport.buildAnalysisDisplaySource(acquisition, title);
  }
  const safeTitle = String(title || "").trim();

  if (acquisition.kind === "transcript") {
    return buildYouTubeSourceLabel(safeTitle || "Untitled video", acquisition);
  }
  if (acquisition.kind === "article-content") {
    return safeTitle ? `Article content - ${safeTitle}` : "Article content";
  }
  if (acquisition.kind === "page-content") {
    return safeTitle ? `Visible page content - ${safeTitle}` : "Visible page content";
  }
  if (acquisition.kind === "selection") {
    return safeTitle ? `Selected text - ${safeTitle}` : "Selected text";
  }
  if (acquisition.kind === "manual-input") {
    return "Pasted text";
  }

  return safeTitle || acquisition.sourceLabel || "Local analysis";
}

function mapDirectKind(sourceMeta) {
  if (ServiceWorkerReport.mapDirectKind) {
    return ServiceWorkerReport.mapDirectKind(sourceMeta);
  }
  const sourceType = String(
    sourceMeta?.kind || sourceMeta?.sourceType || ""
  ).toLowerCase();

  if (sourceType === "manual" || sourceType === "manual-input") {
    return "manual-input";
  }
  if (sourceType === "selection") {
    return "selection";
  }
  if (sourceType === "article" || sourceType === "article-content") {
    return "article-content";
  }
  return "page-content";
}

function formatSourceKind(kind) {
  if (kind === "manual-input") {
    return "manual input";
  }
  if (kind === "article-content") {
    return "article content";
  }
  if (kind === "page-content") {
    return "page content";
  }
  if (kind === "selection") {
    return "selection";
  }
  return "transcript source";
}

function createNavigationAbortController(tabId, expectedVideoId) {
  const controller = new AbortController();
  let disposed = false;
  let timer = null;

  const check = async () => {
    if (disposed || controller.signal.aborted) {
      return;
    }

    const latestTab = await getTabById(tabId).catch(() => null);
    const currentVideoId = latestTab?.url ? extractVideoIdFromUrl(latestTab.url) : "";
    if (!latestTab?.id || (expectedVideoId && currentVideoId !== expectedVideoId)) {
      controller.abort(new Error("navigation_changed"));
      stop();
    }
  };

  const tick = async () => {
    await check();
    if (!disposed && !controller.signal.aborted) {
      timer = setTimeout(tick, 180);
    }
  };

  timer = setTimeout(tick, 180);

  function stop() {
    disposed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return {
    signal: controller.signal,
    stop
  };
}

async function requestTabExtraction(tabId, message) {
  if (!Number.isFinite(Number(tabId))) {
    logger.warn("tab extraction skipped without tab id", {
      messageType: message?.type || ""
    });
    return {
      ok: false,
      error: "Open a supported YouTube video and try again."
    };
  }

  try {
    return await sendTabMessage(tabId, message);
  } catch (error) {
    logger.warn("tab extraction failed", {
      tabId,
      messageType: message?.type || "",
      error: serializeError(error)
    });
    return {
      ok: false,
      error: error?.message || "Could not communicate with the current page."
    };
  }
}

async function getHydratedPageContext(tab) {
  const resolvedTab = tab || (await getActiveTab().catch(() => null));
  if (!resolvedTab?.id) {
    logger.warn("page context unavailable without active tab");
    return buildUnsupportedPageContext(null);
  }

  if (!isSupportedYouTubeUrl(resolvedTab.url)) {
    logger.info("page context unsupported", {
      tabId: resolvedTab?.id || null,
      url: resolvedTab?.url || ""
    });
    return buildUnsupportedPageContext(resolvedTab);
  }

  try {
    const payload = await sendTabMessage(resolvedTab.id, {
      type: "page:context",
      enableDefuddleExperiment: ENABLE_DEFUDDLE_EXPERIMENT
    });
    if (!payload?.ok) {
      logger.warn("page context payload failed", {
        tabId: resolvedTab.id,
        error: payload?.error || ""
      });
      return buildUnsupportedPageContext(
        resolvedTab,
        payload?.error || "Reload this YouTube tab and try again."
      );
    }

    const rawContext = payload.context || { supported: true };
    logger.info("page context hydrated", {
      tabId: resolvedTab.id,
      context: summarizePageContext(rawContext)
    });
    return hydratePageContext(rawContext, resolvedTab);
  } catch (error) {
    logger.warn("page context messaging failed", {
      tabId: resolvedTab?.id || null,
      error: serializeError(error)
    });
    return buildUnsupportedPageContext(
      resolvedTab,
      "Reload this YouTube tab and try again."
    );
  }
}

function hydratePageContext(rawContext, tab) {
  if (!rawContext?.supported) {
    return {
      ...(rawContext || { supported: false }),
      tabId: tab?.id || null,
      windowId: tab?.windowId || null,
      url: tab?.url || ""
    };
  }

  const recommendedRequest = buildRecommendedRequest(rawContext);
  const video = rawContext.video
    ? {
        ...rawContext.video,
        defaultPreset:
          recommendedRequest?.mode === "youtube"
            ? {
                includeSources: recommendedRequest.includeSources || [],
                trackBaseUrl: recommendedRequest.trackBaseUrl || "",
                allowFallbackText: Boolean(recommendedRequest.allowFallbackText)
              }
            : null
      }
    : null;

  return {
    ...rawContext,
    hostname: normalizeHost(rawContext.hostname || ""),
    tabId: tab?.id || null,
    windowId: tab?.windowId || null,
    url: tab?.url || "",
    recommendedMode: recommendedRequest?.mode || null,
    recommendedRequest,
    video
  };
}

function buildRecommendedRequest(context) {
  if (context.isYouTubeVideo && context.video) {
    return {
      mode: "youtube",
      includeSources: ["transcript"],
      transcriptBias: "manual-en",
      trackBaseUrl: context.video.defaultTrackBaseUrl || "",
      requireTranscript: true,
      allowFallbackText: false
    };
  }

  return null;
}

function resolveRequestedAction(pageContext, request) {
  if (!request || request.mode === "recommended") {
    return pageContext?.recommendedRequest || null;
  }

  if (request.mode === "selection" || request.mode === "page") {
    return { mode: request.mode };
  }

  if (request.mode === "manual") {
    return {
      mode: "manual",
      text: String(request.text || "")
    };
  }

  if (request.mode === "youtube") {
    return {
      mode: "youtube",
      includeSources: normalizeVideoSources(request.includeSources),
      transcriptBias: request.transcriptBias || "manual-en",
      trackBaseUrl: request.trackBaseUrl || "",
      requireTranscript: request.requireTranscript !== false,
      allowFallbackText: Boolean(request.allowFallbackText)
    };
  }

  return null;
}

async function loadSettings() {
  const { settings } = await localGet([STORAGE_KEYS.settings]);
  const normalized = normalizeSettings(settings || {});
  if (!normalized.clientInstanceId || normalized.clientInstanceId !== settings?.clientInstanceId) {
    await localSet({
      [STORAGE_KEYS.settings]: normalized
    });
  }
  return normalized;
}

async function saveSettings(nextSettings) {
  const merged = normalizeSettings({
    ...(await loadSettings()),
    ...nextSettings
  });

  await localSet({
    [STORAGE_KEYS.settings]: merged
  });

  return merged;
}

async function loadRecentReports() {
  const { recentReports } = await localGet([STORAGE_KEYS.recentReports]);
  return Array.isArray(recentReports) ? recentReports : [];
}

async function persistRecentReport(report, limit) {
  const current = await loadRecentReports();
  const stored = [summarizeReport(report), ...current].slice(
    0,
    limit || DEFAULT_SETTINGS.recentReportsLimit
  );

  await localSet({
    [STORAGE_KEYS.recentReports]: stored
  });
}

function summarizeReport(report) {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    source: report.source,
    score: report.score,
    verdict: report.verdict,
    summary: report.explanation,
    kind: report.acquisition?.kind || null,
    provider: report.acquisition?.provider || null,
    providerClass: report.acquisition?.providerClass || "local",
    strategy: report.acquisition?.strategy || null,
    sourceLabel: report.acquisition?.sourceLabel || null,
    sourceConfidence: report.acquisition?.sourceConfidence || null,
    acquisitionQuality: report.acquisition?.quality || null,
    acquisitionState: report.acquisition?.acquisitionState || null,
    languageCode: report.acquisition?.languageCode || null,
    segmentCount: report.acquisition?.segmentCount || 0,
    coverageRatio: report.acquisition?.coverageRatio ?? null
  };
}

async function loadDebugReports() {
  const { debugReports } = await localGet([STORAGE_KEYS.debugReports]);
  return Array.isArray(debugReports) ? debugReports : [];
}

async function persistDebugReport(report) {
  const current = await loadDebugReports();
  const entry = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    kind: report.acquisition?.kind || null,
    sourceLabel: report.acquisition?.sourceLabel || null,
    providerPathAttempted: report.acquisition?.resolverPath || [],
    winningProvider: report.acquisition?.provider || null,
    winningProviderClass: report.acquisition?.providerClass || "local",
    winningStrategy: report.acquisition?.strategy || null,
    winnerReason: report.acquisition?.winnerReason || null,
    winnerSelectedBy: report.acquisition?.winnerSelectedBy || [],
    recoveryTier: report.acquisition?.recoveryTier || null,
    originKind: report.acquisition?.originKind || null,
    sourceTrustTier: report.acquisition?.sourceTrustTier || null,
    normalizedTextSlice: report.acquisition?.text || "",
    languageCode: report.acquisition?.languageCode || null,
    originalLanguageCode: report.acquisition?.originalLanguageCode || null,
    segmentCount: report.acquisition?.segmentCount || 0,
    coverageRatio: report.acquisition?.coverageRatio ?? null,
    qualityGate: report.acquisition?.qualityGate || null,
    warnings: report.acquisition?.warnings || [],
    errors: report.acquisition?.errors || [],
    resolverAttempts: report.acquisition?.resolverAttempts || [],
    quality: report.acquisition?.quality || null,
    acquisitionState: report.acquisition?.acquisitionState || null,
    failureReason: report.acquisition?.failureReason || null,
    sourceConfidence: report.acquisition?.sourceConfidence || null
  };

  await localSet({
    [STORAGE_KEYS.debugReports]: [entry, ...current].slice(0, 10)
  });
}

async function getSitePreference(hostname) {
  const normalizedHost = normalizeHost(hostname);
  if (!normalizedHost) {
    return {};
  }

  const { sitePreferences } = await localGet([STORAGE_KEYS.sitePreferences]);
  return sitePreferences?.[normalizedHost] || {};
}

async function saveSitePreference(hostname, updates) {
  const normalizedHost = normalizeHost(hostname);
  if (!normalizedHost) {
    return {};
  }

  const { sitePreferences } = await localGet([STORAGE_KEYS.sitePreferences]);
  const nextPreferences = {
    ...(sitePreferences || {}),
    [normalizedHost]: {
      ...(sitePreferences?.[normalizedHost] || {}),
      ...(updates || {})
    }
  };

  await localSet({
    [STORAGE_KEYS.sitePreferences]: nextPreferences
  });

  return nextPreferences[normalizedHost];
}

async function loadUiHints() {
  const { uiHints } = await localGet([STORAGE_KEYS.uiHints]);
  return {
    ...DEFAULT_UI_HINTS,
    ...(uiHints || {})
  };
}

async function updateUiHints(updates) {
  const nextHints = {
    ...(await loadUiHints()),
    ...updates
  };

  await localSet({
    [STORAGE_KEYS.uiHints]: nextHints
  });

  return nextHints;
}

async function loadLaunchRequest() {
  const { panelLaunchRequest } = await sessionGet([SESSION_KEYS.panelLaunchRequest]);
  return panelLaunchRequest || null;
}

async function saveLaunchRequest(value) {
  await sessionSet({
    [SESSION_KEYS.panelLaunchRequest]: value
  });
}

async function clearLaunchRequest() {
  await sessionRemove([SESSION_KEYS.panelLaunchRequest]);
}

function normalizeSettings(input) {
  const sensitivity = ["low", "medium", "high"].includes(input.sensitivity)
    ? input.sensitivity
    : DEFAULT_SETTINGS.sensitivity;
  const clientInstanceId =
    typeof input.clientInstanceId === "string" && input.clientInstanceId.trim()
      ? input.clientInstanceId.trim()
      : buildClientInstanceId();

  const backendTranscriptEndpoint =
    typeof input.backendTranscriptEndpoint === "string" &&
    input.backendTranscriptEndpoint.trim()
      ? input.backendTranscriptEndpoint.trim()
      : DEFAULT_SETTINGS.backendTranscriptEndpoint;
  const backendRecoveryConfigured = Boolean(backendTranscriptEndpoint);

  return {
    ...DEFAULT_SETTINGS,
    sensitivity,
    clientInstanceId,
    maxTextLength: clampNumber(
      input.maxTextLength,
      4000,
      50000,
      DEFAULT_SETTINGS.maxTextLength
    ),
    debugMode: Boolean(input.debugMode),
    allowBackendTranscriptFallback:
      backendRecoveryConfigured &&
      typeof input.allowBackendTranscriptFallback === "boolean"
        ? input.allowBackendTranscriptFallback
        : DEFAULT_SETTINGS.allowBackendTranscriptFallback,
    backendTranscriptEndpoint
  };
}

function buildClientInstanceId() {
  const token = Math.random().toString(16).slice(2, 10);
  return `client-${Date.now()}-${token}`;
}

function normalizeVideoSources(value) {
  const allowed = new Set(["transcript", "description", "title"]);
  const list = Array.isArray(value) ? value : [];
  const normalized = list.filter((source) => allowed.has(source));
  return normalized.length ? normalized : ["transcript"];
}

function selectAutomaticAsrDurationLimit(surface) {
  const maxVideoLength = RECOVERY_POLICY?.backend?.maxVideoLengthSeconds || {};
  if (surface === "inline") {
    return maxVideoLength.automaticAsr || null;
  }
  return maxVideoLength.manualAsr || maxVideoLength.absolute || null;
}

async function getCurrentHost() {
  const pageContext = await getHydratedPageContext();
  return pageContext?.hostname || "";
}

async function resolveContextTab(message, sender, preferSenderTab = false) {
  if (preferSenderTab && sender?.tab?.id) {
    logger.info("resolved tab from sender", {
      preferSenderTab,
      tabId: sender.tab.id,
      url: sender.tab.url || ""
    });
    return sender.tab;
  }

  const explicitTabId = Number(message?.tabId);
  if (Number.isFinite(explicitTabId)) {
    logger.info("resolved tab from explicit id", {
      tabId: explicitTabId,
      windowId: Number(message?.windowId) || null
    });
    return getTabById(explicitTabId).catch(() => ({
      id: explicitTabId,
      windowId: Number(message?.windowId) || null,
      url: ""
    }));
  }

  if (sender?.tab?.id) {
    logger.info("resolved tab from sender fallback", {
      tabId: sender.tab.id,
      url: sender.tab.url || ""
    });
    return sender.tab;
  }

  logger.info("resolved tab from active browser tab");
  return getActiveTab();
}

function normalizeAnalysisOptions(options = {}) {
  return {
    surface: options.surface || "unknown",
    allowDomTranscriptLoader: options.allowDomTranscriptLoader !== false
  };
}

async function resolveTabForLaunch(message, sender) {
  if (sender?.tab?.id) {
    return sender.tab;
  }

  const explicitTabId = Number(message?.tabId);
  if (Number.isFinite(explicitTabId)) {
    return getTabById(explicitTabId).catch(() => ({
      id: explicitTabId,
      windowId: Number(message?.windowId) || null,
      url: ""
    }));
  }

  return getActiveTab();
}

async function openSidePanel(windowId) {
  return new Promise((resolve, reject) => {
    chrome.sidePanel.open({ windowId }, () => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      resolve();
    });
  });
}

function getActiveTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      resolve(tabs[0] || null);
    });
  });
}

function getTabById(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      resolve(tab || null);
    });
  });
}

function executeScript(details) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(details, (results) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      resolve(results || []);
    });
  });
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      resolve(response);
    });
  });
}

function localGet(keys) {
  return storageAreaGet(chrome.storage.local, keys);
}

function localSet(value) {
  return storageAreaSet(chrome.storage.local, value);
}

function sessionGet(keys) {
  return storageAreaGet(chrome.storage.session, keys);
}

function sessionSet(value) {
  return storageAreaSet(chrome.storage.session, value);
}

function sessionRemove(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.session.remove(keys, () => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      resolve();
    });
  });
}

function storageAreaGet(area, keys) {
  return new Promise((resolve, reject) => {
    area.get(keys, (value) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      resolve(value);
    });
  });
}

function storageAreaSet(area, value) {
  return new Promise((resolve, reject) => {
    area.set(value, () => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      resolve();
    });
  });
}

function normalizeHost(hostname) {
  return String(hostname || "").replace(/^www\./, "");
}

function buildUnsupportedPageContext(tab, errorMessage) {
  return {
    supported: false,
    isYouTubeVideo: false,
    title: "Open a YouTube video",
    summary: "",
    hostname: normalizeHost(readHostname(tab?.url || "")),
    tabId: tab?.id || null,
    windowId: tab?.windowId || null,
    url: tab?.url || "",
    error:
      errorMessage ||
      "ScriptLens for Chrome currently supports desktop YouTube watch pages only."
  };
}

function isSupportedYouTubeUrl(value) {
  try {
    const url = new URL(String(value || ""));
    const host = normalizeHost(url.hostname);
    return host === "youtube.com" && url.pathname === "/watch" && Boolean(url.searchParams.get("v"));
  } catch (error) {
    return false;
  }
}

function readHostname(value) {
  try {
    return new URL(String(value || "")).hostname || "";
  } catch (error) {
    return "";
  }
}

function capitalize(value) {
  const text = String(value || "");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

function dedupeList(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = String(value || "");
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function clampNumber(value, min, max, fallback) {
  const nextValue = Number(value);
  if (!Number.isFinite(nextValue)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(nextValue)));
}

function extractVideoIdFromUrl(value) {
  try {
    const url = new URL(value);
    if (url.pathname === "/watch") {
      return url.searchParams.get("v") || "";
    }
    const shortsMatch = url.pathname.match(/^\/shorts\/([^/?#]+)/);
    return shortsMatch ? shortsMatch[1] : "";
  } catch (error) {
    return "";
  }
}

function summarizeRequest(request) {
  if (!request) {
    return null;
  }

  return {
    mode: request.mode || null,
    includeSources: Array.isArray(request.includeSources)
      ? request.includeSources.slice()
      : [],
    trackBaseUrl: request.trackBaseUrl || "",
    requireTranscript:
      typeof request.requireTranscript === "boolean" ? request.requireTranscript : null,
    allowFallbackText: Boolean(request.allowFallbackText)
  };
}

function summarizePageContext(pageContext) {
  if (!pageContext) {
    return null;
  }

  return {
    supported: Boolean(pageContext.supported),
    tabId: pageContext.tabId || null,
    url: pageContext.url || "",
    isYouTubeVideo: Boolean(pageContext.isYouTubeVideo),
    transcriptAvailable: Boolean(pageContext.transcriptAvailable),
    video: pageContext.video
      ? {
          title: pageContext.video.title || "",
          videoId: pageContext.video.videoId || "",
          availableSources: pageContext.video.availableSources || {},
          transcriptTrackCount: Array.isArray(pageContext.video.transcriptTracks)
            ? pageContext.video.transcriptTracks.length
            : 0
        }
      : null
  };
}

function summarizeAdapter(adapter) {
  if (!adapter) {
    return null;
  }

  return {
    title: adapter.title || "",
    videoId: adapter.videoId || "",
    descriptionLength: String(adapter.description || "").length,
    descriptionTranscriptLength: String(adapter.descriptionTranscriptText || "").length,
    domTranscriptSegments: Array.isArray(adapter.domTranscriptSegments)
      ? adapter.domTranscriptSegments.length
      : 0,
    bootstrap: {
      captionTracks: Array.isArray(adapter.bootstrapSnapshot?.captionTracks)
        ? adapter.bootstrapSnapshot.captionTracks.length
        : 0,
      transcriptParams: Boolean(adapter.bootstrapSnapshot?.transcriptParams),
      observedTranscriptRequest: Boolean(
        adapter.bootstrapSnapshot?.observedTranscriptRequest?.params
      ),
      hl: adapter.bootstrapSnapshot?.hl || ""
    }
  };
}

function summarizeAcquisition(acquisition) {
  if (!acquisition) {
    return null;
  }

  return {
    ok: Boolean(acquisition.ok),
    kind: acquisition.kind || null,
    analysisMode: acquisition.analysisMode || null,
    provider: acquisition.provider || null,
    providerClass: acquisition.providerClass || null,
    strategy: acquisition.strategy || null,
    recoveryTier: acquisition.recoveryTier || null,
    originKind: acquisition.originKind || null,
    sourceTrustTier: acquisition.sourceTrustTier || null,
    winnerReason: acquisition.winnerReason || null,
    sourceLabel: acquisition.sourceLabel || null,
    sourceConfidence: acquisition.sourceConfidence || null,
    quality: acquisition.quality || null,
    acquisitionState: acquisition.acquisitionState || null,
    qualityGate: acquisition.qualityGate || null,
    warnings: Array.isArray(acquisition.warnings) ? acquisition.warnings.slice(0, 8) : [],
    failureReason: acquisition.failureReason || null,
    resolverPath: Array.isArray(acquisition.resolverPath)
      ? acquisition.resolverPath.slice(0, 8)
      : [],
    errors: Array.isArray(acquisition.errors)
      ? acquisition.errors.slice(0, 6).map((error) => ({
          strategy: error?.strategy || "",
          code: error?.code || "",
          message: error?.message || ""
        }))
      : [],
    segmentCount: acquisition.segmentCount || 0,
    coverageRatio:
      typeof acquisition.coverageRatio === "number" ? acquisition.coverageRatio : null,
    textLength: String(acquisition.text || "").length
  };
}

function summarizeReportForLog(report) {
  if (!report) {
    return null;
  }

  return {
    source: report.source || "",
    score: report.score || 0,
    verdict: report.verdict || "",
    acquisition: summarizeAcquisition(report.acquisition)
  };
}

function serializeError(error) {
  if (!error) {
    return null;
  }

  return {
    name: error.name || "Error",
    message: error.message || String(error),
    stack: error.stack || ""
  };
}

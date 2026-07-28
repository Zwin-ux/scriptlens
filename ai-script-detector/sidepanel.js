(function () {
  const DEFAULT_SETTINGS = {
    sensitivity: "medium",
    maxTextLength: 18000,
    debugMode: false,
    allowBackendTranscriptFallback: false,
    backendTranscriptEndpoint: ""
  };
  const DEFAULT_SELECTION = {
    includeSources: ["transcript"],
    trackBaseUrl: "",
    allowFallbackText: false
  };
  const DEFAULT_DISCLAIMER =
    "This score reflects AI-like writing patterns, not proof of authorship.";
  const Surface = globalThis.ScriptLensSurface;
  const Debug = globalThis.ScriptLensDebug || {};
  const logger = Debug.createLogger
    ? Debug.createLogger("sidepanel")
    : console;
  if (Debug.installGlobalErrorHandlers) {
    Debug.installGlobalErrorHandlers("sidepanel");
  }

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    recentReports: [],
    pageContext: null,
    currentReport: null,
    videoSelection: { ...DEFAULT_SELECTION },
    busy: false,
    activeTabId: null,
    lastHandledLaunchAt: 0,
    refreshTimer: 0,
    refreshToken: 0,
    targetContext: readTargetContext()
  };

  const elements = {};

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    logger.info("init", {
      targetContext: state.targetContext
    });
    cacheElements();
    bindEvents();
    showStatus("Loading workspace...", "info");

    await refreshWorkspace(false);
    registerExtensionListeners();
    clearStatus();
  }

  function cacheElements() {
    elements.statusBanner = document.getElementById("statusBanner");
    elements.pageTitle = document.getElementById("pageTitle");
    elements.pageSummary = document.getElementById("pageSummary");
    elements.pageBadges = document.getElementById("pageBadges");
    elements.recommendedActionTitle = document.getElementById("recommendedActionTitle");
    elements.recommendedActionCopy = document.getElementById("recommendedActionCopy");
    elements.recommendedActionButton = document.getElementById("recommendedActionButton");
    elements.openWorkspaceButton = document.getElementById("openWorkspaceButton");
    elements.youtubeControls = document.getElementById("youtubeControls");
    elements.videoSourceChips = document.getElementById("videoSourceChips");
    elements.trackField = document.getElementById("trackField");
    elements.trackSelect = document.getElementById("trackSelect");
    elements.allowFallbackTextInput = document.getElementById("allowFallbackTextInput");
    elements.sensitivitySelect = document.getElementById("sensitivitySelect");
    elements.maxTextLengthInput = document.getElementById("maxTextLengthInput");
    elements.debugModeInput = document.getElementById("debugModeInput");
    elements.allowBackendTranscriptFallbackInput = document.getElementById(
      "allowBackendTranscriptFallbackInput"
    );
    elements.backendRecoveryNote = document.getElementById("backendRecoveryNote");
    elements.saveSettingsButton = document.getElementById("saveSettingsButton");
    elements.resultPanel = document.getElementById("resultPanel");
    elements.resultEmpty = document.getElementById("resultEmpty");
    elements.resultContent = document.getElementById("resultContent");
    elements.scoreBadge = document.getElementById("scoreBadge");
    elements.scoreValue = document.getElementById("scoreValue");
    elements.verdictBadge = document.getElementById("verdictBadge");
    elements.qualityBadge = document.getElementById("qualityBadge");
    elements.providerBadge = document.getElementById("providerBadge");
    elements.reportExplanation = document.getElementById("reportExplanation");
    elements.acquisitionStateCopy = document.getElementById("acquisitionStateCopy");
    elements.reportSource = document.getElementById("reportSource");
    elements.reportCounts = document.getElementById("reportCounts");
    elements.reportMeta = document.getElementById("reportMeta");
    elements.sourceValue = document.getElementById("sourceValue");
    elements.sourceMeta = document.getElementById("sourceMeta");
    elements.sourceConfidenceValue = document.getElementById("sourceConfidenceValue");
    elements.sourceConfidenceMeta = document.getElementById("sourceConfidenceMeta");
    elements.detectorConfidenceValue = document.getElementById("detectorConfidenceValue");
    elements.detectorConfidenceMeta = document.getElementById("detectorConfidenceMeta");
    elements.privacyDisclosure = document.getElementById("privacyDisclosure");
    elements.qualitySummary = document.getElementById("qualitySummary");
    elements.trustMeans = document.getElementById("trustMeans");
    elements.trustNotMeans = document.getElementById("trustNotMeans");
    elements.falsePositiveList = document.getElementById("falsePositiveList");
    elements.trustMoreList = document.getElementById("trustMoreList");
    elements.categoryGrid = document.getElementById("categoryGrid");
    elements.topReasonsList = document.getElementById("topReasonsList");
    elements.flaggedCount = document.getElementById("flaggedCount");
    elements.flaggedSentencesList = document.getElementById("flaggedSentencesList");
    elements.debugSection = document.getElementById("debugSection");
    elements.debugWinningPath = document.getElementById("debugWinningPath");
    elements.debugWinnerReason = document.getElementById("debugWinnerReason");
    elements.debugWarnings = document.getElementById("debugWarnings");
    elements.debugErrors = document.getElementById("debugErrors");
    elements.recentReportsList = document.getElementById("recentReportsList");
  }

  function bindEvents() {
    elements.recommendedActionButton.addEventListener("click", () => {
      analyzeRequest(getRecommendedRequest());
    });
    elements.openWorkspaceButton.addEventListener("click", async () => {
      showStatus("Refreshing current video...", "info");
      await refreshWorkspace(true);
      clearStatus();
    });
    elements.videoSourceChips.addEventListener("click", handleVideoChipClick);
    elements.trackSelect.addEventListener("change", () => {
      state.videoSelection.trackBaseUrl = elements.trackSelect.value;
      renderRecommendation();
    });
    elements.allowFallbackTextInput.addEventListener("change", () => {
      state.videoSelection.allowFallbackText = elements.allowFallbackTextInput.checked;
      renderRecommendation();
    });
    elements.saveSettingsButton.addEventListener("click", saveSettings);
  }

  function registerExtensionListeners() {
    chrome.tabs.onActivated.addListener((activeInfo) => {
      logger.info("tabs.onActivated", {
        activeTabId: state.activeTabId,
        nextActiveTabId: activeInfo?.tabId || null,
        targetTabId: state.targetContext?.tabId || null
      });
      if (state.targetContext?.tabId) {
        logger.info("tabs.onActivated ignored for pinned target", {
          targetTabId: state.targetContext.tabId
        });
        return;
      }
      scheduleRefresh("tabs.onActivated");
    });

    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      logger.info("tabs.onUpdated", {
        tabId,
        active: Boolean(tab?.active),
        status: changeInfo?.status || "",
        url: changeInfo?.url || "",
        targetTabId: state.targetContext?.tabId || null
      });
      if (state.targetContext?.tabId && tabId !== state.targetContext.tabId) {
        logger.info("tabs.onUpdated ignored for non-target tab", {
          tabId,
          targetTabId: state.targetContext.tabId
        });
        return;
      }

      if (!state.targetContext?.tabId && !tab.active) {
        return;
      }

      if (changeInfo.status === "complete" || changeInfo.url) {
        scheduleRefresh("tabs.onUpdated");
      }
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "session" && changes.panelLaunchRequest?.newValue) {
        logger.info("storage.onChanged panelLaunchRequest", {
          launchRequest: changes.panelLaunchRequest.newValue
        });
        handleLaunchRequest(changes.panelLaunchRequest.newValue);
      }
    });
  }

  function scheduleRefresh(reason) {
    clearTimeout(state.refreshTimer);
    logger.info("scheduleRefresh", {
      activeTabId: state.activeTabId,
      targetTabId: state.targetContext?.tabId || null,
      reason: reason || "unknown"
    });
    state.refreshTimer = window.setTimeout(() => {
      refreshWorkspace(false).catch((error) => {
        logger.error("scheduled refresh failed", {
          error: summarizeError(error)
        });
        showStatus(error?.message || "Workspace refresh failed.", "error");
      });
    }, 200);
  }

  async function refreshWorkspace(preserveReport) {
    const refreshToken = ++state.refreshToken;
    logger.info("refreshWorkspace:start", {
      refreshToken,
      preserveReport: Boolean(preserveReport),
      activeTabId: state.activeTabId,
      targetContext: state.targetContext
    });
    const response = await sendMessage({
      type: "panel:init",
      ...getTargetContextPayload()
    });
    if (refreshToken !== state.refreshToken) {
      logger.warn("refreshWorkspace:staleResponse", {
        refreshToken,
        currentRefreshToken: state.refreshToken
      });
      return;
    }
    if (!response.ok) {
      logger.warn("refreshWorkspace:failed", {
        refreshToken,
        error: response.error || ""
      });
      showStatus(response.error || "Could not load the workspace.", "error");
      return;
    }

    const nextTabId = response.pageContext?.tabId || null;
    const tabChanged = nextTabId !== null && nextTabId !== state.activeTabId;

    state.settings = {
      ...DEFAULT_SETTINGS,
      ...(response.settings || {})
    };
    state.recentReports = response.recentReports || [];
    state.pageContext = response.pageContext || null;
    state.activeTabId = nextTabId;
    logger.info("refreshWorkspace:success", {
      refreshToken,
      activeTabId: state.activeTabId,
      tabChanged,
      pageContext: summarizePageContext(state.pageContext)
    });

    if (tabChanged && !preserveReport) {
      state.currentReport = null;
    }

    syncVideoSelection(!tabChanged && preserveReport);
    applySettings();
    renderWorkspace();

    if (response.launchRequest) {
      handleLaunchRequest(response.launchRequest);
    }
  }

  function renderWorkspace() {
    renderPageContext();
    renderRecommendedAction();
    renderSourceControls();
    renderReport();
    renderRecentReports();
  }

  function renderPageContext() {
    const viewModel = Surface.buildPageContextViewModel(state.pageContext);
    elements.pageTitle.textContent = viewModel.title;
    elements.pageSummary.textContent = viewModel.summary;
    elements.pageBadges.innerHTML = Surface.renderBadges(viewModel.badges);
  }

  function renderRecommendedAction() {
    const request = getRecommendedRequest();
    const label = Surface.getRequestLabel(request);
    const supported = Boolean(state.pageContext?.supported && state.pageContext?.isYouTubeVideo);

    elements.recommendedActionTitle.textContent = supported
      ? "Analyze this video"
      : label.title;
    elements.recommendedActionCopy.textContent = supported
      ? "Run a transcript-first check for the active video, then compare transcript options below if you want a second pass."
      : label.copy;
    elements.recommendedActionButton.textContent = supported ? "Analyze Video" : label.button;
    elements.recommendedActionButton.disabled = state.busy || !request;
    elements.openWorkspaceButton.disabled = state.busy;
  }

  function renderSourceControls() {
    const context = state.pageContext;
    if (!context?.supported || !context.isYouTubeVideo || !context.video) {
      elements.youtubeControls.classList.add("hidden");
      return;
    }

    elements.youtubeControls.classList.remove("hidden");
    renderVideoSourceChips(context.video.availableSources || {});
    renderTrackSelector(context.video.transcriptTracks || []);
    elements.allowFallbackTextInput.checked = Boolean(state.videoSelection.allowFallbackText);
  }

  function renderVideoSourceChips(availableSources) {
    const labels = {
      transcript: "Transcript",
      description: "Description",
      title: "Title"
    };

    elements.videoSourceChips.innerHTML = ["transcript", "description", "title"]
      .map((source) => {
        const active = state.videoSelection.includeSources.includes(source) ? " active" : "";
        const disabled = availableSources[source] ? "" : " disabled";
        return `<button class="chip-button${active}" type="button" data-source="${source}"${disabled}>${labels[source]}</button>`;
      })
      .join("");
  }

  function renderTrackSelector(tracks) {
    const transcriptSelected = state.videoSelection.includeSources.includes("transcript");
    const captionTracks = filterCaptionTracks(tracks);

    if (!transcriptSelected || !captionTracks.length) {
      elements.trackField.classList.add("hidden");
      return;
    }

    elements.trackField.classList.remove("hidden");
    elements.trackSelect.innerHTML = captionTracks
      .map((track) => {
        const selected = track.baseUrl === state.videoSelection.trackBaseUrl ? " selected" : "";
        return `<option value="${Surface.escapeHtml(track.baseUrl)}"${selected}>${Surface.escapeHtml(track.label)}</option>`;
      })
      .join("");
  }

  function renderReport() {
    const viewModel = Surface.buildReportViewModel(state.currentReport, state.settings);
    if (!viewModel) {
      elements.resultPanel.classList.add("empty-state");
      elements.resultEmpty.classList.remove("hidden");
      elements.resultContent.classList.add("hidden");
      elements.providerBadge.classList.add("hidden");
      elements.privacyDisclosure.classList.add("hidden");
      elements.debugSection.classList.add("hidden");
      return;
    }

    elements.resultPanel.classList.remove("empty-state");
    elements.resultEmpty.classList.add("hidden");
    elements.resultContent.classList.remove("hidden");

    elements.scoreValue.textContent = viewModel.scoreDisplay || String(viewModel.score);
    elements.verdictBadge.textContent = viewModel.verdict;
    elements.verdictBadge.className = `badge verdict-badge ${viewModel.verdictClass}`;
    elements.qualityBadge.textContent = viewModel.inputLabel;
    elements.qualityBadge.className = `badge input-badge ${viewModel.inputClass}`;
    elements.providerBadge.textContent = viewModel.providerLabel;
    elements.providerBadge.className = "badge provider-badge";
    elements.providerBadge.classList.toggle("hidden", !viewModel.providerLabel);
    elements.reportExplanation.textContent = viewModel.explanation;
    elements.acquisitionStateCopy.textContent = viewModel.acquisitionStateNote;
    elements.reportSource.textContent = viewModel.source;
    elements.reportCounts.textContent = viewModel.counts;
    elements.reportMeta.textContent = viewModel.meta;

    elements.scoreBadge.style.background = viewModel.palette.background;
    elements.scoreBadge.style.borderColor = viewModel.palette.border;
    elements.scoreValue.style.color = viewModel.palette.text;

    elements.sourceValue.textContent = viewModel.sourceLabel;
    elements.sourceMeta.textContent = viewModel.sourceMeta;
    elements.sourceConfidenceValue.textContent = viewModel.sourceConfidence;
    elements.sourceConfidenceMeta.textContent = viewModel.sourceConfidenceMeta;
    elements.detectorConfidenceValue.textContent = viewModel.detectorConfidence;
    elements.detectorConfidenceMeta.textContent = viewModel.detectorConfidenceMeta;
    elements.privacyDisclosure.textContent = viewModel.privacyDisclosure;
    elements.privacyDisclosure.classList.toggle("hidden", !viewModel.privacyDisclosure);
    elements.qualitySummary.textContent = viewModel.inputSummary;
    elements.trustMeans.textContent = viewModel.interpretationMeans;
    elements.trustNotMeans.textContent = viewModel.interpretationNotMeans;
    elements.flaggedCount.textContent = `${viewModel.flaggedSentences.length} flagged`;

    renderBulletList(elements.falsePositiveList, viewModel.falsePositives);
    renderBulletList(elements.trustMoreList, viewModel.trustMore);
    renderCategoryGrid(viewModel.categoryScores);
    renderReasonList(viewModel.topReasons);
    renderFlaggedSentences(viewModel.flaggedSentences);
    renderDebug(viewModel);
  }

  function renderCategoryGrid(categoryScores) {
    const entries = Object.entries(categoryScores).sort((left, right) => right[1] - left[1]);
    elements.categoryGrid.innerHTML = entries
      .map(([key, value]) => {
        return `
          <article class="signal-row">
            <div class="signal-meta">
              <strong>${Surface.formatCategoryName(key)}</strong>
              <span>${value}/100</span>
            </div>
            <div class="signal-track">
              <div class="signal-fill" style="width: ${Math.max(0, Math.min(100, value))}%"></div>
            </div>
          </article>
        `;
      })
      .join("");
  }

  function renderReasonList(reasons) {
    if (!reasons.length) {
      elements.topReasonsList.innerHTML =
        '<li class="flag-item">No strong category-level signals were triggered.</li>';
      return;
    }

    elements.topReasonsList.innerHTML = reasons
      .map((reason) => `<li class="flag-item">${Surface.escapeHtml(reason)}</li>`)
      .join("");
  }

  function renderFlaggedSentences(flags) {
    if (!flags.length) {
      elements.flaggedSentencesList.innerHTML =
        '<li class="flag-item">No individual sentence stood out enough to flag.</li>';
      return;
    }

    elements.flaggedSentencesList.innerHTML = flags
      .map((flag) => {
        return `
          <li class="flag-item">
            <strong>Sentence ${flag.sentenceNumber} | severity ${flag.severity}</strong>
            <p>${Surface.escapeHtml(flag.sentence)}</p>
            <p>${Surface.escapeHtml((flag.reasons || []).join(" | "))}</p>
          </li>
        `;
      })
      .join("");
  }

  function renderDebug(viewModel) {
    if (!viewModel.debugVisible) {
      elements.debugSection.classList.add("hidden");
      return;
    }

    elements.debugSection.classList.remove("hidden");
    elements.debugWinningPath.textContent = viewModel.debugWinningPath;
    elements.debugWinnerReason.textContent = viewModel.debugWinnerReason;
    elements.debugWarnings.textContent = viewModel.debugWarnings;
    elements.debugErrors.textContent = viewModel.debugErrors;
  }

  function renderRecentReports() {
    const recentReports = Surface.buildRecentReportsViewModel(state.recentReports);
    if (!recentReports.length) {
      elements.recentReportsList.innerHTML =
        '<li class="recent-item">Recent reports will appear here after analysis.</li>';
      return;
    }

    elements.recentReportsList.innerHTML = recentReports
      .map((report) => {
        return `
          <li class="recent-item">
            <strong>${Surface.escapeHtml(report.source)}</strong>
            <span>${Surface.escapeHtml(`${report.score}/100 - ${report.verdict}`)}</span>
            <span>${Surface.escapeHtml(report.sourceLabel || report.strategy || "Direct input")}</span>
            <span>${Surface.escapeHtml(report.summary || "")}</span>
          </li>
        `;
      })
      .join("");
  }

  function renderBulletList(element, items) {
    if (!items.length) {
      element.innerHTML = "<li>No additional notes.</li>";
      return;
    }

    element.innerHTML = items
      .map((item) => `<li>${Surface.escapeHtml(item)}</li>`)
      .join("");
  }

  function syncVideoSelection(preserveCurrentSelection) {
    const video = state.pageContext?.video;
    if (!video) {
      state.videoSelection = { ...DEFAULT_SELECTION };
      return;
    }

    const defaultPreset = video.defaultPreset || DEFAULT_SELECTION;
    let includeSources = preserveCurrentSelection
      ? state.videoSelection.includeSources.filter((source) => video.availableSources?.[source])
      : [];

    if (!includeSources.length) {
      includeSources = (defaultPreset.includeSources || DEFAULT_SELECTION.includeSources).slice();
    }

    const trackOptions = filterCaptionTracks(video.transcriptTracks || []);
    let trackBaseUrl = preserveCurrentSelection ? state.videoSelection.trackBaseUrl : "";
    if (!trackOptions.find((track) => track.baseUrl === trackBaseUrl)) {
      trackBaseUrl = defaultPreset.trackBaseUrl || trackOptions[0]?.baseUrl || "";
    }

    state.videoSelection = {
      includeSources,
      trackBaseUrl,
      allowFallbackText: preserveCurrentSelection
        ? Boolean(state.videoSelection.allowFallbackText)
        : Boolean(defaultPreset.allowFallbackText)
    };
  }

  function getRecommendedRequest() {
    if (state.pageContext?.supported && state.pageContext?.isYouTubeVideo) {
      return getCurrentVideoRequest();
    }
    return state.pageContext?.recommendedRequest || null;
  }

  function getCurrentVideoRequest() {
    return {
      mode: "youtube",
      includeSources: state.videoSelection.includeSources.slice(),
      trackBaseUrl: state.videoSelection.trackBaseUrl,
      transcriptBias: "manual-en",
      requireTranscript: true,
      allowFallbackText: Boolean(state.videoSelection.allowFallbackText)
    };
  }

  function handleVideoChipClick(event) {
    const button = event.target.closest("[data-source]");
    if (!button || button.disabled) {
      return;
    }

    const source = button.getAttribute("data-source");
    const current = new Set(state.videoSelection.includeSources);
    if (current.has(source) && current.size === 1) {
      return;
    }

    if (current.has(source)) {
      current.delete(source);
    } else {
      current.add(source);
    }

    state.videoSelection.includeSources = Array.from(current);
    renderSourceControls();
    renderRecommendedAction();
  }

  async function saveSettings() {
    showStatus("Saving settings...", "info");

    const response = await sendMessage({
      type: "settings:update",
      ...getTargetContextPayload(),
      settings: {
        sensitivity: elements.sensitivitySelect.value,
        maxTextLength: Number(elements.maxTextLengthInput.value),
        debugMode: elements.debugModeInput.checked,
        allowBackendTranscriptFallback: elements.allowBackendTranscriptFallbackInput.checked
      }
    });

    if (!response.ok) {
      showStatus(response.error || "Could not save settings.", "error");
      return;
    }

    state.settings = {
      ...DEFAULT_SETTINGS,
      ...(response.settings || {})
    };
    applySettings();
    renderWorkspace();
    showStatus("Settings saved locally.", "success");
  }

  async function analyzeRequest(request) {
    if (state.busy || !request) {
      return;
    }

    logger.info("analyzeRequest:start", {
      request
    });
    setBusy(true);
    showStatus("Running analysis...", "info");

    const response = await sendMessage({
      type: "panel:analyze",
      ...getTargetContextPayload(),
      request
    });

    setBusy(false);

    if (!response.ok) {
      logger.warn("analyzeRequest:failed", {
        request,
        error: response.error || "",
        acquisition: response.acquisition || null
      });
      state.currentReport = response.acquisition
        ? buildUnavailableReport(response.acquisition, response.error)
        : null;
      if (response.pageContext) {
        state.pageContext = response.pageContext;
        syncVideoSelection(true);
      }
      renderWorkspace();
      showStatus(response.error || "Analysis failed.", "error");
      return;
    }

    state.currentReport = response.report || null;
    state.recentReports = response.recentReports || [];
    state.pageContext = response.pageContext || state.pageContext;
    state.settings = {
      ...DEFAULT_SETTINGS,
      ...(response.settings || state.settings)
    };
    state.activeTabId = state.pageContext?.tabId || state.activeTabId;

    if (request.mode === "youtube") {
      state.videoSelection = {
        includeSources: (request.includeSources || []).slice(),
        trackBaseUrl: request.trackBaseUrl || "",
        allowFallbackText: Boolean(request.allowFallbackText)
      };
    }

    applySettings();
    syncVideoSelection(true);
    renderWorkspace();
    logger.info("analyzeRequest:success", {
      score: response.report?.score || 0,
      verdict: response.report?.verdict || "",
      activeTabId: state.activeTabId
    });
    showStatus("Analysis complete.", "success");
  }

  async function handleLaunchRequest(launchRequest) {
    if (!launchRequest?.request || !launchRequest.createdAt) {
      return;
    }

    if (launchRequest.createdAt <= state.lastHandledLaunchAt) {
      return;
    }

    state.lastHandledLaunchAt = launchRequest.createdAt;
    logger.info("handleLaunchRequest", {
      launchRequest
    });
    await analyzeRequest(launchRequest.request);
  }

  function applySettings() {
    const backendRecoveryConfigured = Boolean(state.settings.backendTranscriptEndpoint);
    elements.sensitivitySelect.value = state.settings.sensitivity;
    elements.maxTextLengthInput.value = state.settings.maxTextLength;
    elements.debugModeInput.checked = Boolean(state.settings.debugMode);
    elements.allowBackendTranscriptFallbackInput.checked =
      backendRecoveryConfigured && Boolean(state.settings.allowBackendTranscriptFallback);
    elements.allowBackendTranscriptFallbackInput.disabled = !backendRecoveryConfigured;
    elements.backendRecoveryNote.textContent = backendRecoveryConfigured
      ? "This build can call a transcript recovery service when local YouTube transcript paths fail."
      : "No transcript recovery service is configured in this build. Local transcript paths only.";
  }

  function setBusy(isBusy) {
    state.busy = isBusy;
    [
      elements.recommendedActionButton,
      elements.openWorkspaceButton,
      elements.trackSelect,
      elements.allowFallbackTextInput,
      elements.saveSettingsButton,
      elements.sensitivitySelect,
      elements.maxTextLengthInput,
      elements.debugModeInput,
      elements.allowBackendTranscriptFallbackInput
    ].forEach((element) => {
      element.disabled = isBusy;
    });

    if (!isBusy) {
      renderRecommendedAction();
      renderSourceControls();
    }
  }

  function buildUnavailableReport(acquisition, errorMessage) {
    return {
      acquisition,
      detection: {
        aiScore: 0,
        detectorConfidence: "low",
        verdict: "Unavailable",
        reasons: [],
        categoryScores: {},
        triggeredPatterns: [],
        flaggedSentences: [],
        explanation: errorMessage || "Analysis unavailable."
      },
      inputQuality: {
        label: "Weak input",
        summary: "ScriptLens could not resolve a scoreable transcript for this video right now.",
        reasons: acquisition?.warnings || []
      },
      interpretation: {
        means: "No score was produced because ScriptLens could not resolve a scoreable source.",
        notMeans: DEFAULT_DISCLAIMER,
        falsePositives: [],
        trustMore: ["Try a video with available captions or allow a fallback source."]
      },
      metadata: {
        wordCount: 0,
        sentenceCount: 0,
        sensitivity: state.settings.sensitivity
      },
      disclaimer: DEFAULT_DISCLAIMER,
      source: acquisition?.sourceLabel || "Unavailable",
      topReasons: [],
      categoryScores: {},
      flaggedSentences: []
    };
  }

  function filterCaptionTracks(tracks) {
    return tracks.filter(
      (track) =>
        track.kind !== "visible" &&
        track.kind !== "description-transcript" &&
        track.baseUrl !== "visible-dom-transcript" &&
        track.baseUrl !== "description-transcript"
    );
  }

  function showStatus(message, kind) {
    elements.statusBanner.textContent = message;
    elements.statusBanner.className = `status-banner ${kind || "info"}`;
  }

  function clearStatus() {
    elements.statusBanner.textContent = "";
    elements.statusBanner.className = "status-banner hidden";
  }

  async function sendMessage(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      logger.error("sendMessage failed", {
        type: message?.type || "",
        error: summarizeError(error)
      });
      return {
        ok: false,
        error: error?.message || "Extension messaging failed."
      };
    }
  }

  function readTargetContext() {
    const params = new URLSearchParams(window.location.search);
    const tabId = Number(params.get("targetTabId"));
    const windowId = Number(params.get("targetWindowId"));

    return {
      tabId: Number.isFinite(tabId) ? tabId : null,
      windowId: Number.isFinite(windowId) ? windowId : null
    };
  }

  function getTargetContextPayload() {
    return state.targetContext?.tabId
      ? {
          tabId: state.targetContext.tabId,
          windowId: state.targetContext.windowId
        }
      : {};
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
      transcriptAvailable: Boolean(pageContext.transcriptAvailable)
    };
  }

  function summarizeError(error) {
    if (!error) {
      return null;
    }

    return {
      message: error.message || String(error),
      stack: error.stack || ""
    };
  }
})();

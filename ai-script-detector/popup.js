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
    ? Debug.createLogger("popup")
    : console;
  if (Debug.installGlobalErrorHandlers) {
    Debug.installGlobalErrorHandlers("popup");
  }

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    pageContext: null,
    recentReports: [],
    currentReport: null,
    busy: false,
    videoSelection: { ...DEFAULT_SELECTION },
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
    showStatus("Loading ScriptLens...", "info");

    const response = await sendMessage({
      type: "popup:init",
      ...getTargetContextPayload()
    });

    if (!response.ok) {
      showStatus(response.error || "Could not load ScriptLens.", "error");
      return;
    }

    hydrateState(response);
    renderAll();
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
    elements.acquisitionQualityBadge = document.getElementById("acquisitionQualityBadge");
    elements.inputQualityBadge = document.getElementById("inputQualityBadge");
    elements.providerBadge = document.getElementById("providerBadge");
    elements.reportExplanation = document.getElementById("reportExplanation");
    elements.acquisitionStateCopy = document.getElementById("acquisitionStateCopy");
    elements.reportSource = document.getElementById("reportSource");
    elements.reportCounts = document.getElementById("reportCounts");
    elements.reportMeta = document.getElementById("reportMeta");
    elements.transcriptSourceValue = document.getElementById("transcriptSourceValue");
    elements.transcriptSourceMeta = document.getElementById("transcriptSourceMeta");
    elements.transcriptConfidenceValue = document.getElementById("transcriptConfidenceValue");
    elements.transcriptConfidenceMeta = document.getElementById("transcriptConfidenceMeta");
    elements.detectorConfidenceValue = document.getElementById("detectorConfidenceValue");
    elements.detectorConfidenceMeta = document.getElementById("detectorConfidenceMeta");
    elements.privacyDisclosure = document.getElementById("privacyDisclosure");
    elements.inputQualitySummary = document.getElementById("inputQualitySummary");
    elements.trustMeans = document.getElementById("trustMeans");
    elements.trustNotMeans = document.getElementById("trustNotMeans");
    elements.falsePositiveList = document.getElementById("falsePositiveList");
    elements.trustMoreList = document.getElementById("trustMoreList");
    elements.topReasonsList = document.getElementById("topReasonsList");
    elements.categoryGrid = document.getElementById("categoryGrid");
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
    elements.openWorkspaceButton.addEventListener("click", openWorkspace);
    elements.videoSourceChips.addEventListener("click", handleVideoChipClick);
    elements.trackSelect.addEventListener("change", () => {
      state.videoSelection.trackBaseUrl = elements.trackSelect.value;
    });
    elements.allowFallbackTextInput.addEventListener("change", () => {
      state.videoSelection.allowFallbackText = elements.allowFallbackTextInput.checked;
    });
    elements.saveSettingsButton.addEventListener("click", saveSettings);
  }

  function hydrateState(response) {
    state.settings = {
      ...DEFAULT_SETTINGS,
      ...(response.settings || {})
    };
    state.pageContext = response.pageContext || null;
    state.recentReports = response.recentReports || [];
    syncVideoSelection(false);
    applySettings();
  }

  function renderAll() {
    renderContext();
    renderRecommendation();
    renderSourceControls();
    renderReport();
    renderRecentReports();
  }

  function renderContext() {
    const viewModel = Surface.buildPageContextViewModel(state.pageContext);
    elements.pageTitle.textContent = viewModel.title;
    elements.pageSummary.textContent = viewModel.summary;
    elements.pageBadges.innerHTML = Surface.renderBadges(viewModel.badges);
  }

  function renderRecommendation() {
    const request = getRecommendedRequest();
    const label = Surface.getRequestLabel(request);
    const supported = Boolean(state.pageContext?.supported && state.pageContext?.isYouTubeVideo);

    elements.recommendedActionTitle.textContent = supported
      ? "Analyze this video"
      : label.title;
    elements.recommendedActionCopy.textContent = supported
      ? "Run the transcript-first YouTube check from the toolbar, then use the workspace for a deeper review when you need it."
      : label.copy;
    elements.recommendedActionButton.textContent = supported ? "Analyze Video" : label.button;
    elements.recommendedActionButton.disabled = state.busy || !request;
    elements.openWorkspaceButton.disabled = state.busy || !state.pageContext?.supported;
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
    elements.acquisitionQualityBadge.textContent = viewModel.acquisitionQuality;
    elements.acquisitionQualityBadge.className =
      `badge state-badge ${viewModel.acquisitionClass}`;
    elements.inputQualityBadge.textContent = viewModel.inputLabel;
    elements.inputQualityBadge.className = `badge input-badge ${viewModel.inputClass}`;
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

    elements.transcriptSourceValue.textContent = viewModel.sourceLabel;
    elements.transcriptSourceMeta.textContent = viewModel.sourceMeta;
    elements.transcriptConfidenceValue.textContent = viewModel.sourceConfidence;
    elements.transcriptConfidenceMeta.textContent = viewModel.sourceConfidenceMeta;
    elements.detectorConfidenceValue.textContent = viewModel.detectorConfidence;
    elements.detectorConfidenceMeta.textContent = viewModel.detectorConfidenceMeta;
    elements.privacyDisclosure.textContent = viewModel.privacyDisclosure;
    elements.privacyDisclosure.classList.toggle("hidden", !viewModel.privacyDisclosure);
    elements.inputQualitySummary.textContent = viewModel.inputSummary;
    elements.trustMeans.textContent = viewModel.interpretationMeans;
    elements.trustNotMeans.textContent = viewModel.interpretationNotMeans;

    renderList(elements.falsePositiveList, viewModel.falsePositives);
    renderList(elements.trustMoreList, viewModel.trustMore);
    renderReasons(viewModel.topReasons);
    renderCategories(viewModel.categoryScores);
    renderFlags(viewModel.flaggedSentences);
    renderDebug(viewModel);
  }

  function renderReasons(reasons) {
    if (!reasons.length) {
      elements.topReasonsList.innerHTML =
        '<li class="flag-item">No strong category-level signals were triggered.</li>';
      return;
    }

    elements.topReasonsList.innerHTML = reasons
      .map((reason) => `<li class="flag-item">${Surface.escapeHtml(reason)}</li>`)
      .join("");
  }

  function renderCategories(categoryScores) {
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

  function renderFlags(flags) {
    elements.flaggedCount.textContent = `${flags.length} flagged`;
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
      type: "popup:analyze",
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
      renderAll();
      showStatus(response.error || "Analysis failed.", "error");
      return;
    }

    state.currentReport = response.report || null;
    hydrateState(response);
    syncVideoSelection(true);
    renderAll();
    logger.info("analyzeRequest:success", {
      score: response.report?.score || 0,
      verdict: response.report?.verdict || ""
    });
    showStatus("Analysis complete.", "success");
  }

  async function openWorkspace() {
    showStatus("Opening workspace...", "info");
    const response = await sendMessage({
      type: "panel:open",
      ...getTargetContextPayload(),
      request: getRecommendedRequest()
    });

    if (!response.ok) {
      showStatus(response.error || "Could not open the workspace.", "error");
      return;
    }

    clearStatus();
  }

  async function saveSettings() {
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

    hydrateState(response);
    renderAll();
    showStatus("Settings saved locally.", "success");
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
    const next = new Set(state.videoSelection.includeSources);
    if (next.has(source) && next.size === 1) {
      return;
    }

    if (next.has(source)) {
      next.delete(source);
    } else {
      next.add(source);
    }

    state.videoSelection.includeSources = Array.from(next);
    renderSourceControls();
    renderRecommendation();
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

  function renderList(element, items) {
    if (!items.length) {
      element.innerHTML = "<li>No additional notes.</li>";
      return;
    }

    element.innerHTML = items.map((item) => `<li>${Surface.escapeHtml(item)}</li>`).join("");
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
        message: error?.message || String(error),
        stack: error?.stack || ""
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
})();

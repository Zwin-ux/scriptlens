(function () {
  if (globalThis.__scriptLensYouTubeOverlayLoaded) {
    return;
  }

  globalThis.__scriptLensYouTubeOverlayLoaded = true;

  const Surface = globalThis.ScriptLensSurface || {};
  const InlineState = globalThis.ScriptLensInlineState || {};
  const Debug = globalThis.ScriptLensDebug || {};
  const logger = Debug.createLogger
    ? Debug.createLogger("youtube-overlay")
    : console;
  if (Debug.installGlobalErrorHandlers) {
    Debug.installGlobalErrorHandlers("youtube-overlay");
  }
  const ROOT_ID = "scriptlens-youtube-cta-root";
  const INLINE_INIT_TIMEOUT_MS = 8000;
  const INLINE_ANALYZE_TIMEOUT_MS = 35000;
  const DEFAULT_SELECTION = InlineState.DEFAULT_SELECTION || {
    includeSources: ["transcript"],
    trackBaseUrl: "",
    allowFallbackText: false
  };
  const state = {
    loading: false,
    detailsOpen: false,
    collapsed: false,
    error: "",
    context: null,
    inlineSettings: null,
    report: null,
    currentVideoId: "",
    videoSelection: { ...DEFAULT_SELECTION },
    initToken: 0,
    analysisToken: 0
  };
  let renderTimer = 0;

  init();

  function init() {
    logger.info("init", {
      href: location.href,
      videoId: getCurrentVideoId()
    });
    scheduleContextRefresh(true);
    window.addEventListener("yt-navigate-finish", () => {
      logger.info("yt-navigate-finish", {
        href: location.href,
        videoId: getCurrentVideoId()
      });
      scheduleContextRefresh(true);
    });
    window.addEventListener("yt-page-data-updated", () => {
      logger.info("yt-page-data-updated", {
        href: location.href,
        videoId: getCurrentVideoId()
      });
      scheduleContextRefresh(true);
    });

    const observer = new MutationObserver(() => {
      if (!isWatchPage()) {
        logger.info("observer removed root because page is unsupported", {
          href: location.href
        });
        resetState();
        removeRoot();
        return;
      }

      if (getCurrentVideoId() !== state.currentVideoId) {
        logger.info("observer detected video id change", {
          previousVideoId: state.currentVideoId,
          nextVideoId: getCurrentVideoId()
        });
        scheduleContextRefresh(true);
        return;
      }

      scheduleRender();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function scheduleContextRefresh(force) {
    clearTimeout(renderTimer);
    logger.info("scheduleContextRefresh", {
      force: Boolean(force),
      currentVideoId: getCurrentVideoId(),
      stateVideoId: state.currentVideoId
    });
    renderTimer = window.setTimeout(() => {
      refreshContext(force).catch((error) => {
        state.loading = false;
        if (!state.report) {
          logger.error("refreshContext crashed", {
            error: summarizeError(error),
            href: location.href,
            videoId: getCurrentVideoId()
          });
          state.error = buildInlineRuntimeError(error, "init");
          render();
        }
      });
    }, 180);
  }

  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = window.setTimeout(render, 120);
  }

  async function refreshContext(force) {
    if (!isWatchPage()) {
      logger.info("refreshContext skipped on unsupported page", {
        href: location.href
      });
      resetState();
      removeRoot();
      return;
    }

    const currentVideoId = getCurrentVideoId();
    const sameVideo = Boolean(currentVideoId && currentVideoId === state.currentVideoId);
    logger.info("refreshContext start", {
      force: Boolean(force),
      currentVideoId,
      stateVideoId: state.currentVideoId,
      sameVideo,
      hasReport: Boolean(state.report)
    });

    if (!force && state.context && sameVideo) {
      logger.info("refreshContext reused existing context", {
        currentVideoId
      });
      render();
      return;
    }

    if (!sameVideo) {
      logger.info("refreshContext resetting for new video", {
        previousVideoId: state.currentVideoId,
        nextVideoId: currentVideoId
      });
      resetState();
      state.currentVideoId = currentVideoId;
      render();
    }

    const token = ++state.initToken;
    const response = await sendRuntimeMessageWithTimeout(
      { type: "inline:init" },
      INLINE_INIT_TIMEOUT_MS
    );

    if (token !== state.initToken || getCurrentVideoId() !== currentVideoId) {
      logger.warn("refreshContext dropped stale inline:init response", {
        currentVideoId,
        stateVideoId: state.currentVideoId,
        token,
        stateToken: state.initToken
      });
      return;
    }

    if (!response?.ok) {
      logger.warn("refreshContext received failure", {
        currentVideoId,
        error: response?.error || ""
      });
      if (!sameVideo || !state.report) {
        state.error = response?.error || "ScriptLens could not load this video.";
        state.loading = false;
        render();
      }
      return;
    }

    state.context = response.pageContext || null;
    state.inlineSettings = response.inlineSettings || null;
    syncVideoSelection(sameVideo);
    logger.info("refreshContext hydrated", {
      currentVideoId,
      context: summarizeContext(state.context),
      inlineSettings: state.inlineSettings || {}
    });

    if (!state.context?.supported && (!sameVideo || !state.report)) {
      state.error =
        state.context?.error || "Open a desktop YouTube watch page to use ScriptLens.";
    } else if (!state.report) {
      state.error = "";
    }

    render();
  }

  function resetState() {
    logger.info("resetState", {
      previousVideoId: state.currentVideoId,
      hadReport: Boolean(state.report),
      hadError: Boolean(state.error)
    });
    state.loading = false;
    state.detailsOpen = false;
    state.collapsed = false;
    state.error = "";
    state.context = null;
    state.inlineSettings = null;
    state.report = null;
    state.videoSelection = { ...DEFAULT_SELECTION };
    state.currentVideoId = "";
    state.analysisToken += 1;
  }

  function render() {
    if (!isWatchPage()) {
      removeRoot();
      return;
    }

    const mountTarget = findMountTarget();
    if (!mountTarget) {
      return;
    }

    const root = ensureRoot(mountTarget);
    if (!root.shadowRoot) {
      root.attachShadow({ mode: "open" });
    }
    if (!root.__scriptLensBound) {
      root.shadowRoot.addEventListener("click", handleShadowClick);
      root.shadowRoot.addEventListener("change", handleShadowChange);
      root.__scriptLensBound = true;
    }

    root.shadowRoot.innerHTML = `
      <style>${buildStyles()}</style>
      ${buildMarkup()}
    `;
  }

  function buildMarkup() {
    if (state.loading) {
      return buildLoadingMarkup();
    }
    if (state.collapsed) {
      return buildCollapsedMarkup();
    }
    if (state.report) {
      return buildResultMarkup();
    }
    if (state.error) {
      return buildErrorMarkup(state.error);
    }
    if (state.context && !state.context.supported) {
      return buildErrorMarkup(
        state.context.error || "Open a desktop YouTube watch page to use ScriptLens.",
      );
    }
    return buildIdlePillMarkup();
  }

  function buildIdlePillMarkup() {
    return `
      <div class="sl-shell">
        <button class="sl-pill sl-pill-idle" type="button" data-action="run-analysis">
          <span class="sl-pill-dot"></span>
          <span>Analyze video</span>
        </button>
      </div>
    `;
  }

  function buildCollapsedMarkup() {
    const inline = Surface.buildInlineReportViewModel
      ? Surface.buildInlineReportViewModel(state.report)
      : null;
    const tone = inline?.scoreClass || "mid";
    const label = inline ? `${inline.verdict} ${inline.rawScoreText}` : "Analyze video";
    return `
      <div class="sl-shell">
        <button class="sl-pill sl-pill-${tone}" type="button" data-action="expand-card">
          <span class="sl-pill-dot"></span>
          <span>${escapeHtml(label)}</span>
        </button>
      </div>
    `;
  }

  function buildErrorMarkup(message) {
    const disabled = Boolean(state.context && !state.context.supported);
    return `
      <div class="sl-shell">
        <section class="sl-card sl-card-error">
          <div class="sl-topline">
            <span class="sl-kicker">ScriptLens</span>
            <span class="sl-chip">Need attention</span>
          </div>
          <h2 class="sl-title">We couldn't finish the transcript check</h2>
          <p class="sl-copy">${escapeHtml(message)}</p>
          <p class="sl-summary">
            Try again on this video, or open the full workspace if you want a deeper recovery path.
          </p>
          <div class="sl-actions">
            <button class="sl-primary" type="button" data-action="run-analysis"${disabled ? " disabled" : ""}>
              Try again
            </button>
            <button class="sl-secondary" type="button" data-action="open-workspace">
              Open full workspace
            </button>
          </div>
        </section>
      </div>
    `;
  }

  function buildLoadingMarkup() {
    return `
      <div class="sl-shell">
        <section class="sl-card">
          <div class="sl-topline">
            <span class="sl-kicker">ScriptLens</span>
            <span class="sl-chip">Working</span>
          </div>
          <h2 class="sl-title">Analyzing transcript...</h2>
          <p class="sl-copy">
            ScriptLens is checking transcript sources for this video while keeping the watch page compact.
          </p>
          <div class="sl-loading-bar" aria-hidden="true"><span></span></div>
        </section>
      </div>
    `;
  }

  function buildResultMarkup() {
    const viewModel = Surface.buildInlineReportViewModel
      ? Surface.buildInlineReportViewModel(state.report)
      : null;
    if (!viewModel) {
      return buildErrorMarkup("ScriptLens finished, but could not build the inline result.");
    }

    const details = state.detailsOpen
      ? `
        <div class="sl-details">
          <div class="sl-detail-grid">
            <article class="sl-detail-card">
              <span class="sl-label">Transcript source</span>
              <strong>${escapeHtml(viewModel.sourceLabel)}</strong>
              <span>${escapeHtml(viewModel.transcriptMeta || viewModel.advancedSourceMeta)}</span>
            </article>
            <article class="sl-detail-card">
              <span class="sl-label">Result confidence</span>
              <strong>${escapeHtml(viewModel.detectorConfidence)}</strong>
              <span>ScriptLens caps confidence by transcript quality and sample size.</span>
            </article>
            <article class="sl-detail-card">
              <span class="sl-label">Recovery path</span>
              <strong>${escapeHtml(viewModel.advancedSourceMeta || "On-page retrieval")}</strong>
              <span>${escapeHtml(viewModel.winnerReason || viewModel.qualityGateNote || "Single candidate")}</span>
            </article>
          </div>
          ${viewModel.privacyDisclosure
            ? `<p class="sl-privacy">${escapeHtml(viewModel.privacyDisclosure)}</p>`
            : ""}
          ${viewModel.qualityGateNote
            ? `<p class="sl-help">${escapeHtml(viewModel.qualityGateNote)}</p>`
            : ""}
          <div class="sl-settings">
            <div>
              <span class="sl-label">Transcript options</span>
              <div class="sl-chip-row">${buildSourceChips()}</div>
            </div>
            ${buildTrackField()}
            <label class="sl-toggle">
              <input type="checkbox" data-field="allowFallbackText"${state.videoSelection.allowFallbackText ? " checked" : ""}>
              <span>Allow title and description fallback if the transcript is unavailable</span>
            </label>
            <p class="sl-help">Use Re-analyze to apply any transcript changes.</p>
          </div>
          ${viewModel.reasonPreview.length
            ? `
              <div class="sl-reasons">
                <span class="sl-label">Why this score</span>
                <ul>
                  ${viewModel.reasonPreview
                    .map((reason) => `<li>${escapeHtml(reason)}</li>`)
                    .join("")}
                </ul>
              </div>
            `
            : ""}
        </div>
      `
      : "";

    return `
      <div class="sl-shell">
        <section class="sl-card sl-card-${viewModel.scoreClass}">
          <div class="sl-topline">
            <span class="sl-kicker">ScriptLens</span>
            <div class="sl-top-actions">
              <span class="sl-chip">${escapeHtml(viewModel.qualityLabel)}</span>
              <button class="sl-icon" type="button" aria-label="Collapse ScriptLens result" data-action="collapse-card">
                &#8722;
              </button>
            </div>
          </div>
          <div class="sl-result-head">
            <div>
              <h2 class="sl-title">${escapeHtml(viewModel.verdict)}</h2>
              <p class="sl-copy">${escapeHtml(viewModel.explanation)}</p>
            </div>
            <div class="sl-score">
              <strong>${escapeHtml(viewModel.rawScoreText)}</strong>
              <span>AI-like pattern score</span>
            </div>
          </div>
          <div class="sl-summary-row">
            <span class="sl-badge">${escapeHtml(viewModel.sourceLabel)}</span>
            <span class="sl-badge">${escapeHtml(viewModel.secondaryBadgeLabel)}</span>
          </div>
          <p class="sl-summary">${escapeHtml(viewModel.detailSummary)}</p>
          <div class="sl-actions">
            <button class="sl-primary" type="button" data-action="run-analysis">Re-analyze</button>
            <button class="sl-secondary" type="button" data-action="toggle-details">
              ${state.detailsOpen ? "Hide details" : "Details"}
            </button>
            <button class="sl-secondary" type="button" data-action="open-workspace">
              Open full workspace
            </button>
          </div>
          ${details}
        </section>
      </div>
    `;
  }

  function buildSourceChips() {
    const availableSources = state.context?.video?.availableSources || {};
    const labels = {
      transcript: "Transcript",
      description: "Description",
      title: "Title"
    };

    return ["transcript", "description", "title"]
      .map((source) => {
        const active = state.videoSelection.includeSources.includes(source) ? " active" : "";
        const disabled = availableSources[source] ? "" : " disabled";
        return `
          <button class="sl-chip-toggle${active}" type="button" data-action="toggle-source" data-source="${source}"${disabled}>
            ${labels[source]}
          </button>
        `;
      })
      .join("");
  }

  function buildTrackField() {
    const tracks = (state.context?.video?.transcriptTracks || []).filter(
      (track) =>
        track.kind !== "visible" &&
        track.kind !== "description-transcript" &&
        track.baseUrl !== "visible-dom-transcript" &&
        track.baseUrl !== "description-transcript"
    );

    if (!state.videoSelection.includeSources.includes("transcript") || !tracks.length) {
      return "";
    }

    const options = tracks
      .map((track) => {
        const selected = track.baseUrl === state.videoSelection.trackBaseUrl ? " selected" : "";
        return `<option value="${escapeHtml(track.baseUrl)}"${selected}>${escapeHtml(track.label)}</option>`;
      })
      .join("");

    return `
      <label class="sl-field">
        <span class="sl-label">Caption track</span>
        <select data-field="trackBaseUrl">${options}</select>
      </label>
    `;
  }

  async function handleShadowClick(event) {
    const button = event.target.closest("[data-action]");
    if (!button) {
      return;
    }

    const action = button.getAttribute("data-action");
    if (action === "run-analysis") {
      await runAnalysis();
      return;
    }
    if (action === "toggle-details") {
      state.detailsOpen = !state.detailsOpen;
      render();
      return;
    }
    if (action === "collapse-card") {
      state.collapsed = true;
      render();
      return;
    }
    if (action === "expand-card") {
      state.collapsed = false;
      render();
      return;
    }
    if (action === "open-workspace") {
      await openWorkspace();
      return;
    }
    if (action === "toggle-source") {
      toggleSource(button.getAttribute("data-source") || "");
      return;
    }
  }

  function handleShadowChange(event) {
    const field = event.target.getAttribute("data-field");
    if (!field) {
      return;
    }

    if (field === "trackBaseUrl") {
      state.videoSelection.trackBaseUrl = event.target.value || "";
      return;
    }
    if (field === "allowFallbackText") {
      state.videoSelection.allowFallbackText = Boolean(event.target.checked);
    }
  }

  async function runAnalysis() {
    if (state.loading) {
      logger.info("runAnalysis ignored while already loading", {
        videoId: state.currentVideoId
      });
      return;
    }

    const requestedVideoId = state.currentVideoId || getCurrentVideoId();
    const analysisToken = ++state.analysisToken;
    logger.info("runAnalysis start", {
      href: location.href,
      videoId: requestedVideoId,
      request: getCurrentVideoRequest()
    });
    state.loading = true;
    state.error = "";
    state.collapsed = false;
    render();

    try {
      const response = await sendRuntimeMessageWithTimeout(
        {
          type: "inline:analyze",
          request: getCurrentVideoRequest()
        },
        INLINE_ANALYZE_TIMEOUT_MS
      );

      if (analysisToken !== state.analysisToken || getCurrentVideoId() !== requestedVideoId) {
        logger.warn("runAnalysis dropped stale response", {
          requestedVideoId,
          currentVideoId: getCurrentVideoId(),
          analysisToken,
          activeAnalysisToken: state.analysisToken
        });
        return;
      }

      if (!response?.ok) {
        logger.warn("runAnalysis failed", {
          videoId: requestedVideoId,
          error: response?.error || "",
          acquisition: response?.acquisition || null
        });
        await dumpBackgroundHistory("inline-analyze-failed");
        state.error =
          response?.error ||
          "ScriptLens could not finish the transcript check for this video.";
        state.report = null;
        state.loading = false;
        render();
        return;
      }

      state.loading = false;
      state.report = response.report || null;
      state.context = response.pageContext || state.context;
      state.inlineSettings = response.inlineSettings || state.inlineSettings;
      syncVideoSelection(true);
      logger.info("runAnalysis success", {
        videoId: requestedVideoId,
        score: response.report?.score || 0,
        verdict: response.report?.verdict || "",
        acquisition: response.report?.acquisition || null
      });
      render();
    } catch (error) {
      if (analysisToken !== state.analysisToken || getCurrentVideoId() !== requestedVideoId) {
        logger.warn("runAnalysis dropped stale error", {
          requestedVideoId,
          currentVideoId: getCurrentVideoId(),
          analysisToken,
          activeAnalysisToken: state.analysisToken,
          error: summarizeError(error)
        });
        return;
      }
      state.loading = false;
      state.report = null;
      logger.error("runAnalysis crashed", {
        videoId: requestedVideoId,
        error: summarizeError(error)
      });
      await dumpBackgroundHistory("inline-analyze-crashed");
      state.error = buildInlineRuntimeError(error, "analyze");
      render();
    }
  }

  async function openWorkspace() {
    try {
      logger.info("openWorkspace", {
        videoId: state.currentVideoId,
        request: getCurrentVideoRequest()
      });
      const response = await sendRuntimeMessageWithTimeout(
        {
          type: "panel:open",
          request: getCurrentVideoRequest()
        },
        10000
      );
      if (!response?.ok) {
        logger.warn("openWorkspace rejected", {
          videoId: state.currentVideoId,
          error: response?.error || ""
        });
        await dumpBackgroundHistory("open-workspace-failed");
      }
    } catch (error) {
      logger.error("openWorkspace failed", {
        videoId: state.currentVideoId,
        error: summarizeError(error)
      });
      if (!/Extension context invalidated/i.test(String(error?.message || ""))) {
        console.warn("ScriptLens could not open the workspace.", error);
      }
    }
  }

  function toggleSource(source) {
    if (!source) {
      return;
    }

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
    logger.info("toggleSource", {
      source,
      includeSources: state.videoSelection.includeSources.slice()
    });
    render();
  }

  function syncVideoSelection(preserveCurrentSelection) {
    if (InlineState.syncVideoSelection) {
      state.videoSelection = InlineState.syncVideoSelection({
        context: state.context,
        currentSelection: state.videoSelection,
        defaultSelection: DEFAULT_SELECTION,
        preserveCurrentSelection
      });
      return;
    }

    const video = state.context?.video;
    if (!video) {
      state.videoSelection = { ...DEFAULT_SELECTION };
      return;
    }

    const defaultPreset = video.defaultPreset || DEFAULT_SELECTION;
    let includeSources = preserveCurrentSelection
      ? state.videoSelection.includeSources.filter((source) => video.availableSources?.[source])
      : [];
    if (!includeSources.length) {
      includeSources = (defaultPreset.includeSources || []).slice();
    }

    const trackOptions = (video.transcriptTracks || []).filter(
      (track) =>
        track.kind !== "visible" &&
        track.kind !== "description-transcript" &&
        track.baseUrl !== "visible-dom-transcript" &&
        track.baseUrl !== "description-transcript"
    );
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

  function ensureRoot(mountTarget) {
    let root = document.getElementById(ROOT_ID);
    if (root && root.parentElement !== mountTarget) {
      root.remove();
      root = null;
    }

    if (!root) {
      root = document.createElement("div");
      root.id = ROOT_ID;
      mountTarget.appendChild(root);
    }

    return root;
  }

  function removeRoot() {
    document.getElementById(ROOT_ID)?.remove();
  }

  function findMountTarget() {
    const selectors = [
      "#above-the-fold #top-row",
      "#above-the-fold #owner",
      "ytd-watch-metadata #actions",
      "#title h1"
    ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) {
        return element;
      }
    }

    return null;
  }

  function getCurrentVideoId() {
    return new URLSearchParams(location.search).get("v") || "";
  }

  function isWatchPage() {
    const host = String(location.hostname || "").replace(/^www\./, "");
    return host === "youtube.com" && location.pathname === "/watch" && Boolean(getCurrentVideoId());
  }

  function escapeHtml(value) {
    return Surface.escapeHtml ? Surface.escapeHtml(value) : String(value || "");
  }

  function summarizeContext(context) {
    if (InlineState.summarizeContext) {
      return InlineState.summarizeContext(context);
    }
    if (!context) {
      return null;
    }
    return {
      supported: Boolean(context.supported),
      isYouTubeVideo: Boolean(context.isYouTubeVideo),
      transcriptAvailable: Boolean(context.transcriptAvailable),
      video: context.video
        ? {
            title: context.video.title || "",
            videoId: context.video.videoId || "",
            availableSources: context.video.availableSources || {},
            transcriptTrackCount: Array.isArray(context.video.transcriptTracks)
              ? context.video.transcriptTracks.length
              : 0
          }
        : null
    };
  }

  function summarizeError(error) {
    if (InlineState.summarizeError) {
      return InlineState.summarizeError(error);
    }
    if (!error) {
      return null;
    }

    return {
      message: error.message || String(error),
      stack: error.stack || ""
    };
  }

  function buildInlineRuntimeError(error, phase) {
    if (InlineState.buildInlineRuntimeError) {
      return InlineState.buildInlineRuntimeError(error, phase);
    }
    const message = String(error?.message || "");
    if (/timed out/i.test(message)) {
      return phase === "init"
        ? "ScriptLens took too long to load this video. Refresh the page and try again."
        : "ScriptLens took too long to finish the transcript check. Try again on this video.";
    }
    return message || "ScriptLens could not finish the transcript check for this video.";
  }

  function sendRuntimeMessageWithTimeout(message, timeoutMs) {
    return promiseWithTimeout(
      Promise.resolve(chrome.runtime.sendMessage(message)),
      timeoutMs,
      `ScriptLens request timed out after ${timeoutMs}ms.`
    );
  }

  function promiseWithTimeout(promise, timeoutMs, timeoutMessage) {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        reject(new Error(timeoutMessage));
      }, Math.max(1, Number(timeoutMs) || 1));

      Promise.resolve(promise)
        .then((value) => {
          window.clearTimeout(timer);
          resolve(value);
        })
        .catch((error) => {
          window.clearTimeout(timer);
          reject(error);
        });
    });
  }

  async function dumpBackgroundHistory(reason) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "debug:getHistory"
      });
      logger.warn("background history snapshot", {
        reason,
        history: Array.isArray(response?.history) ? response.history : []
      });
    } catch (error) {
      logger.error("failed to fetch background history", {
        reason,
        error: summarizeError(error)
      });
    }
  }

  function buildStyles() {
    return `
      :host {
        all: initial;
      }
      .sl-shell {
        margin-top: 12px;
        font-family: Roboto, "YouTube Sans", "Segoe UI", sans-serif;
      }
      .sl-card,
      .sl-pill {
        box-sizing: border-box;
      }
      .sl-card {
        width: min(360px, 100%);
        padding: 14px;
        border-radius: 18px;
        border: 1px solid rgba(0, 0, 0, 0.08);
        background:
          linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(250, 247, 242, 0.96));
        color: #1d1d1f;
        box-shadow: 0 14px 34px rgba(15, 23, 42, 0.14);
      }
      .sl-card-mid {
        background:
          linear-gradient(180deg, rgba(255, 250, 240, 0.98), rgba(252, 245, 233, 0.98));
      }
      .sl-card-high {
        background:
          linear-gradient(180deg, rgba(255, 245, 245, 0.98), rgba(253, 236, 236, 0.98));
      }
      .sl-card-error {
        background:
          linear-gradient(180deg, rgba(255, 248, 243, 0.98), rgba(253, 241, 235, 0.98));
      }
      .sl-card-low {
        background:
          linear-gradient(180deg, rgba(244, 250, 245, 0.98), rgba(236, 247, 239, 0.98));
      }
      .sl-topline,
      .sl-top-actions,
      .sl-result-head,
      .sl-summary-row,
      .sl-actions,
      .sl-chip-row {
        display: flex;
        align-items: center;
      }
      .sl-topline,
      .sl-result-head {
        justify-content: space-between;
        gap: 12px;
      }
      .sl-top-actions,
      .sl-summary-row,
      .sl-actions,
      .sl-chip-row {
        flex-wrap: wrap;
        gap: 8px;
      }
      .sl-kicker,
      .sl-label,
      .sl-score span,
      .sl-detail-card span,
      .sl-help,
      .sl-privacy,
      .sl-reasons li {
        font-size: 12px;
        line-height: 1.4;
      }
      .sl-kicker,
      .sl-label {
        font-weight: 700;
        letter-spacing: 0.02em;
        text-transform: uppercase;
        color: #6d5841;
      }
      .sl-title {
        margin: 10px 0 0;
        font-size: 18px;
        line-height: 1.15;
        color: #1a1a1a;
      }
      .sl-copy,
      .sl-summary {
        margin: 10px 0 0;
        font-size: 13px;
        line-height: 1.5;
        color: #3c3c3c;
      }
      .sl-summary {
        color: #4d463f;
      }
      .sl-chip,
      .sl-badge,
      .sl-chip-toggle,
      .sl-pill {
        border-radius: 999px;
      }
      .sl-chip,
      .sl-badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        border: 1px solid rgba(96, 74, 47, 0.15);
        background: rgba(255, 255, 255, 0.82);
        color: #66492c;
        font-size: 12px;
        font-weight: 700;
      }
      .sl-score {
        min-width: 86px;
        padding: 10px 12px;
        border-radius: 16px;
        background: rgba(255, 255, 255, 0.72);
        border: 1px solid rgba(0, 0, 0, 0.06);
        text-align: right;
      }
      .sl-score strong {
        display: block;
        font-size: 20px;
        line-height: 1;
        color: #201912;
      }
      .sl-actions {
        margin-top: 14px;
      }
      .sl-primary,
      .sl-secondary,
      .sl-chip-toggle,
      .sl-icon,
      .sl-pill {
        border: 0;
        cursor: pointer;
        font: inherit;
      }
      .sl-primary,
      .sl-secondary {
        min-height: 36px;
        padding: 0 14px;
        border-radius: 12px;
        font-size: 13px;
        font-weight: 700;
      }
      .sl-primary {
        background: #111111;
        color: #ffffff;
      }
      .sl-primary:hover {
        background: #292929;
      }
      .sl-primary:disabled {
        cursor: not-allowed;
        opacity: 0.55;
      }
      .sl-secondary,
      .sl-chip-toggle {
        background: rgba(255, 255, 255, 0.78);
        color: #352a1f;
        border: 1px solid rgba(53, 42, 31, 0.12);
      }
      .sl-secondary:hover,
      .sl-chip-toggle:hover {
        background: #ffffff;
      }
      .sl-chip-toggle {
        min-height: 34px;
        padding: 0 12px;
        font-size: 12px;
        font-weight: 700;
      }
      .sl-chip-toggle.active {
        background: #1f6feb;
        border-color: #1f6feb;
        color: #ffffff;
      }
      .sl-chip-toggle:disabled {
        cursor: not-allowed;
        opacity: 0.45;
      }
      .sl-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 30px;
        height: 30px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.76);
        color: #45372a;
        border: 1px solid rgba(69, 55, 42, 0.12);
      }
      .sl-details {
        margin-top: 14px;
        padding-top: 14px;
        border-top: 1px solid rgba(69, 55, 42, 0.12);
      }
      .sl-detail-grid {
        display: grid;
        gap: 10px;
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .sl-detail-card {
        padding: 12px;
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.66);
        border: 1px solid rgba(69, 55, 42, 0.1);
        display: grid;
        gap: 4px;
      }
      .sl-detail-card strong {
        font-size: 14px;
        line-height: 1.3;
        color: #1f1b17;
      }
      .sl-settings {
        display: grid;
        gap: 12px;
        margin-top: 12px;
      }
      .sl-field {
        display: grid;
        gap: 6px;
      }
      .sl-field select {
        min-height: 36px;
        border-radius: 12px;
        border: 1px solid rgba(69, 55, 42, 0.14);
        background: rgba(255, 255, 255, 0.84);
        padding: 0 10px;
        font: inherit;
        color: #1f1b17;
      }
      .sl-toggle {
        display: grid;
        grid-template-columns: 18px 1fr;
        gap: 10px;
        align-items: start;
        font-size: 13px;
        line-height: 1.5;
        color: #342a22;
      }
      .sl-help,
      .sl-privacy {
        margin: 0;
        color: #6b5a4d;
      }
      .sl-reasons {
        margin-top: 12px;
      }
      .sl-reasons ul {
        margin: 8px 0 0;
        padding-left: 18px;
        color: #392f26;
      }
      .sl-loading-bar {
        margin-top: 14px;
        width: 100%;
        height: 7px;
        border-radius: 999px;
        overflow: hidden;
        background: rgba(17, 17, 17, 0.08);
      }
      .sl-loading-bar span {
        display: block;
        width: 42%;
        height: 100%;
        border-radius: inherit;
        background: linear-gradient(90deg, #ff6a3d, #f5b940);
        animation: scriptlens-load 1.05s ease-in-out infinite;
      }
      .sl-pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-height: 40px;
        padding: 0 14px;
        background: rgba(255, 255, 255, 0.94);
        color: #1b1b1b;
        box-shadow: 0 10px 24px rgba(15, 23, 42, 0.14);
        font-size: 13px;
        font-weight: 800;
      }
      .sl-pill-low {
        border: 1px solid rgba(46, 125, 50, 0.22);
      }
      .sl-pill-mid {
        border: 1px solid rgba(180, 112, 30, 0.22);
      }
      .sl-pill-high {
        border: 1px solid rgba(185, 73, 73, 0.22);
      }
      .sl-pill-idle {
        border: 1px solid rgba(35, 50, 74, 0.14);
      }
      .sl-pill-dot {
        width: 9px;
        height: 9px;
        border-radius: 999px;
        background: #ff6a3d;
      }
      @keyframes scriptlens-load {
        0% { transform: translateX(-120%); }
        50% { transform: translateX(90%); }
        100% { transform: translateX(220%); }
      }
      @media (prefers-color-scheme: dark) {
        .sl-card {
          background:
            linear-gradient(180deg, rgba(24, 24, 24, 0.96), rgba(30, 26, 23, 0.96));
          border-color: rgba(255, 255, 255, 0.08);
          color: #f2ede6;
          box-shadow: 0 18px 36px rgba(0, 0, 0, 0.34);
        }
        .sl-card-mid {
          background:
            linear-gradient(180deg, rgba(38, 31, 21, 0.96), rgba(32, 26, 20, 0.96));
        }
        .sl-card-high {
          background:
            linear-gradient(180deg, rgba(43, 25, 26, 0.96), rgba(32, 22, 22, 0.96));
        }
        .sl-card-error {
          background:
            linear-gradient(180deg, rgba(42, 28, 22, 0.96), rgba(34, 24, 20, 0.96));
        }
        .sl-card-low {
          background:
            linear-gradient(180deg, rgba(22, 34, 26, 0.96), rgba(20, 28, 23, 0.96));
        }
        .sl-title,
        .sl-score strong,
        .sl-detail-card strong {
          color: #fff8f0;
        }
        .sl-copy,
        .sl-summary,
        .sl-toggle,
        .sl-reasons ul {
          color: #e3d9ce;
        }
        .sl-kicker,
        .sl-label,
        .sl-help,
        .sl-privacy,
        .sl-score span,
        .sl-detail-card span {
          color: #bea389;
        }
        .sl-chip,
        .sl-badge,
        .sl-secondary,
        .sl-chip-toggle,
        .sl-icon,
        .sl-score,
        .sl-detail-card,
        .sl-field select,
        .sl-pill {
          background: rgba(255, 255, 255, 0.06);
          border-color: rgba(255, 255, 255, 0.1);
          color: #fff8f0;
        }
        .sl-primary {
          background: #f4ede4;
          color: #171412;
        }
        .sl-primary:hover {
          background: #ffffff;
        }
      }
    `;
  }
})();

(function () {
  if (globalThis.__aiScriptDetectorContentLoaded) {
    return;
  }

  globalThis.__aiScriptDetectorContentLoaded = true;

  const App = globalThis.AIScriptDetector || {};
  const Text = App.text;
  const Dom = App.dom;
  const Debug = globalThis.ScriptLensDebug || {};
  const TestApi = (globalThis.ScriptLensContent = globalThis.ScriptLensContent || {});
  const logger = Debug.createLogger
    ? Debug.createLogger("content")
    : console;
  if (Debug.installGlobalErrorHandlers) {
    Debug.installGlobalErrorHandlers("content");
  }

  const BOOTSTRAP_ATTRIBUTE = "data-scriptlens-youtube-bootstrap";
  const BOOTSTRAP_REQUEST_EVENT = "scriptlens:request-youtube-bootstrap";
  const BOOTSTRAP_READY_EVENT = "scriptlens:youtube-bootstrap-ready";

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    logger.info("page message", {
      type: message?.type || "",
      href: location.href
    });
    handleMessage(message)
      .then((response) => sendResponse(response))
      .catch((error) => {
        logger.error("page message failed", {
          type: message?.type || "",
          error: summarizeError(error)
        });
        sendResponse({
          ok: false,
          error: error?.message || "Page text extraction failed."
        });
      });

    return true;
  });

  async function handleMessage(message) {
    switch (message?.type) {
      case "extract:selection":
        return extractSelectionPayload();
      case "extract:page":
        return extractPagePayload(message || {});
      case "youtube:page-adapter":
        return {
          ok: true,
          adapter: await buildYouTubePageAdapter()
        };
      case "youtube:open-transcript-panel":
        return {
          ok: true,
          adapter: await openYouTubeTranscriptPanel()
        };
      case "youtube:fetch-url":
        return fetchYouTubeUrl(message || {});
      case "page:context":
        return buildPageContextPayload(message || {});
      default:
        return {
          ok: false,
          error: "Unsupported page action."
        };
    }
  }

  function extractSelectionPayload() {
    const text = Text.sanitizeInput(getSelectionText());
    if (!text) {
      return {
        ok: false,
        error: "No live text selection found on the page."
      };
    }

    return {
      ok: true,
      text,
      meta: {
        sourceType: "selection",
        sourceLabel: "Selection",
        title: getDisplayTitle(),
        includedSources: ["selection"]
      }
    };
  }

  function extractPagePayload(options = {}) {
    const payload = extractDocumentPayload(options);
    const text = Text.sanitizeInput(payload.text);
    if (!text) {
      return {
        ok: false,
        error: "No visible page text could be extracted."
      };
    }

    const contentKind = payload.metadata?.contentKind || "page-content";

    return {
      ok: true,
      text,
      meta: {
        sourceType: contentKind,
        sourceLabel: resolvePageSourceLabel(contentKind, payload.metadata?.extractor),
        title: getDisplayTitle(),
        includedSources: [contentKind],
        ...payload.metadata
      }
    };
  }

  async function buildPageContextPayload(options = {}) {
    const pagePayload = extractDocumentPayload(options);
    const adapter = isYouTubeVideoPage() ? await buildYouTubePageAdapter() : null;
    const video = adapter ? buildVideoContextFromAdapter(adapter) : null;
    logger.info("buildPageContextPayload", {
      href: location.href,
      isYouTubeVideoPage: isYouTubeVideoPage(),
      extractedWordCount: pagePayload.metadata?.extractedWordCount || 0,
      video: summarizeVideo(video)
    });

    return {
      ok: true,
      context: {
        supported: true,
        title: getDisplayTitle(),
        hostname: location.hostname,
        selectionAvailable: Boolean(Text.sanitizeInput(getSelectionText())),
        pageAvailable: pagePayload.metadata.extractedWordCount >= 30,
        pageWordCount: pagePayload.metadata.extractedWordCount,
        pageKind: pagePayload.metadata.contentKind || "page-content",
        pageMeta: pagePayload.metadata,
        isYouTubeVideo: Boolean(adapter),
        transcriptAvailable: Boolean(video?.availableSources?.transcript),
        transcriptSourceLabel: video?.defaultTrackLabel || "",
        video
      }
    };
  }

  function extractDocumentPayload(options = {}) {
    if (App.defuddleExtractor?.extractDocumentPayload) {
      return App.defuddleExtractor.extractDocumentPayload(document, {
        enableDefuddleExperiment: Boolean(options.enableDefuddleExperiment),
        url: location.href
      });
    }

    return Dom.extractVisibleDocumentPayload(document);
  }

  function resolvePageSourceLabel(contentKind, extractor) {
    if (extractor === "defuddle") {
      return contentKind === "article-content"
        ? "Extracted article content"
        : "Extracted page content";
    }

    return contentKind === "article-content"
      ? "Article content"
      : "Visible page content";
  }

  async function buildYouTubePageAdapter() {
    if (!isYouTubeVideoPage()) {
      logger.warn("buildYouTubePageAdapter called outside supported page", {
        href: location.href
      });
      return null;
    }

    const bootstrapSnapshot = (await requestBootstrapSnapshot()) || {};
    const description = getYouTubeDescriptionText();
    const domTranscriptSegments = getVisibleTranscriptSegments();
    const descriptionTranscriptText = getDescriptionTranscriptText(description);
    const videoDurationSeconds =
      bootstrapSnapshot.videoDurationSeconds || getVideoDurationSecondsFromDom();

    logger.info("buildYouTubePageAdapter", {
      href: location.href,
      title: getDisplayTitle(),
      bootstrap: summarizeBootstrap(bootstrapSnapshot),
      descriptionLength: description.length,
      descriptionTranscriptLength: descriptionTranscriptText.length,
      domTranscriptSegments: domTranscriptSegments.length,
      videoDurationSeconds
    });

    return {
      title: getDisplayTitle(),
      description,
      descriptionTranscriptText,
      domTranscriptSegments,
      domTranscriptLanguageCode: bootstrapSnapshot.hl || null,
      requestShapeValidation: buildRequestShapeValidation(bootstrapSnapshot),
      bootstrapSnapshot,
      videoDurationSeconds,
      url: location.href,
      videoId: bootstrapSnapshot.videoId || new URLSearchParams(location.search).get("v") || ""
    };
  }

  function buildVideoContextFromAdapter(adapter) {
    const tracks = Array.isArray(adapter.bootstrapSnapshot?.captionTracks)
      ? adapter.bootstrapSnapshot.captionTracks
      : [];
    const transcriptTracks = tracks.map((track) => ({
      id: track.baseUrl,
      label: getCaptionTrackLabel(track),
      languageCode: track.languageCode || "",
      kind: track.kind || "manual",
      baseUrl: track.baseUrl
    }));

    if (adapter.domTranscriptSegments.length) {
      transcriptTracks.push({
        id: "visible-dom-transcript",
        label: "Visible transcript",
        languageCode: adapter.domTranscriptLanguageCode || "",
        kind: "visible",
        baseUrl: "visible-dom-transcript"
      });
    }

    if (adapter.descriptionTranscriptText) {
      transcriptTracks.push({
        id: "description-transcript",
        label: "Description transcript",
        languageCode: adapter.bootstrapSnapshot?.hl || "",
        kind: "description-transcript",
        baseUrl: "description-transcript"
      });
    }

    const defaultCaptionTrack = pickDefaultCaptionTrack(
      transcriptTracks,
      adapter.bootstrapSnapshot?.hl || ""
    );

    return {
      title: adapter.title,
      description: adapter.description,
      descriptionAvailable: Boolean(adapter.description),
      descriptionLength: adapter.description.length,
      transcriptAvailable:
        Boolean(adapter.bootstrapSnapshot?.transcriptParams) ||
        tracks.length > 0 ||
        adapter.domTranscriptSegments.length > 0 ||
        Boolean(adapter.descriptionTranscriptText),
      transcriptTracks,
      defaultTrackBaseUrl: defaultCaptionTrack?.baseUrl || "",
      defaultTrackLabel: defaultCaptionTrack?.label || "",
      availableSources: {
        transcript:
          Boolean(adapter.bootstrapSnapshot?.transcriptParams) ||
          tracks.length > 0 ||
          adapter.domTranscriptSegments.length > 0 ||
          Boolean(adapter.descriptionTranscriptText),
        description: Boolean(adapter.description),
        title: Boolean(adapter.title)
      }
    };
  }

  async function requestBootstrapSnapshot() {
    return new Promise((resolve) => {
      let finished = false;

      const complete = () => {
        if (finished) {
          return;
        }
        finished = true;
        window.removeEventListener(BOOTSTRAP_READY_EVENT, complete);
        const snapshot = readBootstrapAttribute();
        logger.info("requestBootstrapSnapshot complete", {
          href: location.href,
          snapshot: summarizeBootstrap(snapshot)
        });
        resolve(snapshot);
      };

      window.addEventListener(BOOTSTRAP_READY_EVENT, complete, { once: true });
      document.dispatchEvent(new CustomEvent(BOOTSTRAP_REQUEST_EVENT));
      window.setTimeout(complete, 160);
    });
  }

  function readBootstrapAttribute() {
    const rawValue = document.documentElement?.getAttribute(BOOTSTRAP_ATTRIBUTE) || "";
    if (!rawValue) {
      return null;
    }

    try {
      return JSON.parse(rawValue);
    } catch (error) {
      return null;
    }
  }

  function getVisibleTranscriptSegments() {
    return Array.from(document.querySelectorAll("ytd-transcript-segment-renderer"))
      .map((segment, index) => {
        const textElement =
          segment.querySelector(".segment-text") ||
          segment.querySelector("[class*='segment-text']") ||
          segment.querySelector("yt-formatted-string");
        const timeElement =
          segment.querySelector(".segment-timestamp") ||
          segment.querySelector("[class*='segment-timestamp']") ||
          segment.querySelector("#segment-timestamp");
        const text = Text.sanitizeInput(textElement?.textContent || "");
        if (!text) {
          return null;
        }

        const startMs = parseDisplayedTime(timeElement?.textContent || "");
        return {
          startMs,
          durationMs: null,
          text,
          index
        };
      })
      .filter(Boolean);
  }

  async function openYouTubeTranscriptPanel() {
    if (!isYouTubeVideoPage()) {
      return null;
    }

    if (getVisibleTranscriptSegments().length) {
      logger.info("openYouTubeTranscriptPanel using already visible transcript", {
        href: location.href,
        visibleSegments: getVisibleTranscriptSegments().length
      });
      return buildYouTubePageAdapter();
    }

    const opened = await ensureTranscriptPanelVisible();
    const adapter = await buildYouTubePageAdapter();
    logger.info("openYouTubeTranscriptPanel result", {
      href: location.href,
      opened,
      adapter: {
        domTranscriptSegments: Array.isArray(adapter?.domTranscriptSegments)
          ? adapter.domTranscriptSegments.length
          : 0,
        transcriptParams: Boolean(adapter?.bootstrapSnapshot?.transcriptParams)
      }
    });

    if (!opened && !adapter?.domTranscriptSegments?.length) {
      return {
        ...(adapter || {}),
        requestShapeValidation: buildRequestShapeValidation(adapter?.bootstrapSnapshot || {})
      };
    }

    return adapter;
  }

  async function fetchYouTubeUrl(options = {}) {
    const requestUrl = String(options.url || "").trim();
    if (!isAllowedYouTubeFetchUrl(requestUrl)) {
      return {
        ok: false,
        error: "Unsupported YouTube fetch URL."
      };
    }

    try {
      const response = await fetch(requestUrl, {
        credentials: "include"
      });
      const text = await response.text();
      return {
        ok: response.ok,
        status: response.status || 0,
        contentType: response.headers?.get?.("content-type") || "",
        text
      };
    } catch (error) {
      return {
        ok: false,
        error: error?.message || "The YouTube fetch request failed."
      };
    }
  }

  function isAllowedYouTubeFetchUrl(value) {
    try {
      const parsed = new URL(value, location.href);
      const hostname = String(parsed.hostname || "").toLowerCase();
      if (
        parsed.protocol !== "https:" ||
        !["www.youtube.com", "m.youtube.com", "youtube.com"].includes(hostname)
      ) {
        return false;
      }
      return parsed.pathname === "/api/timedtext";
    } catch (error) {
      return false;
    }
  }

  function getYouTubeDescriptionText() {
    const selectors = [
      "ytd-watch-metadata #description-inline-expander",
      "ytd-watch-metadata #description",
      "#bottom-row #description",
      "meta[property='og:description']",
      "meta[name='description']"
    ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (!element) {
        continue;
      }

      const value =
        element.tagName === "META"
          ? element.getAttribute("content") || ""
          : element.textContent || "";
      const text = Text.sanitizeInput(value);
      if (text) {
        return text;
      }
    }

    return "";
  }

  function getDescriptionTranscriptText(descriptionText) {
    const source = Text.sanitizeInput(descriptionText || "");
    if (!source) {
      return "";
    }

    const match = source.match(/(?:^|\n)(?:full\s+)?transcript\s*:?\s*\n+/i);
    if (!match || typeof match.index !== "number") {
      return "";
    }

    const candidate = Text.sanitizeInput(source.slice(match.index + match[0].length));
    return Text.countWords(candidate) >= 80 ? candidate : "";
  }

  function getDisplayTitle() {
    const title =
      document.querySelector("h1.ytd-watch-metadata")?.textContent ||
      document.querySelector("meta[property='og:title']")?.getAttribute("content") ||
      document.title ||
      "";

    return Text.sanitizeInput(title).replace(/\s+-\s+YouTube$/i, "");
  }

  function getSelectionText() {
    const selection = globalThis.getSelection?.();
    const selectionText = selection ? String(selection).trim() : "";
    if (selectionText) {
      return selectionText;
    }

    const active = document.activeElement;
    if (!active) {
      return "";
    }

    const isTextField =
      active instanceof HTMLTextAreaElement ||
      (active instanceof HTMLInputElement &&
        /^(text|search|email|url|tel)$/i.test(active.type || ""));

    if (!isTextField) {
      return "";
    }

    const start = active.selectionStart || 0;
    const end = active.selectionEnd || 0;
    if (end <= start) {
      return "";
    }

    return active.value.slice(start, end);
  }

  function getCaptionTrackLabel(track) {
    const name =
      track?.name?.simpleText ||
      (Array.isArray(track?.name?.runs)
        ? track.name.runs.map((part) => part.text).join("")
        : "");

    if (track?.kind === "asr") {
      return name ? `${name} auto captions` : "Auto captions";
    }
    return name ? `${name} captions` : "Caption track";
  }

  function pickDefaultCaptionTrack(tracks, preferredLanguageCode) {
    const list = Array.isArray(tracks) ? tracks.slice() : [];
    const preferredBaseLanguage = normalizeBaseLanguageCode(preferredLanguageCode);
    const standardTracks = list.filter(
      (track) => track.kind !== "visible" && track.kind !== "description-transcript"
    );
    const manualCaption = standardTracks.find((track) => track.kind !== "asr");
    const generatedCaption = standardTracks.find((track) => track.kind === "asr");
    const visibleTrack = list.find((track) => track.kind === "visible");
    const descriptionTrack = list.find((track) => track.kind === "description-transcript");
    const preferredManual = findCaptionTrackByLanguage(
      standardTracks,
      preferredBaseLanguage,
      (track) => track.kind !== "asr"
    );
    const preferredGenerated = findCaptionTrackByLanguage(
      standardTracks,
      preferredBaseLanguage,
      (track) => track.kind === "asr"
    );
    const englishManual =
      preferredBaseLanguage === "en"
        ? null
        : findCaptionTrackByLanguage(standardTracks, "en", (track) => track.kind !== "asr");
    const englishGenerated =
      preferredBaseLanguage === "en"
        ? null
        : findCaptionTrackByLanguage(standardTracks, "en", (track) => track.kind === "asr");
    return (
      preferredManual ||
      preferredGenerated ||
      englishManual ||
      englishGenerated ||
      manualCaption ||
      generatedCaption ||
      visibleTrack ||
      descriptionTrack ||
      list[0] ||
      null
    );
  }

  function normalizeBaseLanguageCode(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .split(/[-_]/)[0];
  }

  function findCaptionTrackByLanguage(tracks, languageCode, predicate) {
    const baseLanguage = normalizeBaseLanguageCode(languageCode);
    if (!baseLanguage) {
      return null;
    }
    return (tracks || []).find((track) => {
      if (typeof predicate === "function" && !predicate(track)) {
        return false;
      }
      return normalizeBaseLanguageCode(track?.languageCode) === baseLanguage;
    }) || null;
  }

  function getVideoDurationSecondsFromDom() {
    const durationText =
      document.querySelector(".ytp-time-duration")?.textContent ||
      document.querySelector("meta[itemprop='duration']")?.getAttribute("content") ||
      "";

    if (/^PT/i.test(durationText)) {
      return parseIsoDuration(durationText);
    }

    const startMs = parseDisplayedTime(durationText);
    return startMs !== null ? startMs / 1000 : null;
  }

  function parseDisplayedTime(value) {
    const parts = String(value || "")
      .trim()
      .split(":")
      .map((part) => Number(part));

    if (!parts.length || parts.some((part) => !Number.isFinite(part))) {
      return null;
    }

    let seconds = 0;
    while (parts.length) {
      seconds = seconds * 60 + parts.shift();
    }
    return seconds * 1000;
  }

  function parseIsoDuration(value) {
    const match = String(value || "").match(
      /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i
    );
    if (!match) {
      return null;
    }

    const hours = Number(match[1] || 0);
    const minutes = Number(match[2] || 0);
    const seconds = Number(match[3] || 0);
    return hours * 3600 + minutes * 60 + seconds;
  }

  function isYouTubeVideoPage() {
    const host = String(location.hostname || "").replace(/^www\./, "");
    return host === "youtube.com" && location.pathname === "/watch";
  }

  async function ensureTranscriptPanelVisible() {
    if (getVisibleTranscriptSegments().length) {
      return true;
    }

    logger.info("ensureTranscriptPanelVisible:start", {
      href: location.href,
      controls: summarizeTranscriptControls()
    });
    const descriptionExpanded = await expandDescriptionSection();
    logger.info("ensureTranscriptPanelVisible:afterExpand", {
      href: location.href,
      descriptionExpanded,
      controls: summarizeTranscriptControls()
    });

    const directTrigger = await waitForTranscriptTrigger(1400);
    logger.info("ensureTranscriptPanelVisible:directTrigger", {
      found: Boolean(directTrigger),
      label: readElementSummary(directTrigger)
    });
    if (directTrigger) {
      clickElement(directTrigger);
      if (await waitForTranscriptSegments(3200)) {
        logger.info("ensureTranscriptPanelVisible:directTriggerWorked", {
          href: location.href
        });
        return true;
      }
    }

    const transcriptPanel = findTranscriptPanelElement();
    logger.info("ensureTranscriptPanelVisible:transcriptPanel", {
      found: Boolean(transcriptPanel),
      panel: summarizePanelElement(transcriptPanel)
    });
    if (transcriptPanel) {
      revealEngagementPanel(transcriptPanel, "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED");
      if (await waitForTranscriptSegments(2800)) {
        logger.info("ensureTranscriptPanelVisible:transcriptPanelRevealWorked", {
          href: location.href
        });
        return true;
      }
    }

    if (await openTranscriptFromTimelinePanel()) {
      return true;
    }

    const moreActionsButton = findMoreActionsButton();
    logger.info("ensureTranscriptPanelVisible:moreActions", {
      found: Boolean(moreActionsButton),
      label: readElementSummary(moreActionsButton)
    });
    if (moreActionsButton) {
      clickElement(moreActionsButton);
      await delay(220);

      const menuTrigger = findTranscriptMenuItem();
      logger.info("ensureTranscriptPanelVisible:menuTrigger", {
        found: Boolean(menuTrigger),
        label: readElementSummary(menuTrigger)
      });
      if (menuTrigger) {
        clickElement(menuTrigger);
        if (await waitForTranscriptSegments(3200)) {
          logger.info("ensureTranscriptPanelVisible:menuTriggerWorked", {
            href: location.href
          });
          return true;
        }
      }
    }

    logger.warn("ensureTranscriptPanelVisible:failed", {
      href: location.href
    });
    return getVisibleTranscriptSegments().length > 0;
  }

  async function waitForTranscriptSegments(timeoutMs) {
    const deadlineAt = Date.now() + timeoutMs;
    while (Date.now() < deadlineAt) {
      if (getVisibleTranscriptSegments().length) {
        return true;
      }
      await delay(120);
    }
    return getVisibleTranscriptSegments().length > 0;
  }

  async function waitForTranscriptTrigger(timeoutMs) {
    const deadlineAt = Date.now() + timeoutMs;
    let trigger = findTranscriptTrigger();

    while (!trigger && Date.now() < deadlineAt) {
      await delay(140);
      trigger = findTranscriptTrigger();
    }

    return trigger;
  }

  async function openTranscriptFromTimelinePanel() {
    const timelineTrigger = findTimelinePanelTrigger();
    logger.info("ensureTranscriptPanelVisible:timelineTrigger", {
      found: Boolean(timelineTrigger),
      label: readElementSummary(timelineTrigger)
    });
    if (timelineTrigger) {
      clickElement(timelineTrigger);
      await delay(320);
    }

    const timelinePanel = await waitForTimelinePanel(1800);
    logger.info("ensureTranscriptPanelVisible:timelinePanel", {
      found: Boolean(timelinePanel),
      panel: summarizePanelElement(timelinePanel)
    });
    if (!timelinePanel) {
      return false;
    }

    revealEngagementPanel(timelinePanel, "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED");
    await delay(180);

    const transcriptChip = findTranscriptChip(timelinePanel) || findTranscriptTrigger();
    logger.info("ensureTranscriptPanelVisible:timelineTranscriptChip", {
      found: Boolean(transcriptChip),
      label: readElementSummary(transcriptChip)
    });
    if (!transcriptChip) {
      return false;
    }

    clickElement(transcriptChip);
    if (await waitForTranscriptSegments(3600)) {
      logger.info("ensureTranscriptPanelVisible:timelineTranscriptChipWorked", {
        href: location.href
      });
      return true;
    }

    return false;
  }

  async function waitForTimelinePanel(timeoutMs) {
    const deadlineAt = Date.now() + timeoutMs;
    let panel = findTimelinePanelElement();

    while (!panel && Date.now() < deadlineAt) {
      await delay(160);
      panel = findTimelinePanelElement();
    }

    return panel;
  }

  function findTranscriptTrigger() {
    const selectorMatches = [
      "button[aria-label*='transcript' i]",
      "[role='button'][aria-label*='transcript' i]",
      "button[title*='transcript' i]",
      "ytd-video-description-transcript-section-renderer button",
      "ytd-video-description-transcript-section-renderer [role='button']",
      "ytd-video-description-transcript-section-renderer yt-button-shape button",
      "ytd-engagement-panel-section-list-renderer [aria-label*='transcript' i]",
      "[aria-label='Transcript']"
    ];

    for (const selector of selectorMatches) {
      const element = Array.from(document.querySelectorAll(selector)).find(isElementVisible);
      if (isElementVisible(element)) {
        return resolveClickableElement(element);
      }
    }

    return findVisibleElementByText(
      [
        "button",
        "[role='button']",
        "[role='tab']",
        "ytd-button-renderer",
        "tp-yt-paper-button",
        "yt-formatted-string",
        "yt-button-shape button",
        "yt-chip-cloud-chip-renderer",
        "button-view-model"
      ],
      "transcript"
    );
  }

  function findTimelinePanelTrigger() {
    const selectors = [
      "button[aria-label*='in this video' i]",
      "[role='button'][aria-label*='in this video' i]"
    ];

    for (const selector of selectors) {
      const element = Array.from(document.querySelectorAll(selector)).find(isElementVisible);
      if (isElementVisible(element)) {
        return resolveClickableElement(element);
      }
    }

    return findVisibleElementByText(
      [
        "button",
        "[role='button']",
        "yt-button-shape button",
        "ytd-button-renderer",
        "tp-yt-paper-button",
        "yt-formatted-string"
      ],
      "in this video"
    );
  }

  function findMoreActionsButton() {
    const selectors = [
      "#actions button[aria-label*='more' i]",
      "ytd-menu-renderer button[aria-label*='more' i]",
      "button[aria-label*='more actions' i]",
      "button[aria-label='Action menu']",
      "button[aria-haspopup='true'][aria-label]"
    ];

    for (const selector of selectors) {
      const candidates = Array.from(document.querySelectorAll(selector));
      const element = candidates.find(isElementVisible);
      if (element) {
        return resolveClickableElement(element);
      }
    }

    return null;
  }

  function findTranscriptMenuItem() {
    return findVisibleElementByText(
      [
        "ytd-menu-service-item-renderer",
        "tp-yt-paper-item",
        "yt-formatted-string",
        "button",
        "[role='menuitem']",
        "[role='button']"
      ],
      "transcript"
    );
  }

  function findTranscriptPanelElement() {
    const selectors = [
      "ytd-engagement-panel-section-list-renderer[target-id='engagement-panel-searchable-transcript']",
      "ytd-engagement-panel-section-list-renderer[panel-identifier='engagement-panel-searchable-transcript']"
    ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element instanceof HTMLElement) {
        return element;
      }
    }

    return null;
  }

  function findTimelinePanelElement() {
    const selectors = [
      "ytd-engagement-panel-section-list-renderer[target-id='engagement-panel-timeline-view-consolidated']",
      "ytd-engagement-panel-section-list-renderer[panel-identifier='engagement-panel-timeline-view-consolidated']"
    ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element instanceof HTMLElement) {
        return element;
      }
    }

    return null;
  }

  function findTranscriptChip(rootElement) {
    return findElementByTextWithin(
      rootElement,
      [
        "button",
        "[role='button']",
        "[role='tab']",
        "yt-formatted-string",
        "yt-button-shape button",
        "yt-chip-cloud-chip-renderer"
      ],
      "transcript",
      false
    );
  }

  function findVisibleElementByText(selectors, textNeedle) {
    return findElementByTextWithin(document, selectors, textNeedle, true);
  }

  function findElementByTextWithin(rootElement, selectors, textNeedle, requireVisible) {
    const needle = String(textNeedle || "").trim().toLowerCase();
    if (!needle) {
      return null;
    }

    for (const selector of selectors) {
      const elements = Array.from(rootElement.querySelectorAll(selector));
      const match = elements.find((element) => {
        const text = Text.sanitizeInput(element?.textContent || "").toLowerCase();
        return text.includes(needle) && (!requireVisible || isElementVisible(element));
      });
      if (match) {
        return resolveClickableElement(match);
      }
    }

    return null;
  }

  async function expandDescriptionSection() {
    const candidates = [
      "tp-yt-paper-button#expand-sizer",
      "ytd-watch-metadata tp-yt-paper-button#expand",
      "ytd-watch-metadata button#expand",
      "ytd-watch-metadata ytd-text-inline-expander tp-yt-paper-button",
      "ytd-watch-metadata button[aria-label*='more' i]",
      "#description-inline-expander tp-yt-paper-button#expand",
      "#description-inline-expander button#expand",
      "#description-inline-expander tp-yt-paper-button",
      "#description-inline-expander button[aria-label*='more' i]",
      "tp-yt-paper-button"
    ];

    for (const selector of candidates) {
      const elements = Array.from(document.querySelectorAll(selector));
      const target = elements.find((element) => {
        const text = Text.sanitizeInput(element?.textContent || "").toLowerCase();
        return Boolean((text.includes("more") || text.includes("expand")) && isElementVisible(element));
      });

      if (!target) {
        continue;
      }

      logger.info("expandDescriptionSection:clicked", {
        selector,
        target: readElementSummary(target)
      });
      clickElement(target);
      await delay(420);
      return true;
    }

    logger.info("expandDescriptionSection:notFound", {
      href: location.href
    });
    return false;
  }

  function resolveClickableElement(element) {
    if (!(element instanceof HTMLElement)) {
      return null;
    }

    return (
      element.closest(
        [
          "button",
          "tp-yt-paper-button",
          "ytd-button-renderer",
          "ytd-menu-service-item-renderer",
          "tp-yt-paper-item"
        ].join(",")
      ) || element
    );
  }

  function isElementVisible(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none"
    );
  }

  function clickElement(element) {
    const target = resolveClickableElement(element);
    if (!target) {
      return;
    }
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    target.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, cancelable: true }));
    target.click();
  }

  function revealEngagementPanel(panel, visibilityValue) {
    if (!(panel instanceof HTMLElement)) {
      return;
    }

    panel.hidden = false;
    panel.removeAttribute("hidden");
    panel.style.display = "";
    panel.style.visibility = "";
    if (visibilityValue) {
      panel.setAttribute("visibility", visibilityValue);
    }
    panel.scrollIntoView({
      block: "nearest"
    });
  }

  function buildRequestShapeValidation(bootstrapSnapshot) {
    const observed = bootstrapSnapshot?.observedTranscriptRequest || null;
    if (!observed) {
      return null;
    }

    const mismatchedFields = [];
    if ((observed.params || "") !== (bootstrapSnapshot?.transcriptParams || "")) {
      mismatchedFields.push("params");
    }

    return {
      matches: mismatchedFields.length === 0,
      reconstructedParams: bootstrapSnapshot?.transcriptParams || null,
      observedParams: observed.params || null,
      mismatchedFields,
      validatedAt: observed.observedAt || Date.now()
    };
  }

  function delay(timeoutMs) {
    return new Promise((resolve) => window.setTimeout(resolve, timeoutMs));
  }

  function summarizeBootstrap(snapshot) {
    if (!snapshot) {
      return null;
    }

    return {
      videoId: snapshot.videoId || "",
      captionTracks: Array.isArray(snapshot.captionTracks) ? snapshot.captionTracks.length : 0,
      translationLanguages: Array.isArray(snapshot.translationLanguages)
        ? snapshot.translationLanguages.length
        : 0,
      transcriptParams: Boolean(snapshot.transcriptParams),
      observedTranscriptRequest: Boolean(snapshot.observedTranscriptRequest?.params),
      clientName: snapshot.clientName || "",
      hl: snapshot.hl || ""
    };
  }

  function summarizeVideo(video) {
    if (!video) {
      return null;
    }

    return {
      title: video.title || "",
      transcriptAvailable: Boolean(video.transcriptAvailable),
      descriptionAvailable: Boolean(video.descriptionAvailable),
      transcriptTrackCount: Array.isArray(video.transcriptTracks)
        ? video.transcriptTracks.length
        : 0,
      availableSources: video.availableSources || {}
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

  function readElementSummary(element) {
    if (!(element instanceof HTMLElement)) {
      return "";
    }

    return Text.sanitizeInput(
      [
        element.tagName || "",
        element.getAttribute("aria-label") || "",
        element.getAttribute("title") || "",
        element.textContent || ""
      ].join(" ")
    );
  }

  function summarizePanelElement(element) {
    if (!(element instanceof HTMLElement)) {
      return null;
    }

    return {
      tagName: element.tagName || "",
      targetId: element.getAttribute("target-id") || "",
      panelIdentifier: element.getAttribute("panel-identifier") || "",
      visibility: element.getAttribute("visibility") || "",
      hidden: element.hasAttribute("hidden")
    };
  }

  function summarizeTranscriptControls() {
    return {
      visibleSegments: getVisibleTranscriptSegments().length,
      hasDescriptionTranscriptSection: Boolean(
        document.querySelector("ytd-video-description-transcript-section-renderer")
      ),
      hasTranscriptPanelElement: Boolean(findTranscriptPanelElement()),
      hasTimelinePanelElement: Boolean(findTimelinePanelElement())
    };
  }

  TestApi.pickDefaultCaptionTrack = pickDefaultCaptionTrack;
  TestApi.buildVideoContextFromAdapter = buildVideoContextFromAdapter;
  TestApi.extractPagePayload = extractPagePayload;
  TestApi.buildPageContextPayload = buildPageContextPayload;
})();

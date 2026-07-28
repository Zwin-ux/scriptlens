(function (root) {
  if (root.__scriptLensYouTubeMainLoaded) {
    return;
  }

  root.__scriptLensYouTubeMainLoaded = true;
  const Debug = root.ScriptLensDebug || {};
  const logger = Debug.createLogger
    ? Debug.createLogger("youtube-main")
    : console;
  if (Debug.installGlobalErrorHandlers) {
    Debug.installGlobalErrorHandlers("youtube-main");
  }

  const SNAPSHOT_ATTRIBUTE = "data-scriptlens-youtube-bootstrap";
  const REQUEST_EVENT = "scriptlens:request-youtube-bootstrap";
  const READY_EVENT = "scriptlens:youtube-bootstrap-ready";
  let refreshTimer = 0;
  let lastSnapshotSignature = "";

  init();

  function init() {
    logger.info("init", {
      href: root.location?.href || ""
    });
    installTranscriptRequestObserver();
    writeSnapshot();
    scheduleRefreshBurst();

    document.addEventListener(REQUEST_EVENT, writeSnapshot);
    root.addEventListener("yt-navigate-start", scheduleRefreshBurst);
    root.addEventListener("yt-navigate-finish", scheduleRefreshBurst);
    root.addEventListener("yt-page-data-updated", scheduleRefreshBurst);
    root.addEventListener("load", scheduleRefreshBurst);
  }

  function scheduleRefreshBurst() {
    clearTimeout(refreshTimer);
    writeSnapshot();

    [160, 650, 1600].forEach((delay) => {
      refreshTimer = root.setTimeout(writeSnapshot, delay);
    });
  }

  function writeSnapshot() {
    const target = document.documentElement;
    if (!target) {
      return;
    }

    const snapshot = readBootstrapSnapshot();
    try {
      target.setAttribute(SNAPSHOT_ATTRIBUTE, JSON.stringify(snapshot));
    } catch (error) {
      target.removeAttribute(SNAPSHOT_ATTRIBUTE);
    }

    const signature = [
      snapshot.videoId || "",
      Array.isArray(snapshot.captionTracks) ? snapshot.captionTracks.length : 0,
      Boolean(snapshot.transcriptParams),
      Boolean(snapshot.observedTranscriptRequest?.params)
    ].join("|");
    if (signature !== lastSnapshotSignature) {
      lastSnapshotSignature = signature;
      logger.info("snapshot updated", {
        href: root.location?.href || "",
        videoId: snapshot.videoId || "",
        captionTracks: Array.isArray(snapshot.captionTracks)
          ? snapshot.captionTracks.length
          : 0,
        transcriptParams: Boolean(snapshot.transcriptParams),
        observedTranscriptRequest: Boolean(snapshot.observedTranscriptRequest?.params)
      });
    }

    root.dispatchEvent(new CustomEvent(READY_EVENT));
  }

  function readBootstrapSnapshot() {
    const playerResponse = readPlayerResponse();
    const initialData = root.ytInitialData || null;
    const ytcfgData = root.ytcfg?.data_ || {};
    const captionRenderer = playerResponse?.captions?.playerCaptionsTracklistRenderer || {};
    const clientContext =
      root.INNERTUBE_CONTEXT ||
      ytcfgData.INNERTUBE_CONTEXT ||
      buildClientContextFromConfig(ytcfgData);

    return {
      apiKey:
        root.INNERTUBE_API_KEY ||
        ytcfgData.INNERTUBE_API_KEY ||
        root.ytcfg?.get?.("INNERTUBE_API_KEY") ||
        "",
      clientContext: clientContext || null,
      visitorData:
        ytcfgData.VISITOR_DATA ||
        clientContext?.client?.visitorData ||
        root.ytcfg?.get?.("VISITOR_DATA") ||
        "",
      clientName:
        clientContext?.client?.clientName ||
        ytcfgData.INNERTUBE_CONTEXT_CLIENT_NAME ||
        root.INNERTUBE_CONTEXT_CLIENT_NAME ||
        "",
      clientVersion:
        clientContext?.client?.clientVersion ||
        ytcfgData.INNERTUBE_CONTEXT_CLIENT_VERSION ||
        root.INNERTUBE_CONTEXT_CLIENT_VERSION ||
        "",
      hl: clientContext?.client?.hl || ytcfgData.HL || "",
      gl: clientContext?.client?.gl || ytcfgData.GL || "",
      videoId:
        playerResponse?.videoDetails?.videoId ||
        new URLSearchParams(root.location.search).get("v") ||
        extractShortsVideoId(root.location.pathname),
      captionTracks: captionRenderer.captionTracks || [],
      translationLanguages: captionRenderer.translationLanguages || [],
      transcriptParams: findTranscriptParams(initialData),
      observedTranscriptRequest: root.__scriptLensObservedTranscriptRequest || null,
      videoDurationSeconds: toFiniteNumber(playerResponse?.videoDetails?.lengthSeconds),
      originalLanguageCode:
        captionRenderer.defaultAudioTrackIndex != null
          ? captionRenderer.captionTracks?.[captionRenderer.defaultAudioTrackIndex]?.languageCode || null
          : captionRenderer.captionTracks?.[0]?.languageCode || null,
      hasGeneratedCaptions: Array.isArray(captionRenderer.captionTracks)
        ? captionRenderer.captionTracks.some((track) => track?.kind === "asr")
        : false,
      updatedAt: Date.now()
    };
  }

  function readPlayerResponse() {
    const raw =
      root.ytInitialPlayerResponse ||
      root.ytplayer?.config?.args?.raw_player_response ||
      root.ytplayer?.config?.args?.player_response ||
      null;

    if (typeof raw === "string") {
      try {
        return JSON.parse(raw);
      } catch (error) {
        return null;
      }
    }

    return raw || null;
  }

  function buildClientContextFromConfig(ytcfgData) {
    const clientName =
      ytcfgData.INNERTUBE_CONTEXT_CLIENT_NAME || root.INNERTUBE_CONTEXT_CLIENT_NAME;
    const clientVersion =
      ytcfgData.INNERTUBE_CONTEXT_CLIENT_VERSION || root.INNERTUBE_CONTEXT_CLIENT_VERSION;
    const hl = ytcfgData.HL || "en";
    const gl = ytcfgData.GL || "US";

    if (!clientName || !clientVersion) {
      return null;
    }

    return {
      client: {
        clientName,
        clientVersion,
        hl,
        gl
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

      if (
        current.showTranscriptButton &&
        current.showTranscriptButton.buttonRenderer?.serviceEndpoint?.getTranscriptEndpoint
          ?.params
      ) {
        return current.showTranscriptButton.buttonRenderer.serviceEndpoint.getTranscriptEndpoint.params;
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

  function extractShortsVideoId(pathname) {
    const match = String(pathname || "").match(/^\/shorts\/([^/?#]+)/);
    return match ? match[1] : "";
  }

  function installTranscriptRequestObserver() {
    if (root.__scriptLensTranscriptObserverInstalled) {
      return;
    }

    root.__scriptLensTranscriptObserverInstalled = true;
    const originalFetch = root.fetch;
    if (typeof originalFetch === "function") {
      root.fetch = function patchedFetch(input, init) {
        const observedRequest = captureTranscriptRequest(input, init);
        const responsePromise = originalFetch.apply(this, arguments);

        if (observedRequest && responsePromise && typeof responsePromise.then === "function") {
          Promise.resolve(responsePromise)
            .then((response) => {
              captureTranscriptResponse(response, observedRequest);
            })
            .catch((error) => {
              logger.warn("transcript request promise failed", {
                url: observedRequest.url || "",
                error: {
                  message: error?.message || "",
                  stack: error?.stack || ""
                }
              });
            });
        }

        return responsePromise;
      };
    }
  }

  function captureTranscriptRequest(input, init) {
    const requestUrl = readRequestUrl(input);
    if (!/\/youtubei\/v1\/get_transcript\b/i.test(requestUrl)) {
      return null;
    }

    const headers = normalizeHeaders(
      init?.headers || (typeof Request !== "undefined" && input instanceof Request ? input.headers : null)
    );
    const observedRequest = {
      url: requestUrl,
      params: null,
      clientName:
        headers["x-youtube-client-name"] ||
        null,
      clientVersion:
        headers["x-youtube-client-version"] ||
        null,
      responseStatus: null,
      observedAt: Date.now()
    };
    updateObservedTranscriptRequest(observedRequest);
    logger.info("captured transcript request", {
      url: requestUrl,
      params: observedRequest.params,
      clientName: observedRequest.clientName,
      clientVersion: observedRequest.clientVersion
    });

    readRequestPayload(input, init).then((payload) => {
      if (!payload) {
        return;
      }

      observedRequest.params = payload?.params || observedRequest.params || null;
      observedRequest.clientName =
        observedRequest.clientName || payload?.context?.client?.clientName || null;
      observedRequest.clientVersion =
        observedRequest.clientVersion || payload?.context?.client?.clientVersion || null;
      observedRequest.observedAt = Date.now();
      updateObservedTranscriptRequest(observedRequest);
      logger.info("captured transcript request body", {
        url: requestUrl,
        params: observedRequest.params,
        clientName: observedRequest.clientName,
        clientVersion: observedRequest.clientVersion
      });
    });

    return observedRequest;
  }

  function readRequestUrl(input) {
    if (typeof input === "string") {
      return input;
    }
    if (input && typeof input.url === "string") {
      return input.url;
    }
    return "";
  }

  function normalizeHeaders(headers) {
    const output = {};
    if (!headers) {
      return output;
    }

    if (typeof headers.forEach === "function") {
      headers.forEach((value, key) => {
        output[String(key || "").toLowerCase()] = String(value || "");
      });
      return output;
    }

    Object.keys(headers).forEach((key) => {
      output[String(key || "").toLowerCase()] = String(headers[key] || "");
    });
    return output;
  }

  async function readRequestPayload(input, init) {
    const initPayload = parseRequestBody(init?.body);
    if (initPayload) {
      return initPayload;
    }

    if (typeof Request !== "undefined" && input instanceof Request) {
      try {
        const text = await input.clone().text();
        return parseRequestBody(text);
      } catch (error) {
        return null;
      }
    }

    return null;
  }

  function parseRequestBody(body) {
    if (!body) {
      return null;
    }

    if (typeof body === "string") {
      try {
        return JSON.parse(body);
      } catch (error) {
        return null;
      }
    }

    if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
      return Object.fromEntries(body.entries());
    }

    if (
      typeof body === "object" &&
      !(typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) &&
      !ArrayBuffer.isView?.(body) &&
      typeof body.text !== "function"
    ) {
      return body;
    }

    return null;
  }

  async function captureTranscriptResponse(response, observedRequest) {
    if (!response) {
      return null;
    }

    observedRequest.responseStatus = response.status || 0;
    observedRequest.observedAt = Date.now();
    updateObservedTranscriptRequest(observedRequest);

    let bodySnippet = "";
    if (!response.ok && typeof response.clone === "function") {
      try {
        bodySnippet = (await response.clone().text()).slice(0, 240);
      } catch (error) {
        bodySnippet = "";
      }
    }

    logger.info("captured transcript response", {
      url: observedRequest.url || "",
      status: response.status || 0,
      ok: Boolean(response.ok),
      bodySnippet
    });
  }

  function updateObservedTranscriptRequest(observedRequest) {
    root.__scriptLensObservedTranscriptRequest = {
      url: observedRequest.url || "",
      params: observedRequest.params || null,
      clientName: observedRequest.clientName || null,
      clientVersion: observedRequest.clientVersion || null,
      responseStatus: observedRequest.responseStatus || null,
      observedAt: observedRequest.observedAt || Date.now()
    };
  }

  function toFiniteNumber(value) {
    const nextValue = Number(value);
    return Number.isFinite(nextValue) ? nextValue : null;
  }
})(globalThis);

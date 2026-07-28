(function (root) {
  const ScriptLens = (root.ScriptLens = root.ScriptLens || {});
  const Transcript = (ScriptLens.transcript = ScriptLens.transcript || {});
  const Strategies = (Transcript.strategies = Transcript.strategies || {});
  const Text = (root.AIScriptDetector || {}).text;

  Strategies.youtubei = {
    run
  };

  async function run(context) {
    const adapter = context?.adapter || {};
    const bootstrap = adapter.bootstrapSnapshot || {};
    if (!bootstrap.apiKey || !bootstrap.clientContext) {
      return {
        ok: false,
        warningCodes: ["youtubei_bootstrap_incomplete"],
        errorCode: "youtubei_bootstrap_incomplete",
        errorMessage: "The YouTube transcript endpoint metadata is incomplete on this page."
      };
    }

    const transcriptParams =
      bootstrap.transcriptParams ||
      (await deriveTranscriptParams(bootstrap, context).catch(() => ""));

    if (!transcriptParams) {
      return {
        ok: false,
        warningCodes: ["youtubei_params_missing"],
        errorCode: "youtubei_params_missing",
        errorMessage: "Transcript params could not be derived for the YouTube transcript endpoint."
      };
    }

    const requestShapeValidation = buildRequestShapeValidation(bootstrap, transcriptParams);
    const warningCodes = []
      .concat(requestShapeValidation.matches === true ? ["youtubei_request_shape_validated"] : [])
      .concat(
        requestShapeValidation.matches === false
          ? ["youtubei_request_shape_mismatch", "youtubei_request_shape_pending_validation"]
          : requestShapeValidation.matches === null
            ? ["youtubei_request_shape_pending_validation"]
            : []
      );

    try {
      const response = await fetch(
        `https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false&key=${encodeURIComponent(
          bootstrap.apiKey
        )}`,
        {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": "application/json",
            "x-youtube-client-name": String(bootstrap.clientContext?.client?.clientName || ""),
            "x-youtube-client-version": String(
              bootstrap.clientContext?.client?.clientVersion || ""
            )
          },
          signal: context?.signal,
          body: JSON.stringify({
            context: bootstrap.clientContext,
            params: transcriptParams
          })
        }
      );

      if (!response.ok) {
        const failure = await readYoutubeiFailure(response);
        return {
          ok: false,
          warningCodes: warningCodes.concat(failure.warningCodes),
          errorCode: failure.errorCode,
          errorMessage: failure.errorMessage
        };
      }

      const payload = await response.json();
      const parsed = parseTranscriptResponse(payload);
      if (!parsed.text) {
        return {
          ok: false,
          warningCodes: ["youtubei_empty"],
          errorCode: "youtubei_empty",
          errorMessage: "The YouTube transcript endpoint returned no usable transcript text."
        };
      }

      return {
        ok: true,
        provider: "youtubeResolver",
        strategy: "youtubei-transcript",
        trackLabel: "YouTube transcript",
        requestShapeValidation,
        languageCode: parsed.languageCode || bootstrap.originalLanguageCode || bootstrap.hl || null,
        originalLanguageCode:
          parsed.originalLanguageCode || bootstrap.originalLanguageCode || bootstrap.hl || null,
        requestedLanguageCode: context?.requestedLanguageCode || null,
        isGenerated:
          typeof parsed.isGenerated === "boolean" ? parsed.isGenerated : bootstrap.hasGeneratedCaptions,
        isTranslated: Boolean(parsed.isTranslated),
        isMachineTranslated: Boolean(parsed.isMachineTranslated),
        videoDurationSeconds: adapter.videoDurationSeconds || bootstrap.videoDurationSeconds || null,
        transcriptSpanSeconds: parsed.transcriptSpanSeconds,
        segments: parsed.segments,
        text: parsed.text,
        warnings: warningCodes
      };
    } catch (error) {
      return {
        ok: false,
        warningCodes: warningCodes.concat(["youtubei_failed"]),
        errorCode: "youtubei_failed",
        errorMessage: error?.message || "The YouTube transcript endpoint could not be read."
      };
    }
  }

  async function deriveTranscriptParams(bootstrap, context) {
    if (!bootstrap.apiKey || !bootstrap.clientContext || !bootstrap.videoId) {
      return "";
    }

    const response = await fetch(
      `https://www.youtube.com/youtubei/v1/next?prettyPrint=false&key=${encodeURIComponent(
        bootstrap.apiKey
      )}`,
      {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          "x-youtube-client-name": String(bootstrap.clientContext?.client?.clientName || ""),
          "x-youtube-client-version": String(
            bootstrap.clientContext?.client?.clientVersion || ""
          )
        },
        signal: context?.signal,
        body: JSON.stringify({
          context: bootstrap.clientContext,
          videoId: bootstrap.videoId
        })
      }
    );

    if (!response.ok) {
      return "";
    }

    const payload = await response.json();
    return findTranscriptParams(payload);
  }

  function parseTranscriptResponse(payload) {
    const segments = [];
    const rendererNodes = [];
    collectTranscriptRenderers(payload, rendererNodes);

    rendererNodes.forEach((renderer) => {
      const segmentRenderer = renderer?.transcriptSegmentRenderer || renderer?.transcriptCueRenderer;
      if (!segmentRenderer) {
        return;
      }

      const text = readRunsText(segmentRenderer.snippet) || readRunsText(segmentRenderer.cue);
      const normalizedText = Text.sanitizeInput(text || "");
      if (!normalizedText) {
        return;
      }

      segments.push({
        startMs:
          toFiniteNumber(segmentRenderer.startMs) ||
          parseTimeLabel(segmentRenderer.startTimeText) ||
          parseTimeLabel(segmentRenderer.startOffsetText),
        durationMs: toFiniteNumber(segmentRenderer.durationMs),
        text: normalizedText
      });
    });

    const text = Text.sanitizeInput(segments.map((segment) => segment.text).join("\n"));
    const header = findTranscriptHeader(payload);

    return {
      text,
      segments,
      languageCode: header.languageCode || null,
      originalLanguageCode: header.originalLanguageCode || null,
      isGenerated: header.isGenerated,
      isTranslated: header.isTranslated,
      isMachineTranslated: header.isMachineTranslated,
      transcriptSpanSeconds: computeSpanSeconds(segments)
    };
  }

  function collectTranscriptRenderers(node, output) {
    if (!node || typeof node !== "object") {
      return;
    }

    if (node.transcriptSegmentRenderer || node.transcriptCueRenderer) {
      output.push(node);
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

  function findTranscriptHeader(payload) {
    const result = {
      languageCode: null,
      originalLanguageCode: null,
      isGenerated: null,
      isTranslated: false,
      isMachineTranslated: false
    };

    collectMetadata(payload, result);
    return result;
  }

  function collectMetadata(node, result) {
    if (!node || typeof node !== "object") {
      return;
    }

    if (!result.languageCode && typeof node.languageCode === "string") {
      result.languageCode = node.languageCode;
    }
    if (!result.originalLanguageCode && typeof node.originalLanguageCode === "string") {
      result.originalLanguageCode = node.originalLanguageCode;
    }
    if (result.isGenerated === null && typeof node.kind === "string") {
      result.isGenerated = node.kind === "asr";
    }
    if (!result.isTranslated && (node.isTranslated === true || node.translationLanguage)) {
      result.isTranslated = true;
    }
    if (!result.isMachineTranslated && node.isMachineTranslated === true) {
      result.isMachineTranslated = true;
    }

    Object.keys(node).forEach((key) => {
      const value = node[key];
      if (Array.isArray(value)) {
        value.forEach((entry) => collectMetadata(entry, result));
        return;
      }
      if (value && typeof value === "object") {
        collectMetadata(value, result);
      }
    });
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

    const text =
      payload?.error?.message ||
      payload?.error?.status ||
      payload?.status ||
      "";
    const combined = `${response.status} ${text}`.toUpperCase();
    if (combined.includes("FAILED_PRECONDITION")) {
      return {
        warningCodes: ["youtubei_failed", "youtubei_failed_precondition"],
        errorCode: "youtubei_failed_precondition",
        errorMessage:
          "The reconstructed YouTube transcript request failed a precondition check."
      };
    }

    return {
      warningCodes: ["youtubei_failed"],
      errorCode: `youtubei_http_${response.status}`,
      errorMessage: `The YouTube transcript endpoint returned ${response.status}.`
    };
  }

  function buildRequestShapeValidation(bootstrap, transcriptParams) {
    const observed = bootstrap?.observedTranscriptRequest || null;
    if (!observed) {
      return {
        matches: null,
        reconstructedParams: transcriptParams,
        observedParams: null,
        mismatchedFields: ["unobserved"],
        validatedAt: Date.now()
      };
    }

    const mismatchedFields = [];
    if ((observed.params || "") !== (transcriptParams || "")) {
      mismatchedFields.push("params");
    }
    if (
      String(observed.clientName || "") !==
      String(bootstrap.clientContext?.client?.clientName || "")
    ) {
      mismatchedFields.push("clientName");
    }
    if (
      String(observed.clientVersion || "") !==
      String(bootstrap.clientContext?.client?.clientVersion || "")
    ) {
      mismatchedFields.push("clientVersion");
    }

    return {
      matches: mismatchedFields.length === 0,
      reconstructedParams: transcriptParams,
      observedParams: observed.params || null,
      mismatchedFields,
      validatedAt: Date.now()
    };
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

  function parseTimeLabel(value) {
    const label = readRunsText(value) || (typeof value === "string" ? value : "");
    if (!label) {
      return null;
    }

    const parts = label
      .trim()
      .split(":")
      .map((part) => Number(part));

    if (parts.some((part) => !Number.isFinite(part))) {
      return null;
    }

    let seconds = 0;
    while (parts.length) {
      seconds = seconds * 60 + parts.shift();
    }
    return seconds * 1000;
  }

  function computeSpanSeconds(segments) {
    const timestamps = segments
      .map((segment) => ({
        startMs: toFiniteNumber(segment.startMs),
        endMs:
          toFiniteNumber(segment.startMs) !== null
            ? toFiniteNumber(segment.startMs) + Math.max(toFiniteNumber(segment.durationMs) || 0, 0)
            : null
      }))
      .filter((segment) => segment.startMs !== null);

    if (!timestamps.length) {
      return null;
    }

    const startMs = Math.min(...timestamps.map((segment) => segment.startMs));
    const endMs = Math.max(...timestamps.map((segment) => segment.endMs || segment.startMs));
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      return null;
    }

    return Math.round(((endMs - startMs) / 1000) * 10) / 10;
  }

  function toFiniteNumber(value) {
    const nextValue = Number(value);
    return Number.isFinite(nextValue) ? nextValue : null;
  }
})(globalThis);

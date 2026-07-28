(function (root) {
  const ScriptLens = (root.ScriptLens = root.ScriptLens || {});
  const Transcript = (ScriptLens.transcript = ScriptLens.transcript || {});
  const Strategies = (Transcript.strategies = Transcript.strategies || {});
  const Text = (root.AIScriptDetector || {}).text;
  const Debug = root.ScriptLensDebug || {};
  const logger = Debug.createLogger
    ? Debug.createLogger("caption-track")
    : console;

  Strategies.captionTrack = {
    run,
    pickPreferredTrack
  };

  async function run(context) {
    const adapter = context?.adapter || {};
    const bootstrap = adapter.bootstrapSnapshot || {};
    const tracks = Array.isArray(bootstrap.captionTracks) ? bootstrap.captionTracks : [];
    if (!tracks.length) {
      logger.info("run:noTracks", {
        traceId: context?.traceId || "",
        videoId: adapter.videoId || bootstrap.videoId || ""
      });
      return {
        ok: false,
        warningCodes: ["caption_tracks_missing"],
        errorCode: "caption_tracks_missing",
        errorMessage: "No caption tracks were exposed by the current YouTube page."
      };
    }

    const track = pickPreferredTrack(tracks, {
      requestedLanguageCode: context?.requestedLanguageCode || null,
      preferredTrackBaseUrl: context?.preferredTrackBaseUrl || "",
      preferredBias: context?.transcriptBias || "manual-en"
    });
    logger.info("run:selectedTrack", {
      traceId: context?.traceId || "",
      videoId: adapter.videoId || bootstrap.videoId || "",
      track: summarizeTrack(track),
      requestedLanguageCode: context?.requestedLanguageCode || null,
      preferredTrackBaseUrl: context?.preferredTrackBaseUrl || "",
      preferredBias: context?.transcriptBias || "manual-en"
    });

    if (!track?.baseUrl) {
      return {
        ok: false,
        warningCodes: ["caption_track_unavailable"],
        errorCode: "caption_track_unavailable",
        errorMessage: "No usable caption track could be selected."
      };
    }

    const attemptUrls = buildAttemptUrls(track.baseUrl);
    for (const attemptUrl of attemptUrls) {
      const transports = ["extension"];
      if (typeof context?.pageFetch === "function") {
        transports.push("page");
      }

      for (const transport of transports) {
        const payloadText = await readCaptionPayload(attemptUrl, context, transport);
        if (!payloadText) {
          continue;
        }

        const parsed = parseCaptionPayload(payloadText);
        logger.info("run:parsedPayload", {
          traceId: context?.traceId || "",
          attemptUrl,
          transport,
          payloadLength: String(payloadText || "").length,
          textLength: String(parsed.text || "").length,
          segmentCount: Array.isArray(parsed.segments) ? parsed.segments.length : 0
        });
        if (parsed.text) {
          return {
            ok: true,
            provider: "youtubeResolver",
            strategy: "caption-track",
            trackLabel: getTrackLabel(track),
            languageCode: track.languageCode || null,
            originalLanguageCode: track.languageCode || null,
            requestedLanguageCode: context?.requestedLanguageCode || null,
            isGenerated: track.kind === "asr",
            isTranslated: false,
            isMachineTranslated: false,
            videoDurationSeconds: adapter.videoDurationSeconds || bootstrap.videoDurationSeconds || null,
            segments: parsed.segments,
            text: parsed.text,
            warnings: track.kind === "asr" ? ["generated_captions"] : []
          };
        }
      }
    }

    logger.warn("run:failed", {
      traceId: context?.traceId || "",
      videoId: adapter.videoId || bootstrap.videoId || "",
      track: summarizeTrack(track)
    });
    return {
      ok: false,
      warningCodes: ["caption_fetch_failed"],
      errorCode: "caption_fetch_failed",
      errorMessage: "Caption tracks were present, but the transcript payload could not be read."
    };
  }

  function pickPreferredTrack(tracks, options) {
    const normalizedTracks = (Array.isArray(tracks) ? tracks : []).map((track) => ({
      ...track,
      languageCode: String(track.languageCode || "").toLowerCase()
    }));

    if (options.preferredTrackBaseUrl) {
      const directMatch = normalizedTracks.find(
        (track) => track.baseUrl === options.preferredTrackBaseUrl
      );
      if (directMatch) {
        return directMatch;
      }
    }

    const requestedLanguageCode = String(options.requestedLanguageCode || "").toLowerCase();
    const bias = options.preferredBias || "manual-en";
    const manualTracks = normalizedTracks.filter((track) => track.kind !== "asr");
    const generatedTracks = normalizedTracks.filter((track) => track.kind === "asr");
    const requestedManual = manualTracks.find((track) => languageMatches(track.languageCode, requestedLanguageCode));
    const requestedGenerated = generatedTracks.find((track) =>
      languageMatches(track.languageCode, requestedLanguageCode)
    );
    const manualEnglish = manualTracks.find((track) => languageMatches(track.languageCode, "en"));
    const generatedEnglish = generatedTracks.find((track) =>
      languageMatches(track.languageCode, "en")
    );

    if (requestedManual) {
      return requestedManual;
    }
    if (requestedGenerated) {
      return requestedGenerated;
    }

    if (bias === "manual-en") {
      return manualEnglish || generatedEnglish || manualTracks[0] || generatedTracks[0] || null;
    }
    if (bias === "auto-en") {
      return generatedEnglish || manualEnglish || generatedTracks[0] || manualTracks[0] || null;
    }
    if (bias === "manual-any") {
      return manualTracks[0] || generatedTracks[0] || null;
    }
    if (bias === "auto-any") {
      return generatedTracks[0] || manualTracks[0] || null;
    }

    return manualEnglish || generatedEnglish || manualTracks[0] || generatedTracks[0] || null;
  }

  function buildAttemptUrls(baseUrl) {
    const values = [];
    const seen = new Set();

    const pushValue = (value) => {
      if (!value || seen.has(value)) {
        return;
      }
      seen.add(value);
      values.push(value);
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
      return values;
    }

    return values;
  }

  async function readCaptionPayload(attemptUrl, context, transport) {
    try {
      logger.info("run:fetchAttempt", {
        traceId: context?.traceId || "",
        attemptUrl,
        transport
      });

      if (transport === "page" && typeof context?.pageFetch === "function") {
        const response = await context.pageFetch({
          url: attemptUrl
        });
        logger.info("run:pageFetchResponse", {
          traceId: context?.traceId || "",
          attemptUrl,
          status: response?.status || 0,
          ok: Boolean(response?.ok),
          contentType: response?.contentType || "",
          error: response?.error || ""
        });
        return response?.ok ? response.text || "" : "";
      }

      const response = await fetch(attemptUrl, {
        credentials: "include",
        signal: context?.signal
      });
      logger.info("run:fetchResponse", {
        traceId: context?.traceId || "",
        attemptUrl,
        status: response.status || 0,
        ok: Boolean(response.ok),
        contentType: response.headers?.get?.("content-type") || ""
      });
      if (!response.ok) {
        return "";
      }
      return await response.text();
    } catch (error) {
      logger.warn("run:fetchFailed", {
        traceId: context?.traceId || "",
        attemptUrl,
        transport,
        error: {
          message: error?.message || "",
          stack: error?.stack || ""
        }
      });
      return "";
    }
  }

  function parseCaptionPayload(payloadText) {
    const source = String(payloadText || "").trim();
    if (!source) {
      return emptyTranscript();
    }

    if (source.startsWith("{")) {
      return parseJsonPayload(source);
    }
    if (source.startsWith("WEBVTT")) {
      return parseVttPayload(source);
    }
    return parseXmlPayload(source);
  }

  function parseJsonPayload(source) {
    try {
      const parsed = JSON.parse(source);
      const segments = (parsed?.events || [])
        .map((event) => {
          const text = Text.sanitizeInput(
            ((event?.segs || [])
              .map((part) => decodeEntities(part?.utf8 || ""))
              .join("")
              .replace(/\s+/g, " "))
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

      return finalizeSegments(segments);
    } catch (error) {
      return emptyTranscript();
    }
  }

  function parseXmlPayload(source) {
    const tagPattern = /<(text|p)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
    const segments = [];
    let match;

    while ((match = tagPattern.exec(source))) {
      const attributes = match[2] || "";
      const text = Text.sanitizeInput(decodeEntities(stripHtml(match[3] || "")));
      if (!text) {
        continue;
      }

      segments.push({
        startMs: parseXmlTime(attributes, ["t", "start", "begin"]),
        durationMs: parseXmlTime(attributes, ["d", "dur"]),
        text
      });
    }

    return finalizeSegments(segments);
  }

  function parseVttPayload(source) {
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

      currentCue.text = Text.sanitizeInput(
        [currentCue.text, decodeEntities(stripHtml(trimmed))].filter(Boolean).join(" ")
      );
    });

    if (currentCue?.text) {
      segments.push(currentCue);
    }

    return finalizeSegments(segments);
  }

  function finalizeSegments(segments) {
    const normalizedSegments = (Array.isArray(segments) ? segments : [])
      .map((segment) => ({
        startMs: toFiniteNumber(segment.startMs),
        durationMs: toFiniteNumber(segment.durationMs),
        text: Text.sanitizeInput(segment.text || "")
      }))
      .filter((segment) => Boolean(segment.text));

    return {
      text: Text.sanitizeInput(normalizedSegments.map((segment) => segment.text).join("\n")),
      segments: normalizedSegments
    };
  }

  function emptyTranscript() {
    return {
      text: "",
      segments: []
    };
  }

  function getTrackLabel(track) {
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

  function languageMatches(languageCode, target) {
    if (!target) {
      return false;
    }
    return languageCode === target || languageCode.startsWith(`${target}-`);
  }

  function parseXmlTime(attributes, keys) {
    for (const key of keys) {
      const match = String(attributes || "").match(
        new RegExp(`${key}=["']([^"']+)["']`, "i")
      );
      if (!match) {
        continue;
      }

      const parsed = parseTimeExpression(match[1]);
      if (parsed !== null) {
        return parsed;
      }
    }
    return null;
  }

  function parseTimeExpression(value) {
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
    const parts = String(value || "")
      .split(":")
      .map((part) => part.trim());

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

  function toFiniteNumber(value) {
    const nextValue = Number(value);
    return Number.isFinite(nextValue) ? nextValue : null;
  }

  function summarizeTrack(track) {
    if (!track) {
      return null;
    }

    return {
      baseUrl: track.baseUrl || "",
      languageCode: track.languageCode || "",
      kind: track.kind || "",
      label: getTrackLabel(track)
    };
  }
})(globalThis);

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_SETTLE_MS = 8000;
const DEFAULT_TIMEOUT_MS = 120000;

const args = parseArgs(process.argv.slice(2));
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isDirectRun) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}

async function main() {
  if (!args.url) {
    throw new Error("Pass --url https://www.youtube.com/watch?v=...");
  }

  const browser = await chromium.launch({
    channel: "chromium",
    headless: process.env.PW_HEADLESS !== "0"
  });

  try {
    const page = await browser.newPage({
      viewport: {
        width: 1400,
        height: 1200
      }
    });
    const trace = attachTranscriptTrace(page);

    await page.goto(args.url, {
      waitUntil: "domcontentloaded",
      timeout: args.timeoutMs
    });
    await page.waitForTimeout(args.settleMs);

    const initial = await readPageState(page);
    const timedtext = await probeTimedtext(page);
    const bootstrapYoutubei = await probeBootstrapYoutubei(page);
    const internalContinuation = await probeInternalContinuation(page);
    await page.waitForTimeout(2500);
    const finalState = await readPageState(page);

    const report = {
      generatedAt: new Date().toISOString(),
      url: args.url,
      settleMs: args.settleMs,
      timeoutMs: args.timeoutMs,
      initial,
      timedtext,
      bootstrapYoutubei,
      internalContinuation,
      finalState,
      transcriptTrace: trace.read()
    };

    const output = JSON.stringify(report, null, 2);
    if (args.outPath) {
      fs.mkdirSync(path.dirname(args.outPath), { recursive: true });
      fs.writeFileSync(args.outPath, output);
      console.log(`Transcript debug report written to ${args.outPath}`);
      return;
    }

    console.log(output);
  } finally {
    await browser.close();
  }
}

function parseArgs(argv) {
  const parsed = {
    url: "",
    outPath: "",
    settleMs: DEFAULT_SETTLE_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--url") {
      parsed.url = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (token === "--out") {
      parsed.outPath = path.resolve(ROOT_DIR, String(argv[index + 1] || "").trim());
      index += 1;
      continue;
    }
    if (token === "--settle-ms") {
      parsed.settleMs = toPositiveInt(argv[index + 1], DEFAULT_SETTLE_MS);
      index += 1;
      continue;
    }
    if (token === "--timeout-ms") {
      parsed.timeoutMs = toPositiveInt(argv[index + 1], DEFAULT_TIMEOUT_MS);
      index += 1;
    }
  }

  return parsed;
}

function toPositiveInt(value, fallback) {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? next : fallback;
}

function attachTranscriptTrace(page) {
  const entries = [];
  const push = (entry) => {
    if (entries.length < 8) {
      entries.push(entry);
    }
  };

  const onRequest = (request) => {
    const url = String(request?.url?.() || "");
    if (!/\/youtubei\/v1\/get_transcript\b/i.test(url)) {
      return;
    }

    push({
      type: "request",
      url,
      method: request.method(),
      headers: summarizeHeaders(request.headers()),
      body: decodeRequestBody(request.headers(), request.postDataBuffer())
    });
  };

  const onResponse = async (response) => {
    const url = String(response?.url?.() || "");
    if (!/\/youtubei\/v1\/get_transcript\b/i.test(url)) {
      return;
    }

    let body = "";
    try {
      body = await response.text();
    } catch (error) {
      body = "";
    }

    push({
      type: "response",
      url,
      status: response.status(),
      ok: response.ok(),
      headers: summarizeHeaders(await response.allHeaders()),
      bodySnippet: truncateText(body, 600)
    });
  };

  page.on("request", onRequest);
  page.on("response", onResponse);

  return {
    read() {
      page.off("request", onRequest);
      page.off("response", onResponse);
      return entries.slice();
    }
  };
}

function summarizeHeaders(headers) {
  const input = headers && typeof headers === "object" ? headers : {};
  const keys = [
    "content-type",
    "content-encoding",
    "x-youtube-client-name",
    "x-youtube-client-version",
    "x-goog-visitor-id",
    "x-youtube-bootstrap-logged-in",
    "origin",
    "referer"
  ];

  return keys.reduce((output, key) => {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      output[key] = input[key];
    }
    return output;
  }, {});
}

function decodeRequestBody(headers, buffer) {
  if (!buffer || !buffer.length) {
    return null;
  }

  try {
    const contentEncoding = String(headers?.["content-encoding"] || "").toLowerCase();
    const contentType = String(headers?.["content-type"] || "").toLowerCase();
    const decodedBuffer = /gzip/.test(contentEncoding)
      ? zlib.gunzipSync(Buffer.from(buffer))
      : Buffer.from(buffer);
    const text = decodedBuffer.toString("utf8");

    if (!/application\/json/.test(contentType)) {
      return {
        raw: truncateText(text, 600)
      };
    }

    const parsed = JSON.parse(text);
    const client = parsed?.context?.client || {};
    return {
      topLevelKeys: Object.keys(parsed),
      paramsLength: String(parsed?.params || "").length,
      paramsStart: String(parsed?.params || "").slice(0, 80),
      languageCode: parsed?.languageCode || null,
      externalVideoId: parsed?.externalVideoId || null,
      client: {
        clientName: client.clientName || null,
        clientVersion: client.clientVersion || null,
        originalUrl: client.originalUrl || null,
        browserName: client.browserName || null,
        platform: client.platform || null,
        visitorDataPresent: Boolean(client.visitorData),
        attestationPresent: Boolean(parsed?.context?.request?.attestationResponseData),
        clickTrackingPresent: Boolean(parsed?.clickTracking?.clickTrackingParams),
        adSignalsCount: Array.isArray(parsed?.adSignalsInfo?.params)
          ? parsed.adSignalsInfo.params.length
          : 0
      }
    };
  } catch (error) {
    return {
      decodeError: error?.message || String(error)
    };
  }
}

async function readPageState(page) {
  return await page.evaluate(() => {
    const playerResponse = window.ytInitialPlayerResponse || {};
    const captionRenderer = playerResponse?.captions?.playerCaptionsTracklistRenderer || {};
    const tracks = Array.isArray(captionRenderer.captionTracks) ? captionRenderer.captionTracks : [];
    const ytcfg = window.ytcfg?.data_ || {};
    const panel = document.querySelector(
      "ytd-engagement-panel-section-list-renderer[target-id='engagement-panel-searchable-transcript']"
    );
    const data = panel?.__data?.data || panel?.data || null;

    function findTranscriptParams(source) {
      const queue = [source];
      const seen = new Set();

      while (queue.length) {
        const current = queue.shift();
        if (!current || typeof current !== "object" || seen.has(current)) {
          continue;
        }
        seen.add(current);

        if (current.getTranscriptEndpoint?.params) {
          return current.getTranscriptEndpoint.params;
        }

        if (
          current.showTranscriptButton?.buttonRenderer?.serviceEndpoint?.getTranscriptEndpoint?.params
        ) {
          return current.showTranscriptButton.buttonRenderer.serviceEndpoint.getTranscriptEndpoint.params;
        }

        Object.values(current).forEach((value) => {
          if (value && typeof value === "object") {
            queue.push(value);
          }
        });
      }

      return "";
    }

    return {
      title: document.title,
      videoId:
        playerResponse?.videoDetails?.videoId ||
        new URLSearchParams(location.search).get("v") ||
        "",
      captionTrackCount: tracks.length,
      defaultTrackBaseUrl: tracks[0]?.baseUrl || "",
      transcriptParamsPresent: Boolean(findTranscriptParams(window.ytInitialData || null)),
      apiKeyPresent: Boolean(ytcfg?.INNERTUBE_API_KEY),
      clientName:
        ytcfg?.INNERTUBE_CONTEXT?.client?.clientName ||
        ytcfg?.INNERTUBE_CONTEXT_CLIENT_NAME ||
        null,
      clientVersion:
        ytcfg?.INNERTUBE_CONTEXT?.client?.clientVersion ||
        ytcfg?.INNERTUBE_CLIENT_VERSION ||
        null,
      panelVisibility: panel?.getAttribute("visibility") || null,
      panelHasContinuation: Boolean(
        data?.content?.continuationItemRenderer?.continuationEndpoint
      ),
      visibleTranscriptSegments: document.querySelectorAll("ytd-transcript-segment-renderer").length
    };
  });
}

async function probeTimedtext(page) {
  return await page.evaluate(async () => {
    const playerResponse = window.ytInitialPlayerResponse || {};
    const captionRenderer = playerResponse?.captions?.playerCaptionsTracklistRenderer || {};
    const tracks = Array.isArray(captionRenderer.captionTracks) ? captionRenderer.captionTracks : [];
    const track = tracks[0] || null;

    if (!track?.baseUrl) {
      return {
        ok: false,
        error: "No caption track baseUrl found."
      };
    }

    const outputs = [];
    for (const format of [null, "json3", "srv3", "vtt"]) {
      const url = new URL(track.baseUrl);
      if (format) {
        url.searchParams.set("fmt", format);
      }

      const response = await fetch(url.toString(), {
        credentials: "include"
      });
      const text = await response.text();
      outputs.push({
        format: format || "default",
        status: response.status,
        ok: response.ok,
        contentType: response.headers.get("content-type") || "",
        textLength: text.length,
        textStart: text.slice(0, 200)
      });
    }

    return {
      ok: true,
      baseUrl: track.baseUrl,
      outputs
    };
  });
}

async function probeBootstrapYoutubei(page) {
  return await page.evaluate(async () => {
    const ytcfg = window.ytcfg?.data_ || {};
    const apiKey = ytcfg?.INNERTUBE_API_KEY || "";
    const context = ytcfg?.INNERTUBE_CONTEXT || null;

    function findTranscriptParams(source) {
      const queue = [source];
      const seen = new Set();

      while (queue.length) {
        const current = queue.shift();
        if (!current || typeof current !== "object" || seen.has(current)) {
          continue;
        }
        seen.add(current);

        if (current.getTranscriptEndpoint?.params) {
          return current.getTranscriptEndpoint.params;
        }

        if (
          current.showTranscriptButton?.buttonRenderer?.serviceEndpoint?.getTranscriptEndpoint?.params
        ) {
          return current.showTranscriptButton.buttonRenderer.serviceEndpoint.getTranscriptEndpoint.params;
        }

        Object.values(current).forEach((value) => {
          if (value && typeof value === "object") {
            queue.push(value);
          }
        });
      }

      return "";
    }

    const params = findTranscriptParams(window.ytInitialData || null);
    if (!apiKey || !context || !params) {
      return {
        ok: false,
        error: "Bootstrap apiKey, context, or transcript params are missing."
      };
    }

    const response = await fetch(
      `https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false&key=${encodeURIComponent(
        apiKey
      )}`,
      {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          "x-youtube-client-name": String(
            context?.client?.clientName ||
              ytcfg?.INNERTUBE_CONTEXT_CLIENT_NAME ||
              ""
          ),
          "x-youtube-client-version": String(
            context?.client?.clientVersion ||
              ytcfg?.INNERTUBE_CLIENT_VERSION ||
              ""
          )
        },
        body: JSON.stringify({
          context,
          params
        })
      }
    );

    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      paramsLength: params.length,
      paramsStart: params.slice(0, 80),
      bodySnippet: text.slice(0, 400)
    };
  });
}

async function probeInternalContinuation(page) {
  return await page.evaluate(async () => {
    const app = document.querySelector("ytd-app");
    const buttonRenderer = document.querySelector(
      "ytd-video-description-transcript-section-renderer ytd-button-renderer"
    );
    const showCommand = buttonRenderer?.__data?.data?.command || buttonRenderer?.data?.command || null;
    const panel = document.querySelector(
      "ytd-engagement-panel-section-list-renderer[target-id='engagement-panel-searchable-transcript']"
    );
    const data = panel?.__data?.data || panel?.data || null;
    const continuationEndpoint = data?.content?.continuationItemRenderer?.continuationEndpoint || null;

    const output = {
      hadApp: Boolean(app),
      hadShowCommand: Boolean(showCommand),
      hadContinuationEndpoint: Boolean(continuationEndpoint),
      panelVisibilityBefore: panel?.getAttribute("visibility") || null,
      visibleSegmentsBefore: document.querySelectorAll("ytd-transcript-segment-renderer").length
    };

    if (app && showCommand) {
      output.showResolved = await Promise.resolve(app.resolveCommand(showCommand)).catch(
        (error) => ({
          error: error?.message || String(error)
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }

    output.panelVisibilityAfterShow = panel?.getAttribute("visibility") || null;

    if (app && continuationEndpoint) {
      output.continuationResolved = await Promise.resolve(
        app.resolveCommand(continuationEndpoint)
      ).catch((error) => ({
        error: error?.message || String(error)
      }));
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    output.panelVisibilityAfterContinuation = panel?.getAttribute("visibility") || null;
    output.visibleSegmentsAfter = document.querySelectorAll("ytd-transcript-segment-renderer").length;
    return output;
  });
}

function truncateText(value, maxLength) {
  const text = String(value || "");
  if (!maxLength || text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

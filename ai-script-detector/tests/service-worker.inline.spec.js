const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { test, expect } = require("@playwright/test");

const ROOT_DIR = path.join(__dirname, "..");
const SERVICE_WORKER_PATH = path.join(ROOT_DIR, "service-worker.js");
const CONTRACTS_PATH = path.join(ROOT_DIR, "shared", "contracts.js");
const SERVICE_WORKER_REPORT_PATH = path.join(ROOT_DIR, "shared", "service-worker-report.js");

test.describe("ScriptLens inline runtime routing", () => {
  test("inline init prefers sender.tab over an explicit tabId", async () => {
    const { sandbox, calls } = loadServiceWorkerSandbox();

    const response = await sandbox.buildInlineInitResponse(
      {
        tabId: 999,
        windowId: 4
      },
      {
        tab: {
          id: 321,
          windowId: 7,
          url: "https://www.youtube.com/watch?v=sender123"
        }
      }
    );

    expect(calls.tabQueries).toBe(0);
    expect(calls.tabGets).toBe(0);
    expect(calls.tabMessages).toEqual([
      {
        tabId: 321,
        message: {
          type: "page:context"
        }
      }
    ]);
    expect(response.ok).toBeTruthy();
    expect(response.inlineSettings).toEqual({});
    expect(response.pageContext.tabId).toBe(321);
    expect(response.pageContext.windowId).toBe(7);
  });

  test("resolveContextTab falls back to the explicit tabId when no sender tab is available", async () => {
    const { sandbox, calls } = loadServiceWorkerSandbox();

    const tab = await sandbox.resolveContextTab(
      {
        tabId: 777,
        windowId: 12
      },
      {},
      true
    );

    expect(calls.tabGets).toBe(1);
    expect(calls.tabQueries).toBe(0);
    expect(tab.id).toBe(777);
    expect(tab.windowId).toBe(12);
  });

  test("inline youtube acquisition stays silent and skips DOM transcript loading", async () => {
    const { sandbox } = loadServiceWorkerSandbox();
    let capturedContext = null;

    sandbox.ScriptLens = {
      transcript: {
        acquire: {
          resolveBestTranscript: async (context) => {
            capturedContext = context;
            return {
              ok: true,
              text: "Transcript sample",
              sourceConfidence: "medium",
              acquisitionState: "transcript-acquired"
            };
          }
        },
        normalize: {
          buildUnavailableResult() {
            throw new Error("buildUnavailableResult should not be called in this test");
          }
        }
      }
    };

    const result = await sandbox.resolveYouTubeAcquisition(
      {
        title: "Sample video",
        videoId: "video123",
        videoDurationSeconds: 120
      },
      321,
      {
        includeSources: ["transcript"],
        trackBaseUrl: "",
        transcriptBias: "manual-en",
        requireTranscript: true,
        allowFallbackText: false
      },
      {
        maxTextLength: 18000
      },
      new AbortController().signal,
      "trace-inline",
      {
        surface: "inline",
        allowDomTranscriptLoader: false
      }
    );

    expect(result.ok).toBeTruthy();
    expect(capturedContext).toBeTruthy();
    expect(capturedContext.domTranscriptLoader).toBeNull();
    expect(capturedContext.analysisMode).toBe("youtube-transcript-first");
    expect(capturedContext.allowBackendTranscriptFallback).toBeUndefined();
    expect(capturedContext.backendEndpoint).toBeUndefined();
    expect(capturedContext.requestedLanguageCode).toBe("en");
  });

  test("prefers the selected caption track language for transcript acquisition", () => {
    const { sandbox } = loadServiceWorkerSandbox();
    sandbox.ScriptLens = {
      transcript: {
        strategies: {
          captionTrack: {
            pickPreferredTrack(tracks, options) {
              return tracks.find((track) => track.baseUrl === options.preferredTrackBaseUrl) || null;
            }
          }
        }
      }
    };

    const result = sandbox.resolveRequestedTranscriptLanguageCode(
      {
        bootstrapSnapshot: {
          captionTracks: [
            {
              baseUrl: "https://example.com/es",
              languageCode: "es",
              kind: ""
            },
            {
              baseUrl: "https://example.com/en",
              languageCode: "en",
              kind: ""
            }
          ]
        }
      },
      {
        trackBaseUrl: "https://example.com/en",
        transcriptBias: "manual-any"
      }
    );

    expect(result).toBe("en");
  });

  test("workspace youtube acquisition keeps DOM transcript loading available", async () => {
    const { sandbox } = loadServiceWorkerSandbox();
    let capturedContext = null;

    sandbox.ScriptLens = {
      transcript: {
        acquire: {
          resolveBestTranscript: async (context) => {
            capturedContext = context;
            return {
              ok: true,
              text: "Transcript sample",
              sourceConfidence: "medium",
              acquisitionState: "transcript-acquired"
            };
          }
        },
        normalize: {
          buildUnavailableResult() {
            throw new Error("buildUnavailableResult should not be called in this test");
          }
        }
      }
    };

    const result = await sandbox.resolveYouTubeAcquisition(
      {
        title: "Sample video",
        videoId: "video123",
        videoDurationSeconds: 120
      },
      321,
      {
        includeSources: ["transcript"],
        trackBaseUrl: "",
        transcriptBias: "manual-en",
        requireTranscript: true,
        allowFallbackText: false
      },
      {
        maxTextLength: 18000
      },
      new AbortController().signal,
      "trace-panel",
      {
        surface: "panel",
        allowDomTranscriptLoader: true
      }
    );

    expect(result.ok).toBeTruthy();
    expect(capturedContext).toBeTruthy();
    expect(typeof capturedContext.domTranscriptLoader).toBe("function");
  });

  test("workspace youtube acquisition exposes a page fetch helper for caption-track recovery", async () => {
    const { sandbox } = loadServiceWorkerSandbox();
    const extractionCalls = [];
    let capturedContext = null;
    let pageFetchResult = null;

    sandbox.requestTabExtraction = async (_tabId, message) => {
      extractionCalls.push(message);
      if (message?.type === "youtube:fetch-url") {
        return {
          ok: true,
          status: 200,
          contentType: "application/json",
          text: '{"events":[]}'
        };
      }
      throw new Error(`Unexpected extraction request: ${message?.type || "unknown"}`);
    };

    sandbox.ScriptLens = {
      transcript: {
        acquire: {
          resolveBestTranscript: async (context) => {
            capturedContext = context;
            pageFetchResult = await context.pageFetch({
              url: "https://www.youtube.com/api/timedtext?v=video123&lang=en"
            });
            return {
              ok: false,
              kind: "transcript",
              failureReason: "caption_fetch_failed",
              errors: [],
              resolverAttempts: [],
              resolverPath: ["youtubeResolver:caption-track"],
              winnerSelectedBy: []
            };
          }
        },
        normalize: {
          buildUnavailableResult(input) {
            return {
              ok: false,
              kind: "transcript",
              failureReason: input.failureReason || "caption_fetch_failed",
              resolverPath: input.resolverPath || [],
              errors: input.errors || [],
              resolverAttempts: input.resolverAttempts || [],
              winnerSelectedBy: input.winnerSelectedBy || [],
              sourceLabel: input.sourceLabel || "Transcript unavailable"
            };
          },
          stripInternalFields(value) {
            return value;
          }
        }
      }
    };

    await sandbox.resolveYouTubeAcquisition(
      {
        title: "Sample video",
        videoId: "video123",
        videoDurationSeconds: 120,
        description: ""
      },
      321,
      {
        includeSources: ["transcript"],
        requireTranscript: true,
        allowFallbackText: false
      },
      {
        maxTextLength: 18000
      },
      new AbortController().signal,
      "trace-page-fetch",
      {
        surface: "panel",
        allowDomTranscriptLoader: true
      }
    );

    expect(capturedContext).toBeTruthy();
    expect(typeof capturedContext.pageFetch).toBe("function");
    expect(pageFetchResult).toEqual({
      ok: true,
      status: 200,
      contentType: "application/json",
      text: '{"events":[]}'
    });
    expect(extractionCalls).toContainEqual({
      type: "youtube:fetch-url",
      url: "https://www.youtube.com/api/timedtext?v=video123&lang=en"
    });
  });

  test("keeps title and description fallback after a transcript failure", async () => {
    const { sandbox } = loadServiceWorkerSandbox();

    sandbox.ScriptLens = {
      transcript: {
        acquire: {
          resolveBestTranscript: async () => ({
            ok: false,
            kind: "transcript",
            failureReason: "caption_fetch_failed",
            errors: [],
            resolverAttempts: [],
            resolverPath: ["youtubeResolver:caption-track"],
            winnerSelectedBy: []
          })
        },
        normalize: {
          normalizeCandidate(raw) {
            return {
              ok: true,
              kind: "transcript",
              provider: "youtubeResolver",
              providerClass: "local",
              strategy: raw.strategy,
              sourceLabel: raw.sourceLabel,
              sourceConfidence: "low",
              quality: "weak-fallback",
              acquisitionState: "fallback-text-only",
              transcriptRequiredSatisfied: false,
              failureReason: null,
              warnings: raw.warnings || [],
              errors: [],
              resolverAttempts: [],
              resolverPath: [],
              winnerSelectedBy: [],
              text: raw.text
            };
          },
          buildUnavailableResult() {
            throw new Error("buildUnavailableResult should not be called in this test");
          },
          stripInternalFields(value) {
            return value;
          }
        }
      }
    };

    const result = await sandbox.resolveYouTubeAcquisition(
      {
        title: "Fallback sample video",
        description: "A fallback description that should still be used when the experiment is disabled.",
        videoDurationSeconds: 120,
        bootstrapSnapshot: {
          hl: "en"
        }
      },
      321,
      {
        includeSources: ["transcript", "description", "title"],
        requireTranscript: false,
        allowFallbackText: true
      },
      {
        maxTextLength: 18000
      },
      new AbortController().signal,
      "trace-title-description",
      {
        surface: "panel",
        allowDomTranscriptLoader: true
      }
    );

    expect(result.ok).toBeTruthy();
    expect(result.strategy).toBe("title-description");
    expect(result.sourceLabel).toBe("Title + description fallback");
  });

  test("does not request page extraction when transcript was never requested", async () => {
    const { sandbox } = loadServiceWorkerSandbox();
    const extractionCalls = [];

    sandbox.requestTabExtraction = async (_tabId, message) => {
      extractionCalls.push(message);
      return {
        ok: true,
        text: "Page extraction should not run for title-and-description-only requests."
      };
    };

    sandbox.ScriptLens = {
      transcript: {
        acquire: {
          resolveBestTranscript: async () => {
            throw new Error("resolveBestTranscript should not be called in this test");
          }
        },
        normalize: {
          normalizeCandidate(raw) {
            return {
              ok: true,
              kind: "transcript",
              provider: "youtubeResolver",
              providerClass: "local",
              strategy: raw.strategy,
              sourceLabel: raw.sourceLabel,
              sourceConfidence: "low",
              quality: "weak-fallback",
              acquisitionState: "fallback-text-only",
              transcriptRequiredSatisfied: false,
              failureReason: null,
              warnings: raw.warnings || [],
              errors: [],
              resolverAttempts: [],
              resolverPath: [],
              winnerSelectedBy: [],
              text: raw.text
            };
          },
          buildUnavailableResult() {
            throw new Error("buildUnavailableResult should not be called in this test");
          },
          stripInternalFields(value) {
            return value;
          }
        }
      }
    };

    const result = await sandbox.resolveYouTubeAcquisition(
      {
        title: "Fallback sample video",
        description: "A fallback description that should stay on the legacy title-description path.",
        videoDurationSeconds: 120,
        bootstrapSnapshot: {
          hl: "en"
        }
      },
      321,
      {
        includeSources: ["description", "title"],
        requireTranscript: true,
        allowFallbackText: false
      },
      {
        maxTextLength: 18000
      },
      new AbortController().signal,
      "trace-no-transcript-request",
      {
        surface: "panel",
        allowDomTranscriptLoader: true
      }
    );

    expect(result.ok).toBeTruthy();
    expect(result.strategy).toBe("title-description");
    expect(result.acquisitionState).toBe("fallback-text-only");
    expect(extractionCalls).toEqual([]);
  });

  test("returns an unscored transcript report when a transcript is too short to score", async () => {
    const { sandbox } = loadServiceWorkerSandbox();
    sandbox.requestTabExtraction = async (_tabId, message) => {
      if (message?.type === "youtube:page-adapter") {
        return {
          ok: true,
          adapter: {
            title: "Me at the zoo",
            videoId: "jNQXAC9IVRw",
            videoDurationSeconds: 19,
            bootstrapSnapshot: {
              captionTracks: [
                {
                  baseUrl: "https://example.com/en",
                  languageCode: "en",
                  kind: ""
                }
              ]
            }
          }
        };
      }
      throw new Error(`Unexpected extraction request: ${message?.type || "unknown"}`);
    };
    sandbox.getTabById = async () => ({
      id: 321,
      url: "https://www.youtube.com/watch?v=jNQXAC9IVRw"
    });
    sandbox.resolveYouTubeAcquisition = async () => ({
      ok: true,
      kind: "transcript",
      providerClass: "local",
      sourceLabel: "Caption track",
      sourceConfidence: "high",
      quality: "strong-transcript",
      acquisitionState: "transcript-acquired",
      originKind: "manual_caption_track",
      winnerReason: "quality-eligible:manual_caption_track",
      languageCode: "en",
      text: "All right, so here we are in front of the elephants, and the cool thing about these guys is that they have really, really, really long trunks, and that's cool, and that's pretty much all there is to say."
    });
    sandbox.AIScriptDetector = sandbox.AIScriptDetector || {};
    sandbox.AIScriptDetector.detect = {
      runDetection() {
        return {
          ok: false,
          error:
            "The text is too short for a useful heuristic read. Try at least 40 words or 180 characters."
        };
      }
    };

    const result = await sandbox.analyzeYouTube(
      {
        id: 321,
        url: "https://www.youtube.com/watch?v=jNQXAC9IVRw"
      },
      {
        mode: "youtube",
        includeSources: ["transcript"],
        requireTranscript: true,
        allowFallbackText: false,
        trackBaseUrl: "https://example.com/en"
      },
      {
        sensitivity: "medium",
        maxTextLength: 18000,
        minCharacters: 180,
        minWords: 40
      },
      "trace-inline-short",
      {
        surface: "inline",
        allowDomTranscriptLoader: false
      }
    );

    expect(result.ok).toBeTruthy();
    expect(result.report.scoringStatus).toBe("insufficient-input");
    expect(result.report.contractVersion).toBe("2026-09-27");
    expect(result.report.verdict).toBe("Not enough spoken text");
    expect(result.report.score).toBeNull();
    expect(result.report.scoringSummary).toContain("does not contain enough spoken text");
  });

  test("openWorkspace saves the launch request before a blocked side-panel open", async () => {
    const { sandbox, calls, sessionStorageState } = loadServiceWorkerSandbox({
      sidePanelOpenError: "The side panel could not be opened."
    });

    const response = await sandbox.openWorkspace(
      {
        request: {
          mode: "youtube",
          includeSources: ["transcript"],
          trackBaseUrl: "",
          requireTranscript: true,
          allowFallbackText: false
        }
      },
      {
        tab: {
          id: 321,
          windowId: 7,
          url: "https://www.youtube.com/watch?v=sender123"
        }
      }
    );

    expect(calls.sidePanelOpens).toBe(1);
    expect(response.ok).toBeFalsy();
    expect(response.error).toContain("toolbar icon");
    expect(response.launchRequest.mode).toBe("youtube");
    expect(sessionStorageState.panelLaunchRequest).toBeTruthy();
    expect(sessionStorageState.panelLaunchRequest.tabId).toBe(321);
    expect(sessionStorageState.panelLaunchRequest.request.mode).toBe("youtube");
  });
});

function loadServiceWorkerSandbox(options = {}) {
  const calls = {
    tabQueries: 0,
    tabGets: 0,
    tabMessages: [],
    sidePanelOpens: 0
  };
  const localStorageState = {
    settings: {
      sensitivity: "medium",
      maxTextLength: 18000,
      minCharacters: 180,
      minWords: 40,
      recentReportsLimit: 5,
      debugMode: false
    }
  };
  const sessionStorageState = {};

  const sandbox = {
    console,
    URL,
    URLSearchParams,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: async () => {
      throw new Error("fetch not stubbed");
    },
    importScripts() {},
    chrome: {
      runtime: {
        lastError: null,
        onInstalled: {
          addListener() {}
        },
        onMessage: {
          addListener() {}
        },
        getManifest() {
          return { version: "0.1.0" };
        }
      },
      storage: {
        local: {
          get(_keys, callback) {
            callback(localStorageState);
          },
          set(value, callback) {
            Object.assign(localStorageState, value);
            callback();
          }
        },
        session: {
          get(_keys, callback) {
            callback(sessionStorageState);
          },
          set(value, callback) {
            Object.assign(sessionStorageState, value);
            callback();
          },
          remove(keys, callback) {
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              delete sessionStorageState[key];
            }
            callback();
          }
        }
      },
      tabs: {
        query(_queryInfo, callback) {
          calls.tabQueries += 1;
          callback([
            {
              id: 111,
              windowId: 2,
              url: "https://www.youtube.com/watch?v=active999"
            }
          ]);
        },
        get(tabId, callback) {
          calls.tabGets += 1;
          callback({
            id: tabId,
            windowId: 12,
            url: `https://www.youtube.com/watch?v=${tabId}`
          });
        },
        sendMessage(tabId, message, callback) {
          calls.tabMessages.push({ tabId, message });
          callback({
            ok: true,
            context: {
              supported: true,
              hostname: "youtube.com",
              isYouTubeVideo: true,
              video: {
                availableSources: {
                  transcript: true,
                  description: true,
                  title: true
                },
                defaultTrackBaseUrl: "",
                transcriptTracks: []
              }
            }
          });
        }
      },
      sidePanel: {
        open(_options, callback) {
          calls.sidePanelOpens += 1;
          if (options.sidePanelOpenError) {
            sandbox.chrome.runtime.lastError = {
              message: options.sidePanelOpenError
            };
            callback();
            sandbox.chrome.runtime.lastError = null;
            return;
          }
          callback();
        }
      }
    },
    ScriptLensRuntimeConfig: options.runtimeConfig || {},
    globalThis: {}
  };

  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CONTRACTS_PATH, "utf8"), sandbox, {
    filename: CONTRACTS_PATH
  });
  const policyPath = path.join(ROOT_DIR, "transcript", "policy.js");
  vm.runInContext(fs.readFileSync(policyPath, "utf8"), sandbox, {
    filename: policyPath
  });
  vm.runInContext(fs.readFileSync(SERVICE_WORKER_REPORT_PATH, "utf8"), sandbox, {
    filename: SERVICE_WORKER_REPORT_PATH
  });
  vm.runInContext(fs.readFileSync(SERVICE_WORKER_PATH, "utf8"), sandbox, {
    filename: SERVICE_WORKER_PATH
  });

  return { sandbox, calls, sessionStorageState };
}

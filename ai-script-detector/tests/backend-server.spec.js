const { test, expect } = require("@playwright/test");
const { createBackendServer, resolveBackendRuntimeConfig } = require("../backend/server");
const Policy = require("../transcript/policy");

test.describe("ScriptLens backend HTTP server", () => {
  test("serves Cloud Run health and version routes", async () => {
    const server = createBackendServer();

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const health = await fetch(`${baseUrl}/healthz`).then((response) => response.json());
      const version = await fetch(`${baseUrl}/version`).then((response) => response.json());

      expect(health.ok).toBeTruthy();
      expect(health.service).toBe("scriptlens-backend");
      expect(health.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(health.contractVersion).toBe("2026-03-11");
      expect(health.asrEnabled).toBeFalsy();
      expect(health.capabilities).toBeTruthy();
      expect(health.capabilities).toHaveProperty("ytDlp");
      expect(health.capabilities).toHaveProperty("asr");
      expect(health.capabilities).toHaveProperty("auth");

      expect(version.service).toBe("scriptlens-backend");
      expect(version.version).toBe(health.version);
      expect(version.contractVersion).toBe("2026-03-11");
      expect(version.asrEnabled).toBeFalsy();
      expect(version.capabilities).toEqual(health.capabilities);
    } finally {
      await closeServer(server);
    }
  });

  test("reports capability metadata for configured backend helpers", async () => {
    const server = createBackendServer({
      enableAutomaticAsr: true,
      ytDlpCommand: [process.execPath, "-e", "process.exit(0)", "--"],
      asrCommand: [process.execPath, "-e", "process.exit(0)"],
      policyOverrides: {
        backend: {
          auth: {
            mode: "cookie-file",
            cookieFilePath: "/var/run/secrets/youtube-cookies.txt",
            useForYtDlp: true,
            useForBrowserSession: false
          }
        }
      }
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const version = await fetch(`${baseUrl}/version`).then((response) => response.json());

      expect(version.authenticatedModeEnabled).toBeTruthy();
      expect(version.asrEnabled).toBeTruthy();
      expect(version.capabilities.auth.enabled).toBeTruthy();
      expect(version.capabilities.auth.cookieFileConfigured).toBeTruthy();
      expect(version.capabilities.ytDlp.available).toBeTruthy();
      expect(version.capabilities.ytDlp.source).toBe("custom-command");
      expect(version.capabilities.ytDlp.command).toMatch(/^node(\.exe)?$/);
      expect(version.capabilities.ytDlp.useCookies).toBeTruthy();
      expect(version.capabilities.asr.enabled).toBeTruthy();
      expect(version.capabilities.asr.configured).toBeTruthy();
      expect(version.capabilities.asr.source).toBe("custom-command");
      expect(version.capabilities.asr.command).toMatch(/^node(\.exe)?$/);
    } finally {
      await closeServer(server);
    }
  });

  test("reports headless capability in health and version responses", async () => {
    const server = createBackendServer();

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const health = await fetch(`${baseUrl}/healthz`).then((response) => response.json());
      const version = await fetch(`${baseUrl}/version`).then((response) => response.json());

      expect(health.capabilities).toHaveProperty("headless");
      expect(typeof health.capabilities.headless.executablePresent).toBe("boolean");
      expect(version.capabilities.headless).toEqual(health.capabilities.headless);
    } finally {
      await closeServer(server);
    }
  });

  test("serves transcript requests without aborting normal clients", async () => {
    const html = buildWatchHtml({
      playerResponse: {
        videoDetails: {
          lengthSeconds: "360"
        },
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [
              {
                baseUrl: "https://captions.example/manual",
                languageCode: "en",
                kind: "",
                name: { simpleText: "English" }
              }
            ]
          }
        }
      }
    });

    const server = createBackendServer({
      policyOverrides: {
        timeouts: {
          backendStage: {
            watchPageMs: 50,
            youtubeiMs: 50,
            ytDlpMs: 50,
            headlessMs: 50
          }
        }
      },
      fetchImpl: async (url) => {
        if (/youtube\.com\/watch/.test(String(url))) {
          return makeTextResponse(html);
        }
        if (String(url).startsWith("https://captions.example/manual")) {
          return makeTextResponse(
            JSON.stringify({
              events: Array.from({ length: 20 }, (_, index) => ({
                tStartMs: index * 18000,
                dDurationMs: 17000,
                segs: [
                  {
                    utf8: `Caption segment ${index + 1} keeps the HTTP server on a transcript-class source.`
                  }
                ]
              }))
            })
          );
        }
        throw new Error(`Unexpected URL: ${url}`);
      }
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}/transcript/resolve`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          url: "https://www.youtube.com/watch?v=abc123xyz78",
          requestedLanguageCode: "en",
          includeTimestamps: true
        })
      });
      const payload = await response.json();

      expect(response.ok).toBeTruthy();
      expect(payload.ok).toBeTruthy();
      expect(payload.contractVersion).toBe("2026-03-11");
      expect(payload.errorCode).toBeUndefined();
      expect(payload.providerClass).toBe("backend");
      expect(payload.sourceLabel).toContain("caption");
      expect(payload.warnings).toContain("backend_static_caption_track");
    } finally {
      await closeServer(server);
    }
  });

  test("caches successful transcript recovery responses", async () => {
    let fetchCount = 0;
    const html = buildWatchHtml({
      playerResponse: {
        videoDetails: {
          lengthSeconds: "360"
        },
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [
              {
                baseUrl: "https://captions.example/manual",
                languageCode: "en",
                kind: "",
                name: { simpleText: "English" }
              }
            ]
          }
        }
      }
    });

    const server = createBackendServer({
      fetchImpl: async (url) => {
        fetchCount += 1;
        if (/youtube\.com\/watch/.test(String(url))) {
          return makeTextResponse(html);
        }
        if (String(url).startsWith("https://captions.example/manual")) {
          return makeTextResponse(
            JSON.stringify({
              events: Array.from({ length: 18 }, (_, index) => ({
                tStartMs: index * 18000,
                dDurationMs: 17000,
                segs: [
                  {
                    utf8: `Cached caption segment ${index + 1} stays stable enough to produce a reusable transcript result.`
                  }
                ]
              }))
            })
          );
        }
        throw new Error(`Unexpected URL: ${url}`);
      }
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}/transcript/resolve`;
    const body = {
      url: "https://www.youtube.com/watch?v=cache123xyz9",
      requestedLanguageCode: "en",
      clientInstanceId: "cache-client"
    };

    try {
      const first = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      }).then((response) => response.json());
      const second = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      }).then((response) => response.json());

      expect(first.ok).toBeTruthy();
      expect(second.ok).toBeTruthy();
      expect(fetchCount).toBe(2);
      expect(second.stageTelemetry?.[0]?.type).toBe("cache");
      expect(second.stageTelemetry?.[0]?.cacheStatus).toBe("hit");
    } finally {
      await closeServer(server);
    }
  });

  test("rate limits repeated recovery requests per client", async () => {
    const html = buildWatchHtml({
      playerResponse: {
        videoDetails: {
          lengthSeconds: "360"
        },
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [
              {
                baseUrl: "https://captions.example/rate-limit",
                languageCode: "en",
                kind: "",
                name: { simpleText: "English" }
              }
            ]
          }
        }
      }
    });

    const server = createBackendServer({
      policyOverrides: {
        backend: {
          rateLimit: {
            recoveryRequests: {
              limit: 1,
              windowMs: 60000
            }
          },
          cacheTtlMs: {
            transcriptSuccess: 0,
            asrSuccess: 0,
            unavailable: 0
          }
        }
      },
      fetchImpl: async (url) => {
        if (/youtube\.com\/watch/.test(String(url))) {
          return makeTextResponse(html);
        }
        if (String(url).startsWith("https://captions.example/rate-limit")) {
          return makeTextResponse(
            JSON.stringify({
              events: Array.from({ length: 18 }, (_, index) => ({
                tStartMs: index * 12000,
                dDurationMs: 11000,
                segs: [
                  {
                    utf8: `Rate limit transcript ${index + 1} keeps the first request fast enough to gate the second request.`
                  }
                ]
              }))
            })
          );
        }
        throw new Error(`Unexpected URL: ${url}`);
      }
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}/transcript/resolve`;

    try {
      const first = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: "https://www.youtube.com/watch?v=rate1111111",
          clientInstanceId: "rate-client"
        })
      });
      const second = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: "https://www.youtube.com/watch?v=rate2222222",
          clientInstanceId: "rate-client"
        })
      });
      const payload = await second.json();

      expect(first.ok).toBeTruthy();
      expect(second.status).toBe(429);
      expect(payload.ok).toBeFalsy();
      expect(payload.errorCode).toBe("rate_limited");
      expect(payload.failureCategory).toBe("policy");
    } finally {
      await closeServer(server);
    }
  });

  test("keeps transcript recovery available when the ASR circuit breaker is forced open", async () => {
    const html = buildWatchHtml({
      playerResponse: {
        videoDetails: {
          lengthSeconds: "360"
        },
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [
              {
                baseUrl: "https://captions.example/manual",
                languageCode: "en",
                kind: "",
                name: { simpleText: "English" }
              }
            ]
          }
        }
      }
    });

    const server = createBackendServer({
      policyOverrides: {
        backend: {
          circuitBreaker: {
            forcedOpen: true
          }
        }
      },
      fetchImpl: async (url) => {
        if (/youtube\.com\/watch/.test(String(url))) {
          return makeTextResponse(html);
        }
        if (String(url).startsWith("https://captions.example/manual")) {
          return makeTextResponse(
            JSON.stringify({
              events: Array.from({ length: 18 }, (_, index) => ({
                tStartMs: index * 18000,
                dDurationMs: 17000,
                segs: [
                  {
                    utf8: `Circuit-safe caption segment ${index + 1} still gives transcript recovery a valid source.`
                  }
                ]
              }))
            })
          );
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
      asrResolver: async () => ({
        ok: true,
        text: "This ASR path should not run.",
        segments: []
      })
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}/transcript/resolve`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: "https://www.youtube.com/watch?v=circuit12345",
          requestedLanguageCode: "en",
          allowAutomaticAsr: true,
          clientInstanceId: "circuit-client"
        })
      });
      const payload = await response.json();

      expect(response.ok).toBeTruthy();
      expect(payload.ok).toBeTruthy();
      expect(payload.originKind).toBe("manual_caption_track");
      expect(payload.recoveryTier).toBe("hosted_transcript");
    } finally {
      await closeServer(server);
    }
  });

  test("keeps automatic ASR disabled by default even when a request asks for it", async () => {
    const runtimeConfig = resolveBackendRuntimeConfig();

    expect(runtimeConfig.enableAutomaticAsr).toBeFalsy();
  });

  test("reads production timeout and headless overrides from environment", async () => {
    await withEnv(
      {
        SCRIPTLENS_BACKEND_TRANSCRIPT_TIMEOUT_MS: "31000",
        SCRIPTLENS_BACKEND_ASR_TIMEOUT_MS: "62000",
        SCRIPTLENS_BACKEND_STAGE_YTDLP_MS: "12500",
        SCRIPTLENS_BACKEND_STAGE_ASR_MS: "32000",
        SCRIPTLENS_BACKEND_HEADLESS_NAVIGATION_TIMEOUT_MS: "16000",
        SCRIPTLENS_BACKEND_HEADLESS_TRANSCRIPT_WAIT_MS: "6100",
        SCRIPTLENS_BACKEND_HEADLESS_SETTLE_MS: "1700",
        SCRIPTLENS_BACKEND_HEADLESS_EXTRA_ARGS: "--remote-debugging-pipe,--font-render-hinting=none",
        SCRIPTLENS_BACKEND_ASR_AUTO_MAX_SECONDS: "900",
        SCRIPTLENS_BACKEND_ASR_MANUAL_MAX_SECONDS: "1800",
        SCRIPTLENS_BACKEND_ASR_ABSOLUTE_MAX_SECONDS: "2400",
        SCRIPTLENS_BACKEND_ASR_ALLOW_UNKNOWN_DURATION: "true",
        SCRIPTLENS_BACKEND_ASR_CIRCUIT_FORCED_OPEN: "true"
      },
      async () => {
        const runtimeConfig = resolveBackendRuntimeConfig();
        const resolvedPolicy = Policy.resolvePolicy(runtimeConfig.policyOverrides);

        expect(runtimeConfig.policyOverrides.timeouts.backendTranscriptMs).toBe(31000);
        expect(runtimeConfig.policyOverrides.timeouts.backendAsrMs).toBe(62000);
        expect(runtimeConfig.policyOverrides.timeouts.backendStage.ytDlpMs).toBe(12500);
        expect(runtimeConfig.policyOverrides.timeouts.backendStage.asrMs).toBe(32000);
        expect(resolvedPolicy.timeouts.backendTranscriptMs).toBe(31000);
        expect(resolvedPolicy.timeouts.backendAsrMs).toBe(62000);
        expect(resolvedPolicy.timeouts.backendStage.ytDlpMs).toBe(12500);
        expect(resolvedPolicy.timeouts.backendStage.asrMs).toBe(32000);
        expect(resolvedPolicy.backend.headless.navigationTimeoutMs).toBe(16000);
        expect(resolvedPolicy.backend.headless.transcriptWaitMs).toBe(6100);
        expect(resolvedPolicy.backend.headless.settleMs).toBe(1700);
        expect(resolvedPolicy.backend.headless.extraLaunchArgs).toEqual([
          "--remote-debugging-pipe",
          "--font-render-hinting=none"
        ]);
        expect(resolvedPolicy.backend.maxVideoLengthSeconds.automaticAsr).toBe(900);
        expect(resolvedPolicy.backend.maxVideoLengthSeconds.manualAsr).toBe(1800);
        expect(resolvedPolicy.backend.maxVideoLengthSeconds.absolute).toBe(2400);
        expect(resolvedPolicy.backend.allowAutomaticAsrWithoutKnownDuration).toBeTruthy();
        expect(resolvedPolicy.backend.circuitBreaker.forcedOpen).toBeTruthy();
      }
    );
  });

  test("reads authenticated acquisition overrides from environment", async () => {
    await withEnv(
      {
        SCRIPTLENS_BACKEND_AUTH_MODE: "cookie-file",
        SCRIPTLENS_BACKEND_YOUTUBE_COOKIE_FILE: "/var/run/secrets/youtube-cookies.txt",
        SCRIPTLENS_BACKEND_AUTH_USE_YTDLP: "true",
        SCRIPTLENS_BACKEND_AUTH_USE_BROWSER_SESSION: "false"
      },
      async () => {
        const runtimeConfig = resolveBackendRuntimeConfig();

        expect(runtimeConfig.authenticatedModeEnabled).toBeTruthy();
        expect(runtimeConfig.policyOverrides.backend.auth.mode).toBe("cookie-file");
        expect(runtimeConfig.policyOverrides.backend.auth.cookieFilePath).toBe(
          "/var/run/secrets/youtube-cookies.txt"
        );
        expect(runtimeConfig.policyOverrides.backend.auth.useForYtDlp).toBeTruthy();
        expect(runtimeConfig.policyOverrides.backend.auth.useForBrowserSession).toBeFalsy();
      }
    );
  });

  test("keeps cookie-file paths out of response telemetry and backend logs", async () => {
    const cookieFilePath = "C:\\secret\\youtube-cookies.txt";
    const html = buildWatchHtml({
      playerResponse: {
        videoDetails: {
          lengthSeconds: "180"
        }
      }
    });
    const ytDlpScript = "process.stderr.write('auth path consumed'); process.exit(1);";
    const originalWrite = process.stdout.write;
    const logs = [];
    process.stdout.write = (chunk, ...args) => {
      logs.push(String(chunk || ""));
      return typeof originalWrite === "function"
        ? originalWrite.call(process.stdout, chunk, ...args)
        : true;
    };

    const server = createBackendServer({
      policyOverrides: {
        backend: {
          auth: {
            mode: "cookie-file",
            cookieFilePath,
            useForYtDlp: true,
            useForBrowserSession: false
          }
        }
      },
      fetchImpl: async (url) => {
        if (/youtube\.com\/watch/.test(String(url))) {
          return makeTextResponse(html);
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
      ytDlpCommand: [process.execPath, "-e", ytDlpScript, "--"],
      headlessResolver: async () => ({
        ok: false,
        errorCode: "backend_headless_failed",
        errorMessage: "No headless transcript."
      })
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}/transcript/resolve`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: "https://www.youtube.com/watch?v=authmask1234",
          requestedLanguageCode: "en",
          allowAutomaticAsr: false
        })
      });
      const payload = await response.json();
      const ytDlpStage = payload.stageTelemetry.find((entry) => entry.stage === "yt-dlp-captions");
      const logOutput = logs.join("\n");

      expect(payload.ok).toBeFalsy();
      expect(payload.authenticatedModeEnabled).toBeTruthy();
      expect(ytDlpStage?.detail?.attempts?.[0]?.args).toContain("[redacted]");
      expect(JSON.stringify(payload)).not.toContain(cookieFilePath);
      expect(logOutput).not.toContain(cookieFilePath);
    } finally {
      process.stdout.write = originalWrite;
      await closeServer(server);
    }
  });

  test("uses the env-derived server timeout budget for transcript requests", async () => {
    await withEnv(
      {
        SCRIPTLENS_BACKEND_TIMEOUT_MS: "1200"
      },
      async () => {
        const runtimeConfig = resolveBackendRuntimeConfig();

        expect(runtimeConfig.totalTimeoutMs).toBe(1200);
      }
    );
  });
});

function buildWatchHtml({ playerResponse = {}, initialData = {}, ytcfg = {} }) {
  return `<!doctype html>
  <html lang="en">
    <head><meta charset="utf-8"><title>ScriptLens test video</title></head>
    <body>
      <script>var ytInitialPlayerResponse = ${JSON.stringify(playerResponse)};</script>
      <script>var ytInitialData = ${JSON.stringify(initialData)};</script>
      <script>ytcfg.set(${JSON.stringify(ytcfg)});</script>
    </body>
  </html>`;
}

function makeTextResponse(text) {
  return {
    ok: true,
    status: 200,
    text: async () => text
  };
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function withEnv(overrides, callback) {
  const previousValues = {};
  Object.keys(overrides || {}).forEach((key) => {
    previousValues[key] = Object.prototype.hasOwnProperty.call(process.env, key)
      ? process.env[key]
      : undefined;
    process.env[key] = overrides[key];
  });

  try {
    return await callback();
  } finally {
    Object.keys(overrides || {}).forEach((key) => {
      if (previousValues[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previousValues[key];
      }
    });
  }
}

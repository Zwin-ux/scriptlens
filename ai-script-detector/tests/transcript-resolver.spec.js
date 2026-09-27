const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { test, expect } = require("@playwright/test");

const ROOT_DIR = path.resolve(__dirname, "..");
const FILES = [
  "utils/text.js",
  "utils/stats.js",
  "detector/patterns.js",
  "detector/heuristics.js",
  "detector/scoring.js",
  "detector/analyze.js",
  "detector/detect.js",
  "transcript/policy.js",
  "transcript/normalize.js",
  "transcript/strategies/youtubei.js",
  "transcript/strategies/captionTrack.js",
  "transcript/strategies/domTranscript.js",
  "transcript/providers/youtubeResolver.js",
  "transcript/acquire.js"
];

test.describe("ScriptLens transcript resolver contracts", () => {
  test("keeps title-description fallback out of transcript-style segmentation", () => {
    const sandbox = loadSandbox();
    const result = sandbox.ScriptLens.transcript.normalize.normalizeCandidate(
      {
        ok: true,
        provider: "youtubeResolver",
        strategy: "title-description",
        sourceLabel: "Title + description fallback",
        text: "Movie recap title.\n\nA short fallback description.",
        warnings: ["fallback_source", "weak_evidence"]
      },
      {
        maxTextLength: 18000
      }
    );

    expect(result.kind).toBe("transcript");
    expect(result.strategy).toBe("title-description");
    expect(result.segmentCount).toBe(0);
    expect(result.segments).toEqual([]);
    expect(result.avgSegmentLength).toBeNull();
    expect(result.transcriptSpanSeconds).toBeNull();
    expect(result.quality).toBe("weak-fallback");
  });

  test("normalizes article content as a direct acquisition with no transcript provider", () => {
    const sandbox = loadSandbox();
    const articleText = Array.from({ length: 40 }, (_, index) => {
      return `Paragraph ${index + 1} explains a concrete event with dates, places, and multiple supporting details.`;
    }).join("\n\n");

    const result = sandbox.ScriptLens.transcript.normalize.normalizeDirectAcquisition(
      {
        kind: "article-content",
        sourceLabel: "Article content",
        text: articleText,
        coverageRatio: 0.42,
        blockCount: 18
      },
      {
        maxTextLength: 18000
      }
    );

    expect(result.ok).toBeTruthy();
    expect(result.kind).toBe("article-content");
    expect(result.provider).toBeNull();
    expect(result.strategy).toBeNull();
    expect(result.quality).toBe("strong-transcript");
    expect(result.sourceConfidence).toBe("high");
    expect(result).not.toHaveProperty("recoveryTier");
    expect(result.originKind).toBeNull();
    expect(result.sourceTrustTier).toBeNull();
    expect(result.segmentCount).toBe(0);
    expect(result.segments).toEqual([]);
  });

  test("prefers canonical language over translated when source class is otherwise similar", () => {
    const sandbox = loadSandbox();
    const normalize = sandbox.ScriptLens.transcript.normalize;

    const original = normalize.normalizeCandidate(
      buildCaptionCandidate({
        languageCode: "en",
        originalLanguageCode: "en",
        isTranslated: false,
        isMachineTranslated: false,
        isGenerated: false
      }),
      { maxTextLength: 18000 }
    );
    const translated = normalize.normalizeCandidate(
      buildCaptionCandidate({
        languageCode: "en",
        originalLanguageCode: "es",
        isTranslated: true,
        isMachineTranslated: true,
        isGenerated: false
      }),
      { maxTextLength: 18000 }
    );

    const comparison = normalize.compareCandidates(original, translated);
    expect(comparison.winner.languageCode).toBe("en");
    expect(comparison.winner.originalLanguageCode).toBe("en");
    expect(comparison.reasons[0]).toMatch(/^language-preference:/);
  });

  test("rejects transcript candidates when the requested language materially mismatches", () => {
    const sandbox = loadSandbox();
    const normalize = sandbox.ScriptLens.transcript.normalize;

    const mismatched = normalize.normalizeCandidate(
      buildCaptionCandidate({
        requestedLanguageCode: "en",
        languageCode: "fr",
        originalLanguageCode: "fr",
        isTranslated: false,
        isMachineTranslated: false
      }),
      {
        maxTextLength: 18000,
        requestedLanguageCode: "en"
      }
    );

    expect(mismatched.qualityGate.eligible).toBeFalsy();
    expect(mismatched.qualityGate.rejectedReasons).toContain("language_mismatch");
  });

  test("prefers manual caption tracks over generated ones when selecting a track", () => {
    const sandbox = loadSandbox();
    const track = sandbox.ScriptLens.transcript.strategies.captionTrack.pickPreferredTrack(
      [
        {
          baseUrl: "https://example.com/generated",
          languageCode: "en",
          kind: "asr",
          name: { simpleText: "English" }
        },
        {
          baseUrl: "https://example.com/manual",
          languageCode: "en",
          kind: "",
          name: { simpleText: "English" }
        }
      ],
      {
        preferredBias: "manual-en",
        requestedLanguageCode: null,
        preferredTrackBaseUrl: ""
      }
    );

    expect(track.baseUrl).toBe("https://example.com/manual");
  });

  test("reads a youtubei transcript successfully when bootstrap metadata is complete", async () => {
    const sandbox = loadSandbox({
      fetch: async () => ({
        ok: true,
        json: async () => ({
          languageCode: "en",
          actions: [
            {
              updateEngagementPanelAction: {
                content: {
                  transcriptRenderer: {
                    content: {
                      transcriptSearchPanelRenderer: {
                        body: {
                          transcriptSegmentListRenderer: {
                            initialSegments: [
                              {
                                transcriptSegmentRenderer: {
                                  startMs: "0",
                                  durationMs: "2500",
                                  snippet: {
                                    runs: [{ text: "This transcript line contains enough words to be usable." }]
                                  }
                                }
                              },
                              {
                                transcriptSegmentRenderer: {
                                  startMs: "2500",
                                  durationMs: "2500",
                                  snippet: {
                                    runs: [{ text: "The second line keeps the structure deterministic and explainable." }]
                                  }
                                }
                              }
                            ]
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          ]
        })
      })
    });

    const result = await sandbox.ScriptLens.transcript.strategies.youtubei.run({
      adapter: {
        videoDurationSeconds: 120,
        bootstrapSnapshot: {
          apiKey: "test-key",
          clientContext: {
            client: {
              clientName: "WEB",
              clientVersion: "2.20260307.01.00"
            }
          },
          transcriptParams: "test-params",
          hl: "en"
        }
      },
      signal: new AbortController().signal
    });

    expect(result.ok).toBeTruthy();
    expect(result.strategy).toBe("youtubei-transcript");
    expect(result.languageCode).toBe("en");
    expect(result.text).toContain("This transcript line");
    expect(result.segments.length).toBe(2);
  });

  test("classifies youtubei FAILED_PRECONDITION as a transcript failure", async () => {
    const sandbox = loadSandbox({
      fetch: async () => ({
        ok: false,
        status: 400,
        json: async () => ({
          error: {
            status: "FAILED_PRECONDITION",
            message: "FAILED_PRECONDITION"
          }
        })
      })
    });

    const result = await sandbox.ScriptLens.transcript.strategies.youtubei.run({
      adapter: {
        bootstrapSnapshot: {
          apiKey: "test-key",
          clientContext: {
            client: {
              clientName: "WEB",
              clientVersion: "2.20260307.01.00"
            }
          },
          transcriptParams: "test-params",
          hl: "en"
        }
      },
      signal: new AbortController().signal
    });

    expect(result.ok).toBeFalsy();
    expect(result.errorCode).toBe("youtubei_failed_precondition");

    const unavailable = sandbox.ScriptLens.transcript.normalize.buildUnavailableResult({
      provider: "youtubeResolver",
      strategy: "youtubei-transcript",
      errors: [
        {
          provider: "youtubeResolver",
          strategy: "youtubei-transcript",
          code: result.errorCode,
          message: result.errorMessage
        }
      ],
      resolverAttempts: [
        {
          provider: "youtubeResolver",
          strategy: "youtubei-transcript",
          ok: false,
          skipped: false,
          durationMs: 123,
          sourceConfidence: null,
          warningCodes: result.warningCodes,
          errorCode: result.errorCode
        }
      ],
      warnings: result.warningCodes
    });

    expect(unavailable.failureReason).toBe("youtubei_failed_precondition");
    expect(sandbox.ScriptLens.transcript.normalize.getFailureCodes(unavailable)).toContain(
      "youtubei_failed_precondition"
    );
  });

  test("reads a caption-track transcript successfully from json3", async () => {
    const sandbox = loadSandbox({
      fetch: async () => ({
        ok: true,
        text: async () =>
          JSON.stringify({
            events: [
              {
                tStartMs: 0,
                dDurationMs: 1800,
                segs: [{ utf8: "First caption line with enough words to count." }]
              },
              {
                tStartMs: 1800,
                dDurationMs: 2200,
                segs: [{ utf8: "Second caption line keeps the payload readable." }]
              }
            ]
          })
      })
    });

    const result = await sandbox.ScriptLens.transcript.strategies.captionTrack.run({
      adapter: {
        videoDurationSeconds: 240,
        bootstrapSnapshot: {
          captionTracks: [
            {
              baseUrl: "https://example.com/captions",
              languageCode: "en",
              kind: "",
              name: { simpleText: "English" }
            }
          ]
        }
      },
      transcriptBias: "manual-en",
      signal: new AbortController().signal
    });

    expect(result.ok).toBeTruthy();
    expect(result.strategy).toBe("caption-track");
    expect(result.text).toContain("First caption line");
    expect(result.segments.length).toBe(2);
  });

  test("treats caption fetch failure as a real resolver failure state", async () => {
    const sandbox = loadSandbox({
      fetch: async () => ({
        ok: true,
        text: async () => ""
      })
    });

    const result = await sandbox.ScriptLens.transcript.strategies.captionTrack.run({
      adapter: {
        videoDurationSeconds: 240,
        bootstrapSnapshot: {
          captionTracks: [
            {
              baseUrl: "https://example.com/captions",
              languageCode: "en",
              kind: "",
              name: { simpleText: "English" }
            }
          ]
        }
      },
      signal: new AbortController().signal
    });

    expect(result.ok).toBeFalsy();
    expect(result.errorCode).toBe("caption_fetch_failed");
  });

  test("falls back to page-origin caption fetch when the worker fetch path fails", async () => {
    const sandbox = loadSandbox({
      fetch: async () => {
        throw new Error("worker fetch blocked");
      }
    });

    const result = await sandbox.ScriptLens.transcript.strategies.captionTrack.run({
      adapter: {
        videoDurationSeconds: 240,
        bootstrapSnapshot: {
          captionTracks: [
            {
              baseUrl: "https://www.youtube.com/api/timedtext?v=test123&lang=en",
              languageCode: "en",
              kind: "",
              name: { simpleText: "English" }
            }
          ]
        }
      },
      pageFetch: async () => ({
        ok: true,
        status: 200,
        contentType: "application/json",
        text: JSON.stringify({
          events: [
            {
              tStartMs: 0,
              dDurationMs: 1800,
              segs: [{ utf8: "First page-fetched caption line with enough words to count." }]
            },
            {
              tStartMs: 1800,
              dDurationMs: 2200,
              segs: [{ utf8: "Second page-fetched caption line keeps the payload readable." }]
            }
          ]
        })
      }),
      signal: new AbortController().signal
    });

    expect(result.ok).toBeTruthy();
    expect(result.strategy).toBe("caption-track");
    expect(result.text).toContain("First page-fetched caption line");
    expect(result.segments.length).toBe(2);
  });

  test("loads DOM transcript segments through the transcript panel loader", async () => {
    const sandbox = loadSandbox();

    const result = await sandbox.ScriptLens.transcript.strategies.domTranscript.run({
      adapter: {
        bootstrapSnapshot: {
          hl: "en"
        }
      },
      domTranscriptLoader: async () => ({
        domTranscriptLanguageCode: "en",
        domTranscriptSegments: [
          {
            startMs: 0,
            durationMs: 4000,
            text: "The transcript panel opened and rendered a first usable segment."
          },
          {
            startMs: 4000,
            durationMs: 4200,
            text: "A second segment keeps the DOM extraction path honest and deterministic."
          }
        ]
      })
    });

    expect(result.ok).toBeTruthy();
    expect(result.strategy).toBe("dom-transcript");
    expect(result.text).toContain("first usable segment");
    expect(result.segments.length).toBe(2);
  });

  test("uses DOM transcript only after primary strategies fail", async () => {
    const sandbox = loadSandbox();
    sandbox.ScriptLens.transcript.strategies = {
      youtubei: {
        run: async () => ({
          ok: false,
          warningCodes: ["youtubei_failed"],
          errorCode: "youtubei_failed",
          errorMessage: "youtubei failed"
        })
      },
      captionTrack: {
        run: async () => ({
          ok: false,
          warningCodes: ["caption_fetch_failed"],
          errorCode: "caption_fetch_failed",
          errorMessage: "caption fetch failed"
        })
      },
      domTranscript: {
        run: async () =>
          buildCaptionCandidate({
            strategy: "dom-transcript",
            sourceLabel: "Visible transcript",
            isGenerated: null
          })
      },
      descriptionTranscript: {
        run: async () => ({
          ok: true,
          provider: "youtubeResolver",
          strategy: "description-transcript",
          sourceLabel: "Description transcript",
          text: "Fallback transcript block."
        })
      },
      titleDescription: {
        run: async () => ({
          ok: true,
          provider: "youtubeResolver",
          strategy: "title-description",
          sourceLabel: "Title + description fallback",
          text: "Fallback title and description."
        })
      }
    };

    const result = await sandbox.ScriptLens.transcript.providers.youtubeResolver.resolve({
      maxTextLength: 18000
    });

    expect(result.ok).toBeTruthy();
    expect(result.strategy).toBe("dom-transcript");
    expect(result.resolverAttempts.map((attempt) => attempt.strategy)).toEqual([
      "caption-track",
      "youtubei-transcript",
      "dom-transcript"
    ]);
  });

  test("records navigation changes as resolver failures", async () => {
    const sandbox = loadSandbox();
    sandbox.ScriptLens.transcript.strategies = {
      youtubei: {
        run: ({ signal }) =>
          new Promise((resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true }
            );
            setTimeout(() => resolve(buildCaptionCandidate()), 500);
          })
      },
      captionTrack: {
        run: ({ signal }) =>
          new Promise((resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true }
            );
            setTimeout(() => resolve(buildCaptionCandidate()), 500);
          })
      },
      domTranscript: {
        run: async () => ({
          ok: false,
          warningCodes: ["dom_transcript_missing"],
          errorCode: "dom_transcript_missing",
          errorMessage: "missing"
        })
      },
      descriptionTranscript: {
        run: async () => ({
          ok: false,
          warningCodes: ["description_transcript_missing"],
          errorCode: "description_transcript_missing",
          errorMessage: "missing"
        })
      },
      titleDescription: {
        run: async () => ({
          ok: false,
          warningCodes: ["title_description_missing"],
          errorCode: "title_description_missing",
          errorMessage: "missing"
        })
      }
    };

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);

    const result = await sandbox.ScriptLens.transcript.providers.youtubeResolver.resolve({
      maxTextLength: 18000,
      signal: controller.signal
    });

    expect(result.ok).toBeFalsy();
    expect(result.errors.some((error) => error.code === "navigation_changed")).toBeTruthy();
  });

  test("an eligible caption track beats a candidate that fails the transcript quality gate", () => {
    const sandbox = loadSandbox();
    const normalize = sandbox.ScriptLens.transcript.normalize;

    const partial = normalize.normalizeCandidate(
      buildCaptionCandidate({
        sourceConfidence: "medium",
        segments: Array.from({ length: 8 }, (_, index) => ({
          startMs: index * 10000,
          durationMs: 5000,
          text: `Short segment ${index + 1} carries some transcript coverage but not enough to be complete.`
        })),
        videoDurationSeconds: 420
      }),
      { maxTextLength: 18000 }
    );
    const strong = normalize.normalizeCandidate(
      buildCaptionCandidate({
        sourceConfidence: "high",
        segments: Array.from({ length: 18 }, (_, index) => ({
          startMs: index * 15000,
          durationMs: 12000,
          text: `Full segment ${index + 1} carries materially stronger transcript coverage and quality for the comparison.`
        })),
        videoDurationSeconds: 420
      }),
      { maxTextLength: 18000 }
    );

    expect(partial.qualityGate.eligible).toBeFalsy();
    expect(strong.qualityGate.eligible).toBeTruthy();
    const comparison = normalize.compareCandidates(partial, strong);
    expect(comparison.winner).toBe(strong);
    expect(comparison.reasons[0]).toMatch(/^(transcript-over-fallback|quality-gate:)/);
  });

  test("a direct YouTube transcript beats generated captions on trust order", () => {
    const sandbox = loadSandbox();
    const normalize = sandbox.ScriptLens.transcript.normalize;
    const segments = Array.from({ length: 12 }, (_, index) => ({
      startMs: index * 12000,
      durationMs: 11000,
      text: `Segment ${index + 1} keeps enough spoken detail to remain an eligible transcript source for the comparison.`
    }));

    const direct = normalize.normalizeCandidate(
      buildCaptionCandidate({
        strategy: "youtubei-transcript",
        sourceLabel: "YouTube transcript",
        sourceConfidence: "high",
        isGenerated: null,
        segments
      }),
      { maxTextLength: 18000 }
    );
    const generated = normalize.normalizeCandidate(
      buildCaptionCandidate({
        sourceConfidence: "high",
        isGenerated: true,
        segments
      }),
      { maxTextLength: 18000 }
    );

    expect(direct.qualityGate.eligible).toBeTruthy();
    expect(generated.qualityGate.eligible).toBeTruthy();
    const comparison = normalize.compareCandidates(generated, direct);
    expect(comparison.winner).toBe(direct);
    expect(comparison.reasons[0]).toBe("trust-tier:direct-transcript>caption-derived");
  });

  test("normalizes every candidate as a local source without recovery metadata", () => {
    const sandbox = loadSandbox();
    const normalize = sandbox.ScriptLens.transcript.normalize;

    const candidate = normalize.normalizeCandidate(
      buildCaptionCandidate({
        providerClass: "backend",
        recoveryTier: "hosted_transcript"
      }),
      { maxTextLength: 18000 }
    );
    const unavailable = normalize.buildUnavailableResult({
      providerClass: "backend",
      recoveryTier: "hosted_transcript",
      strategy: "caption-track"
    });

    for (const result of [candidate, unavailable]) {
      expect(result.providerClass).toBe("local");
      expect(result).not.toHaveProperty("recoveryTier");
      expect(result.warnings).not.toContain("backend_fallback_used");
    }
  });

  test("caps detector confidence by source confidence", () => {
    const sandbox = loadSandbox();
    const text = [
      "Here is the big idea. Here is why it matters. Here is how it works.",
      "In this video we break everything down step by step so you can follow the full system.",
      "Let us dive in and look at the core process, the outcome, and the final takeaway."
    ].join(" ");

    const result = sandbox.AIScriptDetector.detect.runDetection(text, {
      sensitivity: "medium",
      source: "test",
      sourceConfidence: "low"
    });

    expect(result.ok).toBeTruthy();
    expect(result.detection.detectorConfidence).toBe("low");
  });
});

function buildCaptionCandidate(overrides = {}) {
  return {
    ok: true,
    provider: "youtubeResolver",
    providerClass: "local",
    strategy: "caption-track",
    sourceLabel: "Caption track",
    languageCode: "en",
    originalLanguageCode: "en",
    requestedLanguageCode: null,
    isGenerated: false,
    isTranslated: false,
    isMachineTranslated: false,
    videoDurationSeconds: 240,
    segments: Array.from({ length: 12 }, (_, index) => ({
      startMs: index * 10000,
      durationMs: 8000,
      text: `Segment ${index + 1} with enough text to count as a usable caption segment.`
    })),
    warnings: [],
    ...overrides
  };
}

function loadSandbox(overrides = {}) {
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    AbortController,
    URL,
    URLSearchParams,
    fetch: overrides.fetch || (async () => {
      throw new Error("fetch not stubbed");
    }),
    globalThis: {}
  };

  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  FILES.forEach((relativePath) => {
    const absolutePath = path.join(ROOT_DIR, relativePath);
    const source = fs.readFileSync(absolutePath, "utf8");
    vm.runInContext(source, sandbox, { filename: absolutePath });
  });

  return sandbox;
}

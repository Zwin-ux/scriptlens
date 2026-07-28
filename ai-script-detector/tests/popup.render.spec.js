const { test, expect } = require("./fixtures");

test.describe("ScriptLens popup rendering contracts", () => {
  test("renders a transcript-unavailable report without throwing", async ({
    context,
    extensionId
  }) => {
    const popupPage = await context.newPage();
    await popupPage.addInitScript(() => {
      globalThis.chrome = globalThis.chrome || {};
      globalThis.chrome.runtime = globalThis.chrome.runtime || {};
      const initResponse = {
        ok: true,
        settings: {
          sensitivity: "medium",
          maxTextLength: 18000,
          debugMode: false,
          allowBackendTranscriptFallback: true
        },
        recentReports: [],
        pageContext: {
          supported: true,
          title: "Sample fallback page",
          hostname: "youtube.com",
          selectionAvailable: false,
          pageAvailable: false,
          isYouTubeVideo: true,
          transcriptAvailable: false,
          recommendedRequest: {
            mode: "youtube",
            includeSources: ["description", "title"],
            trackBaseUrl: ""
          },
          video: {
            availableSources: {
              transcript: false,
              description: true,
              title: true
            },
            transcriptTracks: []
          }
        }
      };
      const analyzeResponse = {
        ok: false,
        error: "Enhanced extraction unavailable.",
        acquisition: {
          kind: "transcript",
          sourceLabel: "Unavailable",
          providerClass: "local",
          sourceConfidence: "low",
          quality: "enhanced-extraction-unavailable",
          acquisitionState: "transcript-unavailable",
          transcriptRequiredSatisfied: false,
          failureReason: "transcript_required",
          warnings: ["enhanced_extraction_unavailable"],
          resolverPath: [],
          winnerSelectedBy: [],
          errors: []
        }
      };

      Object.defineProperty(chrome.runtime, "sendMessage", {
        configurable: true,
        value(message) {
          if (message?.type === "popup:init") {
            return Promise.resolve(initResponse);
          }
          if (message?.type === "popup:analyze") {
            return Promise.resolve(analyzeResponse);
          }
          return Promise.resolve({
            ok: false,
            error: "Unexpected message in popup render test."
          });
        }
      });
    });

    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`, {
      waitUntil: "domcontentloaded"
    });

    await popupPage.locator("#recommendedActionButton").click();

    await expect(popupPage.locator("#resultContent")).toBeVisible({ timeout: 15000 });
    await expect(popupPage.locator("#reportExplanation")).toContainText(
      "Enhanced extraction unavailable."
    );
    await expect(popupPage.locator("#acquisitionQualityBadge")).toContainText(
      "Transcript unavailable"
    );
    await expect(popupPage.locator("#trustNotMeans")).toContainText(
      "not proof of authorship"
    );
    await expect(popupPage.locator("#statusBanner")).toContainText(
      "Enhanced extraction unavailable."
    );
  });

  test("renders backend partial transcript labeling and privacy disclosure", async ({
    context,
    extensionId
  }) => {
    const popupPage = await context.newPage();
    await popupPage.addInitScript(() => {
      globalThis.chrome = globalThis.chrome || {};
      globalThis.chrome.runtime = globalThis.chrome.runtime || {};
      const initResponse = {
        ok: true,
        settings: {
          sensitivity: "medium",
          maxTextLength: 18000,
          debugMode: false,
          allowBackendTranscriptFallback: true
        },
        recentReports: [],
        pageContext: {
          supported: true,
          title: "Sample backend transcript page",
          hostname: "youtube.com",
          selectionAvailable: false,
          pageAvailable: false,
          isYouTubeVideo: true,
          transcriptAvailable: true,
          recommendedRequest: {
            mode: "youtube",
            includeSources: ["transcript"],
            trackBaseUrl: "",
            requireTranscript: true,
            allowFallbackText: false
          },
          video: {
            availableSources: {
              transcript: true,
              description: true,
              title: true
            },
            transcriptTracks: []
          }
        }
      };
      const analyzeResponse = {
        ok: true,
        report: {
          source: "YouTube video - Sample backend transcript page - Backend transcript fallback",
          score: 38,
          verdict: "Unlikely AI-written",
          explanation:
            "The transcript sample reads more like a spoken performance than a templated script.",
          disclaimer: "This score reflects AI-like writing patterns, not proof of authorship.",
          detection: {
            aiScore: 38,
            detectorConfidence: "medium",
            verdict: "Unlikely AI-written",
            reasons: ["Natural pauses and irregular spoken phrasing reduce script-like signals."],
            categoryScores: {
              repetition: 18,
              uniformity: 24
            },
            triggeredPatterns: [],
            flaggedSentences: [],
            explanation:
              "The transcript sample reads more like a spoken performance than a templated script."
          },
          acquisition: {
            kind: "transcript",
            provider: "backendResolver",
            providerClass: "backend",
            strategy: "backend-transcript",
            sourceLabel: "Backend transcript fallback",
            sourceConfidence: "high",
            quality: "partial-transcript",
            acquisitionState: "partial-transcript",
            transcriptRequiredSatisfied: true,
            failureReason: null,
            languageCode: "en",
            originalLanguageCode: "en",
            transcriptSpanSeconds: 98,
            coverageRatio: 0.41,
            segmentCount: 12,
            warnings: ["backend_fallback_used"],
            errors: [],
            resolverAttempts: [],
            resolverPath: ["backendResolver:backend-transcript"],
            winnerSelectedBy: ["backend-success"],
            text: "A backend transcript sample."
          },
          inputQuality: {
            label: "Partial input",
            summary: "The transcript is real, but coverage is still limited.",
            reasons: []
          },
          interpretation: {
            means: "This score reflects the available transcript slice only.",
            notMeans: "This is not proof of authorship.",
            falsePositives: [],
            trustMore: ["Prefer fuller transcripts when possible."]
          },
          metadata: {
            wordCount: 240,
            sentenceCount: 14,
            sensitivity: "medium"
          },
          topReasons: ["Natural pauses and irregular spoken phrasing reduce script-like signals."],
          categoryScores: {
            repetition: 18,
            uniformity: 24
          },
          flaggedSentences: []
        },
        settings: initResponse.settings,
        recentReports: [],
        pageContext: initResponse.pageContext,
        uiHints: {}
      };

      Object.defineProperty(chrome.runtime, "sendMessage", {
        configurable: true,
        value(message) {
          if (message?.type === "popup:init") {
            return Promise.resolve(initResponse);
          }
          if (message?.type === "popup:analyze") {
            return Promise.resolve(analyzeResponse);
          }
          return Promise.resolve({
            ok: false,
            error: "Unexpected message in popup render test."
          });
        }
      });
    });

    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`, {
      waitUntil: "domcontentloaded"
    });

    await popupPage.locator("#recommendedActionButton").click();

    await expect(popupPage.locator("#resultContent")).toBeVisible({ timeout: 15000 });
    await expect(popupPage.locator("#acquisitionQualityBadge")).toContainText(
      "Partial transcript"
    );
    await expect(popupPage.locator("#providerBadge")).toContainText("Recovered transcript");
    await expect(popupPage.locator("#privacyDisclosure")).toContainText(
      "video ID and requested language"
    );
    await expect(popupPage.locator("#acquisitionStateCopy")).toContainText(
      "real transcript source"
    );
  });

  test("renders defuddle-backed page fallback as local content instead of a recovered transcript", async ({
    context,
    extensionId
  }) => {
    const popupPage = await context.newPage();
    await popupPage.addInitScript(() => {
      globalThis.chrome = globalThis.chrome || {};
      globalThis.chrome.runtime = globalThis.chrome.runtime || {};
      const initResponse = {
        ok: true,
        settings: {
          sensitivity: "medium",
          maxTextLength: 18000,
          debugMode: false,
          allowBackendTranscriptFallback: true
        },
        recentReports: [],
        pageContext: {
          supported: true,
          title: "Defuddle fallback page",
          hostname: "youtube.com",
          selectionAvailable: false,
          pageAvailable: true,
          isYouTubeVideo: true,
          transcriptAvailable: false,
          recommendedRequest: {
            mode: "youtube",
            includeSources: ["transcript", "description", "title"],
            trackBaseUrl: "",
            requireTranscript: false,
            allowFallbackText: true
          },
          video: {
            availableSources: {
              transcript: false,
              description: true,
              title: true
            },
            transcriptTracks: []
          }
        }
      };
      const analyzeResponse = {
        ok: true,
        report: {
          source: "YouTube video - Defuddle fallback page - Extracted page content",
          score: 44,
          verdict: "Mixed signals",
          explanation:
            "The extracted page content has enough structure to score, but it is still weaker than a spoken transcript.",
          disclaimer: "This score reflects AI-like writing patterns, not proof of authorship.",
          detection: {
            aiScore: 44,
            detectorConfidence: "medium",
            verdict: "Mixed signals",
            reasons: ["The page-level fallback contains enough substantive text to analyze."],
            categoryScores: {
              repetition: 30,
              uniformity: 42
            },
            triggeredPatterns: [],
            flaggedSentences: [],
            explanation:
              "The extracted page content has enough structure to score, but it is still weaker than a spoken transcript."
          },
          acquisition: {
            kind: "page-content",
            provider: null,
            providerClass: "local",
            strategy: null,
            sourceLabel: "Extracted page content",
            sourceConfidence: "medium",
            quality: "partial-transcript",
            acquisitionState: null,
            transcriptRequiredSatisfied: true,
            failureReason: "caption_fetch_failed",
            languageCode: "en",
            originalLanguageCode: "en",
            coverageRatio: 0.33,
            segmentCount: 0,
            warnings: ["fallback_source"],
            errors: [],
            resolverAttempts: [],
            resolverPath: ["youtubeResolver:caption-track", "directExtractor:defuddle"],
            winnerSelectedBy: ["defuddle-page-fallback"],
            text: "Extracted page content sample."
          },
          inputQuality: {
            label: "Useful input",
            summary: "This analysis uses extracted page content because a usable transcript was not available.",
            reasons: []
          },
          interpretation: {
            means: "This score reflects the extracted page content only.",
            notMeans: "This is not proof of authorship.",
            falsePositives: [],
            trustMore: ["Prefer real transcript sources when possible."]
          },
          metadata: {
            wordCount: 210,
            sentenceCount: 11,
            sensitivity: "medium"
          },
          topReasons: ["The page-level fallback contains enough substantive text to analyze."],
          categoryScores: {
            repetition: 30,
            uniformity: 42
          },
          flaggedSentences: []
        },
        settings: initResponse.settings,
        recentReports: [],
        pageContext: initResponse.pageContext,
        uiHints: {}
      };

      Object.defineProperty(chrome.runtime, "sendMessage", {
        configurable: true,
        value(message) {
          if (message?.type === "popup:init") {
            return Promise.resolve(initResponse);
          }
          if (message?.type === "popup:analyze") {
            return Promise.resolve(analyzeResponse);
          }
          return Promise.resolve({
            ok: false,
            error: "Unexpected message in popup render test."
          });
        }
      });
    });

    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`, {
      waitUntil: "domcontentloaded"
    });

    await popupPage.locator("#recommendedActionButton").click();

    await expect(popupPage.locator("#resultContent")).toBeVisible({ timeout: 15000 });
    await expect(popupPage.locator("#providerBadge")).toContainText("Local content");
    await expect(popupPage.locator("#providerBadge")).not.toContainText("Recovered transcript");
    await expect(popupPage.locator("#transcriptSourceValue")).toContainText(
      "Extracted page content"
    );
    await expect(popupPage.locator("#acquisitionQualityBadge")).toContainText(
      "Useful content"
    );
    await expect(popupPage.locator("#acquisitionStateCopy")).toContainText(
      "extracted page content"
    );
  });

  test("renders recovered-but-unscored transcripts without falling back to 0", async ({
    context,
    extensionId
  }) => {
    const popupPage = await context.newPage();
    await popupPage.addInitScript(() => {
      globalThis.chrome = globalThis.chrome || {};
      globalThis.chrome.runtime = globalThis.chrome.runtime || {};
      const initResponse = {
        ok: true,
        settings: {
          sensitivity: "medium",
          maxTextLength: 18000,
          debugMode: false,
          allowBackendTranscriptFallback: true
        },
        recentReports: [],
        pageContext: {
          supported: true,
          title: "Short transcript page",
          hostname: "youtube.com",
          selectionAvailable: false,
          pageAvailable: false,
          isYouTubeVideo: true,
          transcriptAvailable: true,
          recommendedRequest: {
            mode: "youtube",
            includeSources: ["transcript"],
            trackBaseUrl: "",
            requireTranscript: true,
            allowFallbackText: false
          },
          video: {
            availableSources: {
              transcript: true,
              description: true,
              title: true
            },
            transcriptTracks: []
          }
        }
      };
      const analyzeResponse = {
        ok: true,
        report: {
          source: "YouTube video - Short transcript page - Recovered transcript",
          score: null,
          verdict: "Not enough spoken text",
          explanation:
            "ScriptLens recovered a transcript, but this video does not contain enough spoken text for a reliable score.",
          scoringStatus: "insufficient-input",
          scoringSummary:
            "ScriptLens recovered a transcript, but this video does not contain enough spoken text for a reliable score.",
          disclaimer: "This score reflects AI-like writing patterns, not proof of authorship.",
          detection: {
            aiScore: null,
            detectorConfidence: "not scored",
            verdict: "Not enough spoken text",
            reasons: [
              "ScriptLens recovered transcript text for this video.",
              "The text is too short for a useful heuristic read. Try at least 40 words or 180 characters."
            ],
            categoryScores: {},
            triggeredPatterns: [],
            flaggedSentences: [],
            explanation:
              "ScriptLens recovered a transcript, but this video does not contain enough spoken text for a reliable score.",
            scoringStatus: "insufficient-input",
            scoringSummary:
              "ScriptLens recovered a transcript, but this video does not contain enough spoken text for a reliable score."
          },
          acquisition: {
            kind: "transcript",
            provider: "backendResolver",
            providerClass: "backend",
            strategy: "backend-transcript",
            sourceLabel: "Recovered transcript",
            sourceConfidence: "high",
            quality: "strong-transcript",
            acquisitionState: "transcript-acquired",
            transcriptRequiredSatisfied: true,
            languageCode: "en",
            originalLanguageCode: "en",
            transcriptSpanSeconds: 19,
            coverageRatio: 1,
            segmentCount: 4,
            warnings: ["insufficient_scoring_input"],
            errors: [],
            resolverAttempts: [],
            resolverPath: ["backendResolver:backend-transcript"],
            winnerSelectedBy: ["quality-eligible:manual_caption_track"],
            winnerReason: "quality-eligible:manual_caption_track",
            text: "Short transcript text."
          },
          inputQuality: {
            label: "Strong input",
            summary: "The transcript is clean, but there is not enough spoken text to score it safely.",
            reasons: []
          },
          interpretation: {
            means: "The score reflects the available transcript slice only.",
            notMeans: "This is not proof of authorship.",
            falsePositives: [],
            trustMore: ["Use longer spoken samples when possible."]
          },
          metadata: {
            wordCount: 39,
            sentenceCount: 2,
            sensitivity: "medium"
          },
          topReasons: [
            "ScriptLens recovered transcript text for this video.",
            "The text is too short for a useful heuristic read. Try at least 40 words or 180 characters."
          ],
          categoryScores: {},
          flaggedSentences: []
        },
        settings: initResponse.settings,
        recentReports: [],
        pageContext: initResponse.pageContext,
        uiHints: {}
      };

      Object.defineProperty(chrome.runtime, "sendMessage", {
        configurable: true,
        value(message) {
          if (message?.type === "popup:init") {
            return Promise.resolve(initResponse);
          }
          if (message?.type === "popup:analyze") {
            return Promise.resolve(analyzeResponse);
          }
          return Promise.resolve({
            ok: false,
            error: "Unexpected message in popup render test."
          });
        }
      });
    });

    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`, {
      waitUntil: "domcontentloaded"
    });

    await popupPage.locator("#recommendedActionButton").click();

    await expect(popupPage.locator("#resultContent")).toBeVisible({ timeout: 15000 });
    await expect(popupPage.locator("#scoreValue")).toHaveText("Not scored");
    await expect(popupPage.locator("#verdictBadge")).toContainText("Not enough spoken text");
    await expect(popupPage.locator("#reportExplanation")).toContainText(
      "does not contain enough spoken text"
    );
  });
});

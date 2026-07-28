const path = require("path");
const { test, expect } = require("@playwright/test");

const InlineState = require(path.join(__dirname, "..", "surface", "inline-state.js"));

test.describe("ScriptLens inline state helpers", () => {
  test("preserves valid same-video selection while pruning unavailable sources", () => {
    const nextSelection = InlineState.syncVideoSelection({
      context: {
        video: {
          availableSources: {
            transcript: true,
            description: false,
            title: true
          },
          defaultPreset: {
            includeSources: ["transcript"],
            trackBaseUrl: "https://example.com/en",
            allowFallbackText: false
          },
          transcriptTracks: [
            { baseUrl: "https://example.com/en", kind: "" },
            { baseUrl: "https://example.com/es", kind: "" }
          ]
        }
      },
      currentSelection: {
        includeSources: ["transcript", "description"],
        trackBaseUrl: "https://example.com/es",
        allowFallbackText: true
      },
      preserveCurrentSelection: true
    });

    expect(nextSelection).toEqual({
      includeSources: ["transcript"],
      trackBaseUrl: "https://example.com/es",
      allowFallbackText: true
    });
  });

  test("summarizes page context for logging without full payload churn", () => {
    expect(
      InlineState.summarizeContext({
        supported: true,
        isYouTubeVideo: true,
        transcriptAvailable: false,
        video: {
          title: "Sample",
          videoId: "abc123",
          availableSources: { transcript: true },
          transcriptTracks: [{ baseUrl: "one" }, { baseUrl: "two" }]
        }
      })
    ).toEqual({
      supported: true,
      isYouTubeVideo: true,
      transcriptAvailable: false,
      video: {
        title: "Sample",
        videoId: "abc123",
        availableSources: { transcript: true },
        transcriptTrackCount: 2
      }
    });
  });

  test("maps timeout errors to inline-friendly copy", () => {
    expect(
      InlineState.buildInlineRuntimeError(new Error("request timed out after 30000ms"), "analyze")
    ).toContain("took too long");
  });
});

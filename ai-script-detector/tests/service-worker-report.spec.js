const path = require("path");
const { test, expect } = require("@playwright/test");

const Contracts = require(path.join(__dirname, "..", "shared", "contracts.js"));
globalThis.ScriptLensContracts = Contracts;
globalThis.ScriptLens = {
  transcript: {
    policy: {
      ANALYSIS_MODES: {
        youtubeTranscriptFirst: "youtube-transcript-first",
        genericText: "generic-text"
      }
    }
  }
};
const Reports = require(path.join(__dirname, "..", "shared", "service-worker-report.js"));

test.describe("ScriptLens service worker report helpers", () => {
  test("builds contract-stable analysis reports", () => {
    const report = Reports.buildAnalysisReport(
      {
        acquisition: {
          kind: "transcript",
          sourceLabel: "Recovered transcript",
          sourceConfidence: "high",
          quality: "strong-transcript",
          providerClass: "backend",
          recoveryTier: "hosted_transcript",
          originKind: "manual_caption_track",
          sourceTrustTier: "caption-derived",
          winnerReason: "quality-eligible:manual_caption_track"
        },
        detection: {
          aiScore: 42,
          verdict: "Mixed / possibly assisted",
          explanation: "Recovered transcript path stayed strong.",
          reasons: ["Recovered transcript path stayed strong."],
          categoryScores: {},
          triggeredPatterns: [],
          flaggedSentences: []
        },
        legacyReport: {
          metadata: {
            wordCount: 220,
            sentenceCount: 9
          }
        },
        settings: {
          sensitivity: "medium"
        },
        sourceLabel: "YouTube video - Demo - Recovered transcript",
        directMeta: {
          sourceType: "youtube"
        }
      },
      {
        disclaimer: "Example"
      }
    );

    expect(report.contractVersion).toBe("2026-03-11");
    expect(report.analysisMode).toBe("youtube-transcript-first");
    expect(report.failureCategory).toBeNull();
    expect(report.scoringStatus).toBe("scored");
  });

  test("builds insufficient-input reports without regressing to generic errors", () => {
    globalThis.AIScriptDetector = {
      text: {
        sanitizeInput(value) {
          return String(value || "").trim();
        },
        countWords(value) {
          return String(value || "").trim().split(/\s+/).filter(Boolean).length;
        },
        splitSentences(value) {
          return String(value || "")
            .split(/[.!?]+/)
            .map((entry) => entry.trim())
            .filter(Boolean);
        }
      }
    };

    const report = Reports.buildInsufficientInputReport({
      acquisition: {
        kind: "transcript",
        text: "Short sentence. Another short sentence.",
        warnings: []
      },
      detectionError:
        "The text is too short for a useful heuristic read. Try at least 40 words or 180 characters.",
      sourceLabel: "Recovered transcript",
      settings: {
        sensitivity: "medium"
      },
      sourceType: "youtube"
    });

    expect(report.scoringStatus).toBe(Contracts.SCORING_STATUSES.insufficientInput);
    expect(report.verdict).toBe("Not enough spoken text");
    expect(report.scoringSummary).toContain("does not contain enough spoken text");
  });

  test("keeps direct-content report metadata out of transcript recovery taxonomies", () => {
    const report = Reports.buildAnalysisReport(
      {
        acquisition: {
          kind: "page-content",
          sourceLabel: "Extracted page content",
          sourceConfidence: "medium",
          quality: "partial-transcript",
          providerClass: "local",
          coverageRatio: 0.41,
          warnings: ["fallback_source"]
        },
        detection: {
          aiScore: 34,
          verdict: "Mixed / possibly assisted",
          explanation: "The extracted page content was usable but not transcript-derived.",
          reasons: ["The extracted page content was usable but not transcript-derived."],
          categoryScores: {},
          triggeredPatterns: [],
          flaggedSentences: []
        },
        legacyReport: {
          metadata: {
            wordCount: 320,
            sentenceCount: 14
          }
        },
        settings: {
          sensitivity: "medium"
        },
        sourceLabel: "YouTube video - Demo - Extracted page content",
        directMeta: {
          sourceType: "youtube"
        }
      },
      {
        disclaimer: "Example"
      }
    );

    const snapshot = Contracts.buildAnalysisContractSnapshot(report);

    expect(report.sourceMeta.recoveryTier).toBeNull();
    expect(report.sourceMeta.originKind).toBeNull();
    expect(report.sourceMeta.sourceTrustTier).toBeNull();
    expect(snapshot.recoveryTier).toBeNull();
    expect(snapshot.originKind).toBeNull();
    expect(snapshot.sourceTrustTier).toBeNull();
  });
});

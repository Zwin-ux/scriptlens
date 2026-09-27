const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { test, expect } = require("@playwright/test");

test.describe("ScriptLens shared surface helpers", () => {
  test("maps partial YouTube transcript reports to consumer inline copy", () => {
    const surface = loadSurfaceModule();
    const viewModel = surface.buildInlineReportViewModel(
      createReport({
        detection: {
          aiScore: 43,
          detectorConfidence: "medium",
          verdict: "Mixed / possibly assisted",
          reasons: ["Sentence rhythm stays unusually even across the sample."],
          explanation: "Sentence rhythm stays unusually even across the sample."
        },
        acquisition: {
          kind: "transcript",
          providerClass: "local",
          strategy: "youtubei-transcript",
          sourceLabel: "YouTube transcript",
          sourceConfidence: "medium",
          acquisitionState: "partial-transcript",
          coverageRatio: 0.58,
          segmentCount: 37,
          transcriptSpanSeconds: 601,
          languageCode: "en"
        },
        inputQuality: {
          summary: "Transcript quality is limited but still useful."
        }
      })
    );

    expect(viewModel.sourceLabel).toBe("YouTube transcript");
    expect(viewModel.qualityLabel).toBe("Usable transcript");
    expect(viewModel.privacyDisclosure).toBe("");
    expect(viewModel.confidenceLabel).toBe("Medium");
    expect(viewModel.contractVersion).toBe("2026-09-27");
  });

  test("maps title and description fallback to consumer inline copy", () => {
    const surface = loadSurfaceModule();
    const viewModel = surface.buildInlineReportViewModel(
      createReport({
        acquisition: {
          kind: "transcript",
          providerClass: "local",
          strategy: "title-description",
          sourceLabel: "Title + description fallback",
          sourceConfidence: "low",
          acquisitionState: "fallback-text-only"
        }
      })
    );

    expect(viewModel.sourceLabel).toBe("Title and description");
    expect(viewModel.qualityLabel).toBe("Fallback text");
    expect(viewModel.privacyDisclosure).toBe("");
  });

  test("maps generated transcript reports to consumer inline copy", () => {
    const surface = loadSurfaceModule();
    const viewModel = surface.buildInlineReportViewModel(
      createReport({
        acquisition: {
          kind: "transcript",
          providerClass: "local",
          strategy: "caption-track",
          sourceLabel: "English auto captions",
          sourceConfidence: "high",
          acquisitionState: "transcript-acquired",
          isGenerated: true
        }
      })
    );

    expect(viewModel.sourceLabel).toBe("YouTube captions");
    expect(viewModel.qualityLabel).toBe("Strong transcript");
  });

  test("describes the local source path without hosted-recovery labels", () => {
    const surface = loadSurfaceModule();
    const viewModel = surface.buildInlineReportViewModel(
      createReport({
        acquisition: {
          kind: "transcript",
          providerClass: "local",
          strategy: "caption-track",
          sourceLabel: "English captions",
          sourceConfidence: "high",
          sourceTrustTier: "caption-derived",
          originKind: "manual_caption_track",
          winnerReason: "quality-eligible:manual_caption_track",
          acquisitionState: "transcript-acquired",
          isGenerated: false,
          coverageRatio: 0.91,
          segmentCount: 52,
          transcriptSpanSeconds: 744,
          languageCode: "en",
          qualityGate: {
            eligible: true,
            rejectedReasons: [],
            wordCount: 540,
            sentenceUnits: 18,
            coverageRatio: 0.91
          }
        }
      })
    );

    expect(viewModel.sourceLabel).toBe("YouTube transcript");
    expect(viewModel.advancedSourceMeta).toBe("Manual captions - Caption-derived - en");
    expect(viewModel.advancedSourceMeta).not.toMatch(/recovery/i);
    expect(viewModel.winnerReason).toBe("quality-eligible:manual_caption_track");
    expect(viewModel.qualityGateNote).toBe("Quality gate passed (540 words, 18 sentence units).");
    expect(viewModel).not.toHaveProperty("reducedTrustLabel");
  });

  test("keeps short transcripts in an unscored inline state", () => {
    const surface = loadSurfaceModule();
    const viewModel = surface.buildInlineReportViewModel(
      createReport({
        score: null,
        scoringStatus: "insufficient-input",
        scoringSummary:
          "ScriptLens recovered a transcript, but this video does not contain enough spoken text for a reliable score.",
        detection: {
          aiScore: null,
          detectorConfidence: "not scored",
          verdict: "Not enough spoken text",
          reasons: [
            "ScriptLens recovered transcript text for this video.",
            "The text is too short for a useful heuristic read. Try at least 40 words or 180 characters."
          ],
          explanation:
            "ScriptLens recovered a transcript, but this video does not contain enough spoken text for a reliable score."
        },
        acquisition: {
          kind: "transcript",
          providerClass: "local",
          strategy: "caption-track",
          sourceLabel: "English captions",
          sourceConfidence: "high",
          quality: "strong-transcript",
          acquisitionState: "transcript-acquired",
          originKind: "manual_caption_track",
          winnerReason: "quality-eligible:manual_caption_track",
          coverageRatio: 1,
          segmentCount: 4,
          transcriptSpanSeconds: 19,
          languageCode: "en"
        }
      })
    );

    expect(viewModel.verdict).toBe("Not enough spoken text");
    expect(viewModel.rawScoreText).toBe("Not scored");
    expect(viewModel.qualityLabel).toBe("Short transcript");
    expect(viewModel.secondaryBadgeLabel).toBe("Not enough text to score");
    expect(viewModel.explanation).toContain("does not contain enough spoken text");
  });
});

function loadSurfaceModule() {
  const contractsPath = path.join(__dirname, "..", "shared", "contracts.js");
  const sourcePath = path.join(__dirname, "..", "surface", "shared.js");
  const context = { globalThis: {} };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(contractsPath, "utf8"), context, {
    filename: contractsPath
  });
  const code = fs.readFileSync(sourcePath, "utf8");
  vm.runInContext(code, context, { filename: sourcePath });
  return context.globalThis.ScriptLensSurface;
}

function createReport(overrides = {}) {
  return {
    contractVersion: "2026-09-27",
    acquisition: {
      kind: "transcript",
      providerClass: "local",
      strategy: "caption-track",
      sourceLabel: "English captions",
      sourceConfidence: "high",
      acquisitionState: "transcript-acquired",
      coverageRatio: 0.91,
      segmentCount: 52,
      transcriptSpanSeconds: 744,
      languageCode: "en"
    },
    detection: {
      aiScore: 32,
      detectorConfidence: "medium",
      verdict: "Mixed / possibly assisted",
      reasons: ["The wording is smoother than typical unscripted speech."],
      explanation: "The wording is smoother than typical unscripted speech."
    },
    inputQuality: {
      summary: "The transcript coverage is strong enough for a stable read."
    },
    metadata: {
      sensitivity: "medium"
    },
    ...overrides
  };
}

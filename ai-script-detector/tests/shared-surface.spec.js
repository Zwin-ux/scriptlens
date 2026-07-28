const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { test, expect } = require("@playwright/test");

test.describe("ScriptLens shared surface helpers", () => {
  test("maps backend transcript reports to consumer inline copy", () => {
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
          providerClass: "backend",
          strategy: "backend-transcript",
          sourceLabel: "Backend transcript fallback",
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

    expect(viewModel.sourceLabel).toBe("Recovered transcript");
    expect(viewModel.qualityLabel).toBe("Usable transcript");
    expect(viewModel.privacyDisclosure).toContain("video ID and requested language");
    expect(viewModel.confidenceLabel).toBe("Medium");
    expect(viewModel.contractVersion).toBe("2026-03-11");
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

  test("surfaces reduced trust for audio-derived transcript recovery", () => {
    const surface = loadSurfaceModule();
    const viewModel = surface.buildInlineReportViewModel(
      createReport({
        acquisition: {
          kind: "transcript",
          providerClass: "backend",
          strategy: "backend-asr",
          sourceLabel: "Audio-derived transcript",
          sourceConfidence: "low",
          sourceTrustTier: "audio-derived",
          recoveryTier: "hosted_asr",
          originKind: "audio_asr",
          winnerReason: "quality-eligible:audio_asr",
          acquisitionState: "partial-transcript",
          coverageRatio: 0.63,
          segmentCount: 28,
          transcriptSpanSeconds: 420,
          languageCode: "en",
          qualityGate: {
            eligible: true,
            rejectedReasons: [],
            wordCount: 540,
            sentenceUnits: 18,
            coverageRatio: 0.63
          }
        }
      })
    );

    expect(viewModel.sourceLabel).toBe("Recovered transcript");
    expect(viewModel.reducedTrustLabel).toBe("Audio-derived transcript");
    expect(viewModel.advancedSourceMeta).toContain("Hosted ASR");
    expect(viewModel.advancedSourceMeta).toContain("Audio-derived");
    expect(viewModel.winnerReason).toBe("quality-eligible:audio_asr");
    expect(viewModel.qualityGateNote).toContain("trust is reduced");
  });

  test("keeps recovered short transcripts in an unscored inline state", () => {
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
          providerClass: "backend",
          strategy: "backend-transcript",
          sourceLabel: "Recovered transcript",
          sourceConfidence: "high",
          quality: "strong-transcript",
          acquisitionState: "transcript-acquired",
          recoveryTier: "hosted_transcript",
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
    contractVersion: "2026-03-11",
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

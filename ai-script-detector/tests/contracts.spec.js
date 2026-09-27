const path = require("path");
const { test, expect } = require("@playwright/test");

const Contracts = require(path.join(__dirname, "..", "shared", "contracts.js"));

test.describe("ScriptLens shared contracts", () => {
  test("exports the frozen release contract fields", () => {
    expect(Contracts.CONTRACT_VERSION).toBe("2026-09-27");
    expect(Contracts.ORIGIN_KINDS.manualCaptionTrack).toBe("manual_caption_track");
    expect(Contracts.SOURCE_TRUST_TIERS.captionDerived).toBe("caption-derived");
    expect(Contracts.RUNTIME_MESSAGE_TYPES.inlineAnalyze).toBe("inline:analyze");
    expect(Contracts.PACKAGING_ENV_KEYS.publicSiteOrigin).toBe(
      "SCRIPTLENS_PUBLIC_SITE_ORIGIN"
    );
    expect(Object.keys(Contracts.PACKAGING_ENV_KEYS)).toEqual(["publicSiteOrigin"]);
    expect(Contracts.FAILURE_CATEGORIES.transcriptSource).toBe("transcript-source");
  });

  test("keeps hosted-recovery vocabulary out of the local-only contract", () => {
    expect(Contracts.RECOVERY_TIERS).toBeUndefined();
    expect(Contracts.TOOLING_FAILURE_CODES).toBeUndefined();
    expect(Object.values(Contracts.ORIGIN_KINDS)).not.toContain("audio_asr");
    expect(Object.values(Contracts.ORIGIN_KINDS)).not.toContain("headless_transcript");
    expect(Object.values(Contracts.SOURCE_TRUST_TIERS)).not.toContain("audio-derived");
    expect(Object.values(Contracts.SOURCE_TRUST_TIERS)).not.toContain("headless-derived");
    expect(Object.values(Contracts.FAILURE_CATEGORIES)).toEqual([
      "quality",
      "timeout",
      "transport",
      "transcript-source",
      "unknown"
    ]);
  });

  test("categorizes failure codes through the shared taxonomy", () => {
    expect(Contracts.categorizeFailureCode("quality_gate_rejected")).toBe("quality");
    expect(Contracts.categorizeFailureCode("resolver_timeout")).toBe("timeout");
    expect(Contracts.categorizeFailureCode("transport_error")).toBe("transport");
    expect(Contracts.categorizeFailureCode("caption_tracks_missing")).toBe(
      "transcript-source"
    );
    expect(Contracts.categorizeFailureCode("youtubei_failed_precondition")).toBe(
      "transcript-source"
    );
    expect(Contracts.categorizeFailureCode("dom_transcript_unavailable")).toBe("unknown");
  });

  test("builds stable report snapshots for drift tests", () => {
    const snapshot = Contracts.buildAnalysisContractSnapshot({
      contractVersion: Contracts.CONTRACT_VERSION,
      analysisMode: "youtube-transcript-first",
      scoringStatus: "insufficient-input",
      acquisition: {
        originKind: "manual_caption_track",
        sourceTrustTier: "caption-derived",
        winnerReason: "quality-eligible:manual_caption_track",
        qualityGate: {
          eligible: true
        }
      }
    });

    expect(snapshot).toEqual({
      contractVersion: "2026-09-27",
      analysisMode: "youtube-transcript-first",
      scoringStatus: "insufficient-input",
      failureCategory: null,
      originKind: "manual_caption_track",
      sourceTrustTier: "caption-derived",
      winnerReason: "quality-eligible:manual_caption_track",
      qualityGate: {
        eligible: true
      }
    });
  });
});

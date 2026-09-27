(function (root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  const globalRoot = root || globalThis;
  globalRoot.ScriptLensContracts = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const CONTRACT_VERSION = "2026-09-27";

  const ORIGIN_KINDS = Object.freeze({
    youtubeTranscript: "youtube_transcript",
    manualCaptionTrack: "manual_caption_track",
    generatedCaptionTrack: "generated_caption_track",
    fallbackText: "fallback_text",
    unavailable: "unavailable"
  });

  const SOURCE_TRUST_TIERS = Object.freeze({
    directTranscript: "direct-transcript",
    captionDerived: "caption-derived",
    fallbackText: "fallback-text",
    unavailable: "unavailable"
  });

  const SCORING_STATUSES = Object.freeze({
    scored: "scored",
    insufficientInput: "insufficient-input",
    error: "error"
  });

  const FAILURE_CATEGORIES = Object.freeze({
    quality: "quality",
    timeout: "timeout",
    transport: "transport",
    transcriptSource: "transcript-source",
    unknown: "unknown"
  });

  const RUNTIME_MESSAGE_TYPES = Object.freeze({
    inlineInit: "inline:init",
    inlineAnalyze: "inline:analyze",
    panelOpen: "panel:open"
  });

  const PACKAGING_ENV_KEYS = Object.freeze({
    publicSiteOrigin: "SCRIPTLENS_PUBLIC_SITE_ORIGIN",
    enableDefuddleExperiment: "SCRIPTLENS_ENABLE_DEFUDDLE_EXPERIMENT"
  });

  const QUALITY_FAILURE_CODES = new Set([
    "quality_gate_rejected",
    "language_mismatch",
    "language_requested_mismatch",
    "non_letter_noise",
    "insufficient_scoring_input"
  ]);

  const TRANSCRIPT_SOURCE_FAILURE_CODES = new Set([
    "caption_tracks_missing",
    "caption_track_unavailable",
    "caption_fetch_failed",
    "youtubei_failed",
    "youtubei_failed_precondition",
    "youtubei_params_missing",
    "youtubei_bootstrap_incomplete",
    "youtubei_empty"
  ]);

  function categorizeFailureCode(value) {
    const code = normalizeKey(value);
    if (!code) {
      return null;
    }
    if (QUALITY_FAILURE_CODES.has(code)) {
      return FAILURE_CATEGORIES.quality;
    }
    if (TRANSCRIPT_SOURCE_FAILURE_CODES.has(code)) {
      return FAILURE_CATEGORIES.transcriptSource;
    }
    if (code.includes("timeout")) {
      return FAILURE_CATEGORIES.timeout;
    }
    if (code.includes("transport")) {
      return FAILURE_CATEGORIES.transport;
    }
    return FAILURE_CATEGORIES.unknown;
  }

  function resolveFailureCategory(input) {
    if (!input) {
      return null;
    }
    if (typeof input === "string") {
      return categorizeFailureCode(input);
    }
    return (
      categorizeFailureCode(input.failureCategory) ||
      categorizeFailureCode(input.errorCode) ||
      categorizeFailureCode(input.winnerReason) ||
      categorizeFailureCode(input.failureReason) ||
      categorizeFailureCode(input.acquisition?.failureReason) ||
      null
    );
  }

  function buildAnalysisContractSnapshot(report) {
    const acquisition = report?.acquisition || report?.sourceInfo || {};
    return {
      contractVersion: report?.contractVersion || CONTRACT_VERSION,
      analysisMode: report?.analysisMode || null,
      scoringStatus:
        report?.scoringStatus ||
        report?.detection?.scoringStatus ||
        SCORING_STATUSES.scored,
      failureCategory: resolveFailureCategory(report),
      originKind: acquisition.originKind || report?.originKind || null,
      sourceTrustTier:
        acquisition.sourceTrustTier || report?.sourceTrustTier || null,
      winnerReason: acquisition.winnerReason || report?.winnerReason || null,
      qualityGate: acquisition.qualityGate || report?.qualityGate || null
    };
  }

  function normalizeKey(value) {
    return String(value || "").trim().toLowerCase();
  }

  return Object.freeze({
    CONTRACT_VERSION,
    ORIGIN_KINDS,
    SOURCE_TRUST_TIERS,
    SCORING_STATUSES,
    FAILURE_CATEGORIES,
    RUNTIME_MESSAGE_TYPES,
    PACKAGING_ENV_KEYS,
    categorizeFailureCode,
    resolveFailureCategory,
    buildAnalysisContractSnapshot
  });
});

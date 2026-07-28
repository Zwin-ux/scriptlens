(function (root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  const globalRoot = root || globalThis;
  globalRoot.ScriptLensContracts = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const CONTRACT_VERSION = "2026-03-11";

  const ORIGIN_KINDS = Object.freeze({
    youtubeTranscript: "youtube_transcript",
    manualCaptionTrack: "manual_caption_track",
    generatedCaptionTrack: "generated_caption_track",
    headlessTranscript: "headless_transcript",
    audioAsr: "audio_asr",
    fallbackText: "fallback_text",
    unavailable: "unavailable"
  });

  const RECOVERY_TIERS = Object.freeze({
    local: "local",
    hostedTranscript: "hosted_transcript",
    hostedAsr: "hosted_asr"
  });

  const SOURCE_TRUST_TIERS = Object.freeze({
    directTranscript: "direct-transcript",
    captionDerived: "caption-derived",
    headlessDerived: "headless-derived",
    audioDerived: "audio-derived",
    fallbackText: "fallback-text",
    unavailable: "unavailable"
  });

  const SCORING_STATUSES = Object.freeze({
    scored: "scored",
    insufficientInput: "insufficient-input",
    error: "error"
  });

  const FAILURE_CATEGORIES = Object.freeze({
    policy: "policy",
    quality: "quality",
    timeout: "timeout",
    transport: "transport",
    authSession: "auth-session",
    transcriptSource: "transcript-source",
    tooling: "tooling",
    request: "request",
    server: "server",
    unknown: "unknown"
  });

  const RUNTIME_MESSAGE_TYPES = Object.freeze({
    inlineInit: "inline:init",
    inlineAnalyze: "inline:analyze",
    panelOpen: "panel:open"
  });

  const PACKAGING_ENV_KEYS = Object.freeze({
    backendEndpoint: "SCRIPTLENS_BACKEND_ENDPOINT",
    backendOrigin: "SCRIPTLENS_BACKEND_ORIGIN",
    publicSiteOrigin: "SCRIPTLENS_PUBLIC_SITE_ORIGIN",
    enableDefuddleExperiment: "SCRIPTLENS_ENABLE_DEFUDDLE_EXPERIMENT"
  });

  const POLICY_FAILURE_CODES = new Set([
    "rate_limited",
    "asr_disabled",
    "asr_duration_limit",
    "asr_duration_absolute_limit",
    "asr_circuit_open",
    "client_concurrency_limited",
    "backend_transcript_jobs_saturated",
    "backend_asr_jobs_saturated"
  ]);

  const QUALITY_FAILURE_CODES = new Set([
    "quality_gate_rejected",
    "language_mismatch",
    "language_requested_mismatch",
    "non_letter_noise",
    "insufficient_scoring_input"
  ]);

  const AUTH_FAILURE_CODES = new Set([
    "authenticated_session_missing",
    "authenticated_cookie_missing",
    "yt_dlp_auth_required",
    "asr_audio_browser_session_bot_gate",
    "backend_headless_consent_failed"
  ]);

  const REQUEST_FAILURE_CODES = new Set([
    "invalid_request",
    "invalid_json",
    "not_found",
    "unsupported_surface",
    "unsupported_source"
  ]);

  const SERVER_FAILURE_CODES = new Set([
    "backend_server_error",
    "backend_stage_failed"
  ]);

  // Failures caused by missing or misconfigured backend tooling.
  // Distinct from transcript-source failures: these indicate a capability gap
  // on the server side (yt-dlp not installed, ASR runtime missing, etc.) rather
  // than a YouTube-side or network-side failure.
  const TOOLING_FAILURE_CODES = new Set([
    "yt_dlp_not_configured",
    "yt_dlp_failed",
    "asr_not_configured",
    "asr_runtime_unavailable"
  ]);

  const TRANSCRIPT_SOURCE_FAILURE_CODES = new Set([
    "caption_tracks_missing",
    "caption_track_unavailable",
    "caption_fetch_failed",
    "youtubei_failed",
    "youtubei_failed_precondition",
    "youtubei_params_missing",
    "youtubei_bootstrap_incomplete",
    "youtubei_empty",
    "backend_headless_panel_failed",
    "backend_headless_segments_missing",
    "backend_headless_extract_failed",
    "asr_audio_browser_session_media_missing",
    "backend_transcript_unavailable"
  ]);

  function categorizeFailureCode(value) {
    const code = normalizeKey(value);
    if (!code) {
      return null;
    }
    if (POLICY_FAILURE_CODES.has(code)) {
      return FAILURE_CATEGORIES.policy;
    }
    if (QUALITY_FAILURE_CODES.has(code)) {
      return FAILURE_CATEGORIES.quality;
    }
    if (AUTH_FAILURE_CODES.has(code)) {
      return FAILURE_CATEGORIES.authSession;
    }
    if (REQUEST_FAILURE_CODES.has(code)) {
      return FAILURE_CATEGORIES.request;
    }
    if (SERVER_FAILURE_CODES.has(code)) {
      return FAILURE_CATEGORIES.server;
    }
    if (TOOLING_FAILURE_CODES.has(code)) {
      return FAILURE_CATEGORIES.tooling;
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
      recoveryTier: acquisition.recoveryTier || report?.recoveryTier || null,
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
    RECOVERY_TIERS,
    SOURCE_TRUST_TIERS,
    SCORING_STATUSES,
    FAILURE_CATEGORIES,
    TOOLING_FAILURE_CODES,
    RUNTIME_MESSAGE_TYPES,
    PACKAGING_ENV_KEYS,
    categorizeFailureCode,
    resolveFailureCategory,
    buildAnalysisContractSnapshot
  });
});

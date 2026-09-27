(function (root) {
  const ScriptLens = (root.ScriptLens = root.ScriptLens || {});
  const Transcript = (ScriptLens.transcript = ScriptLens.transcript || {});
  const PolicyApi = Transcript.policy || {};
  const Debug = root.ScriptLensDebug || {};
  const logger = Debug.createLogger
    ? Debug.createLogger("transcript-acquire")
    : console;

  const POLICY = PolicyApi.resolvePolicy ? PolicyApi.resolvePolicy() : null;
  const TOTAL_TIMEOUT_MS = POLICY?.timeouts?.extensionTotalMs || 15000;

  Transcript.acquire = {
    resolveBestTranscript
  };

  async function resolveBestTranscript(context) {
    const youtubeResolver = Transcript.providers?.youtubeResolver;
    const totalTimeoutMs = Number(context?.totalTimeoutMs) || TOTAL_TIMEOUT_MS;
    const traceId = context?.traceId || buildTraceId();

    logger.info("resolveBestTranscript:start", {
      traceId,
      totalTimeoutMs,
      videoId: context?.adapter?.videoId || "",
      analysisMode:
        context?.analysisMode ||
        PolicyApi.ANALYSIS_MODES?.youtubeTranscriptFirst ||
        "youtube-transcript-first",
      surface: context?.surface || "unknown"
    });

    const localResult = await youtubeResolver.resolve({
      ...context,
      traceId,
      totalTimeoutMs
    });
    const navigationChanged = Transcript.normalize
      .getFailureCodes(localResult)
      .includes("navigation_changed");

    const result = Transcript.normalize.isEligibleTranscriptCandidate(localResult)
      ? localResult
      : convertCandidateToUnavailable(
          localResult,
          navigationChanged ? "navigation-changed" : null
        );
    logger.info("resolveBestTranscript:result", {
      traceId,
      result: summarizeCandidate(result)
    });
    return Transcript.normalize.stripInternalFields(result);
  }

  function convertCandidateToUnavailable(candidate, reason) {
    if (!candidate) {
      return Transcript.normalize.buildUnavailableResult({
        failureReason: reason || "resolver_exhausted",
        winnerReason: reason || "resolver_exhausted",
        winnerSelectedBy: [reason || "resolver_exhausted"]
      });
    }

    if (!candidate.ok) {
      return {
        ...candidate,
        winnerReason: candidate.winnerReason || reason || candidate.failureReason || null
      };
    }

    return Transcript.normalize.buildUnavailableResult({
      analysisMode: candidate.analysisMode,
      provider: candidate.provider,
      providerClass: candidate.providerClass,
      strategy: candidate.strategy,
      sourceLabel: "Transcript unavailable",
      requestedLanguageCode: candidate.requestedLanguageCode,
      videoDurationSeconds: candidate.videoDurationSeconds,
      warnings: []
        .concat(candidate.warnings || [])
        .concat(reason ? [reason] : []),
      errors: candidate.errors || [],
      resolverAttempts: candidate.resolverAttempts || [],
      resolverPath: candidate.resolverPath || [],
      winnerReason:
        candidate.winnerReason ||
        reason ||
        firstReason(candidate.qualityGate?.rejectedReasons) ||
        "quality_gate_rejected",
      winnerSelectedBy: []
        .concat(candidate.winnerSelectedBy || [])
        .concat(reason ? [reason] : []),
      failureReason:
        firstReason(candidate.qualityGate?.rejectedReasons) ||
        reason ||
        candidate.failureReason ||
        "quality_gate_rejected"
    });
  }

  function buildTraceId() {
    return `trace-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  }

  function summarizeCandidate(candidate) {
    if (!candidate) {
      return null;
    }

    return {
      ok: Boolean(candidate.ok),
      provider: candidate.provider || null,
      providerClass: candidate.providerClass || null,
      strategy: candidate.strategy || null,
      originKind: candidate.originKind || null,
      sourceTrustTier: candidate.sourceTrustTier || null,
      quality: candidate.quality || null,
      sourceConfidence: candidate.sourceConfidence || null,
      winnerReason: candidate.winnerReason || null,
      qualityGate: candidate.qualityGate || null,
      failureReason: candidate.failureReason || null,
      warnings: Array.isArray(candidate.warnings) ? candidate.warnings.slice(0, 8) : [],
      errors: Array.isArray(candidate.errors)
        ? candidate.errors.slice(0, 6).map((error) => ({
            strategy: error?.strategy || "",
            code: error?.code || ""
          }))
        : []
    };
  }

  function firstReason(values) {
    return Array.isArray(values) && values.length ? values[0] : null;
  }
})(globalThis);

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
  const BACKEND_TIMEOUT_MS = POLICY?.timeouts?.backendTranscriptMs || 7000;
  const BACKEND_ASR_TIMEOUT_MS = POLICY?.timeouts?.backendAsrMs || 30000;

  Transcript.acquire = {
    resolveBestTranscript
  };

  async function resolveBestTranscript(context) {
    const youtubeResolver = Transcript.providers?.youtubeResolver;
    const backendResolver = Transcript.providers?.backendResolver;
    const startedAt = Date.now();
    const totalTimeoutMs = Number(context?.totalTimeoutMs) || TOTAL_TIMEOUT_MS;
    const traceId = context?.traceId || buildTraceId();

    logger.info("resolveBestTranscript:start", {
      traceId,
      totalTimeoutMs,
      allowBackendTranscriptFallback: Boolean(context?.allowBackendTranscriptFallback),
      videoId: context?.adapter?.videoId || "",
      analysisMode:
        context?.analysisMode ||
        PolicyApi.ANALYSIS_MODES?.youtubeTranscriptFirst ||
        "youtube-transcript-first",
      surface: context?.surface || "unknown",
      backendEndpoint: String(context?.backendEndpoint || "").trim()
    });

    const localResult = await youtubeResolver.resolve({
      ...context,
      traceId,
      totalTimeoutMs
    });
    const escalation = Transcript.normalize.shouldEscalateToBackend(localResult);
    logger.info("resolveBestTranscript:localResult", {
      traceId,
      escalation,
      localResult: summarizeCandidate(localResult)
    });

    if (
      !context?.allowBackendTranscriptFallback ||
      escalation.reason === "navigation_changed" ||
      !backendResolver
    ) {
      const localOnlyResult = Transcript.normalize.isEligibleTranscriptCandidate(localResult)
        ? localResult
        : convertCandidateToUnavailable(
            localResult,
            !context?.allowBackendTranscriptFallback
              ? "backend-disabled"
              : escalation.reason === "navigation_changed"
                ? "navigation-changed"
                : "backend-missing"
          );
      logger.info("resolveBestTranscript:returnLocal", {
        traceId,
        reason: !context?.allowBackendTranscriptFallback
          ? "backend-disabled"
          : escalation.reason === "navigation_changed"
            ? "navigation-changed"
            : "backend-missing"
      });
      return Transcript.normalize.stripInternalFields(localOnlyResult);
    }

    const remainingEndToEndMs = Math.max(0, totalTimeoutMs - (Date.now() - startedAt));
    if (!escalation.shouldEscalate || remainingEndToEndMs <= 0) {
      const localResolvedResult = Transcript.normalize.isEligibleTranscriptCandidate(localResult)
        ? localResult
        : convertCandidateToUnavailable(
            localResult,
            remainingEndToEndMs <= 0 ? "backend-time-budget-exhausted" : escalation.reason
          );
      logger.info("resolveBestTranscript:skipBackend", {
        traceId,
        escalation,
        remainingEndToEndMs
      });
      return Transcript.normalize.stripInternalFields(localResolvedResult);
    }

    const backendResult = await backendResolver.resolve({
      ...context,
      traceId,
      remainingEndToEndMs,
      backendTimeoutMs: Math.min(
        context?.allowAutomaticAsr !== false ? BACKEND_ASR_TIMEOUT_MS : BACKEND_TIMEOUT_MS,
        remainingEndToEndMs
      ),
      analysisMode:
        context?.analysisMode ||
        PolicyApi.ANALYSIS_MODES?.youtubeTranscriptFirst ||
        "youtube-transcript-first"
    });
    logger.info("resolveBestTranscript:backendResult", {
      traceId,
      backendResult: summarizeCandidate(backendResult)
    });

    const winner = finalizeWinner(localResult, backendResult, chooseWinner(localResult, backendResult));
    logger.info("resolveBestTranscript:winner", {
      traceId,
      winner: summarizeCandidate(winner)
    });
    return Transcript.normalize.stripInternalFields(winner);
  }

  function finalizeWinner(localResult, backendResult, candidate) {
    if (Transcript.normalize.isEligibleTranscriptCandidate(candidate)) {
      return candidate;
    }

    return mergeUnavailable(candidate, backendResult === candidate ? localResult : backendResult, [
      candidate?.winnerReason || firstReason(candidate) || "no-eligible-transcript"
    ]);
  }

  function chooseWinner(localResult, backendResult) {
    if (!backendResult) {
      return Transcript.normalize.isEligibleTranscriptCandidate(localResult)
        ? localResult
        : convertCandidateToUnavailable(localResult, "backend-unavailable");
    }

    if (!localResult) {
      return Transcript.normalize.isEligibleTranscriptCandidate(backendResult)
        ? backendResult
        : convertCandidateToUnavailable(backendResult, "backend-ineligible");
    }

    if (!backendResult.ok) {
      if (Transcript.normalize.isEligibleTranscriptCandidate(localResult)) {
        return mergeAcquisition(localResult, backendResult, ["backend-unavailable"]);
      }
      return mergeUnavailable(localResult, backendResult, ["backend-unavailable"]);
    }

    if (!Transcript.normalize.isEligibleTranscriptCandidate(localResult)) {
      return mergeAcquisition(backendResult, localResult, ["backend-over-local-unavailable"]);
    }

    const comparison = Transcript.normalize.compareCandidates(localResult, backendResult);
    const primary = comparison.winner;
    const secondary = primary === localResult ? backendResult : localResult;
    return mergeAcquisition(primary, secondary, comparison.reasons);
  }

  function mergeAcquisition(primary, secondary, selectionReasons) {
    return {
      ...primary,
      warnings: dedupeList([]
        .concat(primary.warnings || [])
        .concat(secondary?.warnings || [])),
      errors: []
        .concat(primary.errors || [])
        .concat(secondary?.errors || []),
      resolverAttempts: []
        .concat(primary.resolverAttempts || [])
        .concat(secondary?.resolverAttempts || []),
      resolverPath: []
        .concat(primary.resolverPath || [])
        .concat(
          (secondary?.resolverPath || []).filter(
            (entry) => !(primary.resolverPath || []).includes(entry)
          )
        ),
      winnerReason: firstReason(selectionReasons) || primary.winnerReason || null,
      winnerSelectedBy: []
        .concat(selectionReasons || [])
        .concat(secondary?.winnerSelectedBy || [])
    };
  }

  function mergeUnavailable(left, right, reasons) {
    return Transcript.normalize.buildUnavailableResult({
      provider: left?.provider || right?.provider || "youtubeResolver",
      providerClass: "local",
      strategy: left?.strategy || "transcript-unavailable",
      sourceLabel: "Transcript unavailable",
      sourceConfidence: "low",
      requestedLanguageCode:
        left?.requestedLanguageCode || right?.requestedLanguageCode || null,
      videoDurationSeconds:
        left?.videoDurationSeconds || right?.videoDurationSeconds || null,
      warnings: dedupeList([]
        .concat(left?.warnings || [])
        .concat(right?.warnings || [])),
      errors: []
        .concat(left?.errors || [])
        .concat(right?.errors || []),
      resolverAttempts: []
        .concat(left?.resolverAttempts || [])
        .concat(right?.resolverAttempts || []),
      resolverPath: []
        .concat(left?.resolverPath || [])
        .concat(right?.resolverPath || []),
      winnerReason: firstReason(reasons) || left?.winnerReason || right?.winnerReason || null,
      winnerSelectedBy: reasons || ["no-usable-candidate"],
      failureReason:
        left?.failureReason ||
        right?.failureReason ||
        firstReason(left?.qualityGate?.rejectedReasons) ||
        firstReason(right?.qualityGate?.rejectedReasons) ||
        "resolver_exhausted"
    });
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

  function dedupeList(values) {
    const seen = new Set();
    return values.filter((value) => {
      const key = String(value || "");
      if (!key || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
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

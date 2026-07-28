(function (root) {
  const ScriptLens = (root.ScriptLens = root.ScriptLens || {});
  const Transcript = (ScriptLens.transcript = ScriptLens.transcript || {});
  const PolicyApi = Transcript.policy || {};
  const Text = (root.AIScriptDetector || {}).text;
  const Stats = (root.AIScriptDetector || {}).stats;

  const POLICY = PolicyApi.resolvePolicy ? PolicyApi.resolvePolicy() : buildFallbackPolicy();

  const STRATEGY_PRIORITY = {
    "youtubei-transcript": 1,
    "caption-track": 2,
    "dom-transcript": 3,
    "backend-transcript": 4,
    "backend-headless-transcript": 5,
    "backend-asr": 6,
    "description-transcript": 7,
    "title-description": 8,
    "local-whisper": 9
  };

  const CONFIDENCE_RANK = {
    high: 3,
    medium: 2,
    low: 1
  };

  const QUALITY_RANK = {
    "strong-transcript": 3,
    "partial-transcript": 2,
    "weak-fallback": 1,
    "enhanced-extraction-unavailable": 0
  };

  const VALID_CONFIDENCES = new Set(["high", "medium", "low"]);
  const VALID_QUALITIES = new Set([
    "strong-transcript",
    "partial-transcript",
    "weak-fallback",
    "enhanced-extraction-unavailable"
  ]);

  const TRANSCRIPT_STRATEGIES = new Set([
    "youtubei-transcript",
    "caption-track",
    "dom-transcript",
    "backend-transcript",
    "backend-headless-transcript",
    "backend-asr"
  ]);

  const ESCALATION_FAILURE_CODES = new Set(
    Array.isArray(PolicyApi.ESCALATION_FAILURE_CODES)
      ? PolicyApi.ESCALATION_FAILURE_CODES
      : []
  );

  Transcript.normalize = {
    STRATEGY_PRIORITY,
    CONFIDENCE_RANK,
    QUALITY_RANK,
    normalizeCandidate,
    normalizeDirectAcquisition,
    normalizeAttempts,
    compareCandidates,
    buildUnavailableResult,
    stripInternalFields,
    isTranscriptStrategy,
    isTranscriptClassQuality,
    isRealTranscriptSource,
    isEligibleTranscriptCandidate,
    mapTranscriptAcquisitionState,
    shouldEscalateToBackend,
    getFailureCodes
  };

  function normalizeCandidate(rawCandidate, options) {
    const safeOptions = {
      maxTextLength: Number(options?.maxTextLength) || 18000,
      requestedLanguageCode: options?.requestedLanguageCode || null,
      analysisMode:
        options?.analysisMode ||
        rawCandidate?.analysisMode ||
        PolicyApi.ANALYSIS_MODES?.youtubeTranscriptFirst ||
        "youtube-transcript-first"
    };

    const strategy = rawCandidate?.strategy || "title-description";
    const provider = rawCandidate?.provider || "youtubeResolver";
    const providerClass = deriveProviderClass(rawCandidate?.providerClass, provider);
    const requestedLanguageCode = normalizeLanguage(
      rawCandidate?.requestedLanguageCode || safeOptions.requestedLanguageCode || null
    );
    const originKind = deriveOriginKind(rawCandidate, strategy);
    const sourceTrustTier = deriveSourceTrustTier(originKind);
    const recoveryTier = deriveRecoveryTier(rawCandidate, providerClass, originKind);
    const sourceLabel = buildSourceLabel(strategy, rawCandidate, originKind);
    const segments = normalizeSegments(rawCandidate?.segments || [], strategy);
    const rawText = buildCandidateText(rawCandidate, segments, strategy);
    const truncated = Text.smartTruncate(rawText, safeOptions.maxTextLength);
    const text = truncated.text;
    const wordCount = Text.countWords(text);
    const sentenceUnits = Text.splitSentences(text).length;
    const originalLanguageCode = normalizeLanguage(
      rawCandidate?.originalLanguageCode || rawCandidate?.languageCode || null
    );
    const languageCode = normalizeLanguage(
      rawCandidate?.languageCode || rawCandidate?.originalLanguageCode || null
    );
    const isTranslated = Boolean(rawCandidate?.isTranslated);
    const isMachineTranslated = Boolean(rawCandidate?.isMachineTranslated);
    const isGenerated =
      typeof rawCandidate?.isGenerated === "boolean" ? rawCandidate.isGenerated : null;
    const videoDurationSeconds = toFiniteNumber(rawCandidate?.videoDurationSeconds);
    const transcriptSpanSeconds =
      strategy === "title-description"
        ? null
        : toFiniteNumber(rawCandidate?.transcriptSpanSeconds) ??
          computeTranscriptSpanSeconds(segments);
    const coverageRatio = computeCoverageRatio({
      strategy,
      transcriptSpanSeconds,
      videoDurationSeconds,
      segmentCount: segments.length,
      text
    });
    const avgSegmentLength =
      strategy === "title-description" || !segments.length
        ? null
        : roundTo(
            average(
              segments.map((segment) => Math.max(1, Text.countWords(segment.text || "")))
            ),
            1
          );
    const segmentQualityScore =
      toFiniteNumber(rawCandidate?.segmentQualityScore) ??
      (strategy === "title-description" ? 0 : computeSegmentQualityScore(segments));
    const uniqueSegmentRatio =
      strategy === "title-description" ? null : computeUniqueSegmentRatio(segments);
    const averageWordsPerSegment =
      strategy === "title-description" ? null : computeAverageWordsPerSegment(segments);
    const nonLetterCharacterRatio = computeNonLetterCharacterRatio(text);
    const languageDecision = evaluateLanguageDecision({
      requestedLanguageCode,
      languageCode,
      originalLanguageCode,
      isTranslated,
      isMachineTranslated
    });

    let sourceConfidence =
      normalizeConfidence(rawCandidate?.sourceConfidence) ||
      deriveSourceConfidence(strategy, isGenerated, providerClass, originKind);
    if (languageDecision.status === "downgrade") {
      sourceConfidence = downgradeConfidence(sourceConfidence);
    }
    if (sourceTrustTier === "audio-derived") {
      sourceConfidence = downgradeConfidence(sourceConfidence);
    }

    const qualityGate = buildTranscriptQualityGate({
      strategy,
      text,
      wordCount,
      sentenceUnits,
      segmentCount: segments.length,
      coverageRatio,
      videoDurationSeconds,
      transcriptSpanSeconds,
      uniqueSegmentRatio,
      averageWordsPerSegment,
      nonLetterCharacterRatio,
      originKind,
      sourceTrustTier,
      languageDecision
    });
    const usableTranscript = isUsableTranscript(strategy, qualityGate);
    const computedQuality = deriveQuality({
      strategy,
      text,
      usableTranscript,
      sourceConfidence,
      coverageRatio,
      transcriptSpanSeconds,
      segmentQualityScore
    });
    const quality = normalizeQuality(rawCandidate?.quality) || computedQuality;

    const warnings = dedupeList(
      []
        .concat(rawCandidate?.warnings || [])
        .concat(strategy === "title-description" ? ["fallback_source", "weak_evidence"] : [])
        .concat(strategy === "description-transcript" ? ["weak_evidence"] : [])
        .concat(isGenerated ? ["generated_captions"] : [])
        .concat(isTranslated ? ["translated_text"] : [])
        .concat(providerClass === "backend" ? ["backend_fallback_used"] : [])
        .concat(sourceTrustTier === "audio-derived" ? ["audio_derived_reduced_trust"] : [])
        .concat(sourceTrustTier === "headless-derived" ? ["headless_recovery"] : [])
        .concat(languageDecision.warningCodes)
        .concat(
          qualityGate && !qualityGate.eligible
            ? ["quality_gate_rejected"].concat(
                qualityGate.rejectedReasons.map((reason) => `quality_gate:${reason}`)
              )
            : []
        )
    );

    const ok = Boolean(text);
    const errors = Array.isArray(rawCandidate?.errors) ? rawCandidate.errors.slice() : [];
    const failureReason =
      rawCandidate?.failureReason ||
      (!ok ? deriveFailureReason(rawCandidate, errors) : null);
    const winnerReason =
      String(rawCandidate?.winnerReason || "").trim() ||
      firstListValue(rawCandidate?.winnerSelectedBy) ||
      null;

    return {
      ok,
      kind: "transcript",
      analysisMode: safeOptions.analysisMode,
      provider,
      providerClass,
      strategy,
      sourceLabel,
      sourceConfidence,
      quality,
      acquisitionState: mapTranscriptAcquisitionState(quality, ok),
      transcriptRequiredSatisfied: usableTranscript,
      failureReason,
      recoveryTier,
      originKind,
      sourceTrustTier,
      winnerReason,
      languageCode,
      originalLanguageCode,
      requestedLanguageCode,
      isGenerated,
      isTranslated,
      isMachineTranslated,
      segmentCount: strategy === "title-description" ? 0 : segments.length,
      avgSegmentLength,
      coverageRatio,
      videoDurationSeconds,
      transcriptSpanSeconds:
        strategy === "title-description" ? null : transcriptSpanSeconds,
      segmentQualityScore: strategy === "title-description" ? 0 : segmentQualityScore,
      truncated: Boolean(truncated.truncated),
      warnings,
      errors,
      resolverAttempts: normalizeAttempts(rawCandidate?.resolverAttempts || []),
      resolverPath: Array.isArray(rawCandidate?.resolverPath)
        ? rawCandidate.resolverPath.slice()
        : [],
      winnerSelectedBy: Array.isArray(rawCandidate?.winnerSelectedBy)
        ? rawCandidate.winnerSelectedBy.slice()
        : [],
      requestShapeValidation: rawCandidate?.requestShapeValidation || null,
      qualityGate,
      text,
      segments,
      __segmentQualityScore: segmentQualityScore,
      __wordCount: wordCount,
      __sentenceUnits: sentenceUnits,
      __uniqueSegmentRatio: uniqueSegmentRatio,
      __averageWordsPerSegment: averageWordsPerSegment,
      __nonLetterCharacterRatio: nonLetterCharacterRatio,
      __usableTranscript: usableTranscript,
      __priorityRank: STRATEGY_PRIORITY[strategy] || 99
    };
  }

  function normalizeDirectAcquisition(rawCandidate, options) {
    const safeOptions = {
      maxTextLength: Number(options?.maxTextLength) || 18000,
      analysisMode:
        options?.analysisMode ||
        PolicyApi.ANALYSIS_MODES?.genericText ||
        "generic-text"
    };
    const kind = normalizeDirectKind(rawCandidate?.kind || rawCandidate?.sourceType);
    const rawText = Text.sanitizeInput(rawCandidate?.text || "");
    const truncated = Text.smartTruncate(rawText, safeOptions.maxTextLength);
    const text = truncated.text;
    const wordCount = Text.countWords(text);
    const coverageRatio = toFiniteNumber(
      rawCandidate?.coverageRatio ?? rawCandidate?.metadata?.coverageRatio
    );
    const blockCount = Math.max(
      0,
      Math.round(
        Number(rawCandidate?.blockCount ?? rawCandidate?.metadata?.blockCount) || 0
      )
    );
    const paragraphCount = Text.splitParagraphs(text).length;
    const sourceConfidence = deriveDirectSourceConfidence({
      kind,
      wordCount,
      blockCount,
      paragraphCount,
      coverageRatio
    });
    const quality = deriveDirectQuality(text, sourceConfidence);
    const warnings = dedupeList(
      []
        .concat(rawCandidate?.warnings || [])
        .concat(sourceConfidence === "low" ? ["weak_evidence"] : [])
        .concat(kind === "selection" ? ["limited_context"] : [])
        .concat(
          kind === "page-content" &&
            coverageRatio !== null &&
            coverageRatio < 0.18
            ? ["page_capture_noise"]
            : []
        )
    );

    return {
      ok: Boolean(text),
      kind,
      analysisMode: safeOptions.analysisMode,
      provider: null,
      providerClass: "local",
      strategy: null,
      sourceLabel: buildDirectSourceLabel(kind, rawCandidate),
      sourceConfidence,
      quality,
      acquisitionState: null,
      transcriptRequiredSatisfied: true,
      failureReason: null,
      recoveryTier: null,
      originKind: null,
      sourceTrustTier: null,
      winnerReason: null,
      languageCode: normalizeLanguage(rawCandidate?.languageCode || null),
      originalLanguageCode: normalizeLanguage(rawCandidate?.originalLanguageCode || null),
      requestedLanguageCode: null,
      isGenerated: null,
      isTranslated: false,
      isMachineTranslated: false,
      segmentCount: 0,
      avgSegmentLength: null,
      coverageRatio,
      videoDurationSeconds: null,
      transcriptSpanSeconds: null,
      segmentQualityScore: null,
      truncated: Boolean(truncated.truncated),
      warnings,
      errors: Array.isArray(rawCandidate?.errors) ? rawCandidate.errors.slice() : [],
      resolverAttempts: normalizeAttempts(rawCandidate?.resolverAttempts || []),
      resolverPath: Array.isArray(rawCandidate?.resolverPath)
        ? rawCandidate.resolverPath.slice()
        : [],
      winnerSelectedBy: Array.isArray(rawCandidate?.winnerSelectedBy)
        ? rawCandidate.winnerSelectedBy.slice()
        : [],
      requestShapeValidation: null,
      qualityGate: null,
      text,
      segments: [],
      __wordCount: wordCount,
      __paragraphCount: paragraphCount
    };
  }

  function normalizeAttempts(attempts) {
    return (Array.isArray(attempts) ? attempts : []).map((attempt) => ({
      provider: attempt.provider || "youtubeResolver",
      strategy: attempt.strategy || "title-description",
      ok: Boolean(attempt.ok),
      skipped: Boolean(attempt.skipped),
      durationMs: Math.max(0, Math.round(Number(attempt.durationMs) || 0)),
      sourceConfidence: attempt.sourceConfidence || null,
      warningCodes: Array.isArray(attempt.warningCodes) ? attempt.warningCodes.slice() : [],
      errorCode: attempt.errorCode || null
    }));
  }

  function buildUnavailableResult(input) {
    const errors = Array.isArray(input?.errors) ? input.errors.slice() : [];
    const warnings = dedupeList(
      []
        .concat(input?.warnings || [])
        .concat(input?.helperUnavailable ? ["enhanced_extraction_unavailable"] : [])
    );
    const winnerReason =
      String(input?.winnerReason || "").trim() ||
      firstListValue(input?.winnerSelectedBy) ||
      "no-usable-candidate";
    const failureReason =
      input?.failureReason || deriveFailureReason(input, errors) || "resolver_exhausted";

    return {
      ok: false,
      kind: "transcript",
      analysisMode:
        input?.analysisMode ||
        PolicyApi.ANALYSIS_MODES?.youtubeTranscriptFirst ||
        "youtube-transcript-first",
      provider: input?.provider || "youtubeResolver",
      providerClass: input?.providerClass || "local",
      strategy: input?.strategy || "transcript-unavailable",
      sourceLabel: input?.sourceLabel || "Transcript unavailable",
      sourceConfidence: input?.sourceConfidence || "low",
      quality: "enhanced-extraction-unavailable",
      acquisitionState: "transcript-unavailable",
      transcriptRequiredSatisfied: false,
      failureReason,
      recoveryTier: input?.recoveryTier || deriveFailureRecoveryTier(input),
      originKind: "unavailable",
      sourceTrustTier: "unavailable",
      winnerReason,
      languageCode: null,
      originalLanguageCode: null,
      requestedLanguageCode: normalizeLanguage(input?.requestedLanguageCode || null),
      isGenerated: null,
      isTranslated: false,
      isMachineTranslated: false,
      segmentCount: 0,
      avgSegmentLength: null,
      coverageRatio: null,
      videoDurationSeconds: toFiniteNumber(input?.videoDurationSeconds),
      transcriptSpanSeconds: null,
      segmentQualityScore: 0,
      truncated: false,
      warnings,
      errors,
      resolverAttempts: normalizeAttempts(input?.resolverAttempts || []),
      resolverPath: Array.isArray(input?.resolverPath) ? input.resolverPath.slice() : [],
      winnerSelectedBy: Array.isArray(input?.winnerSelectedBy)
        ? input.winnerSelectedBy.slice()
        : [],
      requestShapeValidation: input?.requestShapeValidation || null,
      qualityGate: {
        eligible: false,
        rejectedReasons: [failureReason],
        wordCount: 0,
        sentenceUnits: 0,
        coverageRatio: null
      },
      text: "",
      segments: []
    };
  }

  function stripInternalFields(value) {
    const clone = {};
    Object.keys(value || {}).forEach((key) => {
      if (!/^__/.test(key)) {
        clone[key] = value[key];
      }
    });
    return clone;
  }

  function compareCandidates(left, right) {
    if (!left) {
      return {
        winner: right,
        loser: left,
        reasons: ["single-candidate"]
      };
    }
    if (!right) {
      return {
        winner: left,
        loser: right,
        reasons: ["single-candidate"]
      };
    }

    const transcriptPriorityWinner = compareTranscriptPriority(left, right);
    if (transcriptPriorityWinner) {
      return transcriptPriorityWinner;
    }

    const leftEligible = isEligibleTranscriptCandidate(left);
    const rightEligible = isEligibleTranscriptCandidate(right);
    if (leftEligible !== rightEligible) {
      const winner = leftEligible ? left : right;
      const loser = winner === left ? right : left;
      return {
        winner,
        loser,
        reasons: [`quality-gate:${winner.strategy}`]
      };
    }

    const trustDelta = compareTrustOrder(left, right);
    if (trustDelta !== 0) {
      const winner = trustDelta < 0 ? left : right;
      const loser = winner === left ? right : left;
      return {
        winner,
        loser,
        reasons: [
          `trust-tier:${winner.sourceTrustTier || "unknown"}>${loser.sourceTrustTier || "unknown"}`
        ]
      };
    }

    const leftManual = left.isGenerated === false;
    const rightManual = right.isGenerated === false;
    const leftCoverage = normalizeComparableNumber(left.coverageRatio);
    const rightCoverage = normalizeComparableNumber(right.coverageRatio);
    const coverageGap = Math.abs(leftCoverage - rightCoverage);

    if (
      coverageGap <= POLICY.comparison.coverageManualBiasGap &&
      leftManual !== rightManual
    ) {
      const winner = leftManual ? left : right;
      const loser = winner === left ? right : left;
      return {
        winner,
        loser,
        reasons: ["manual-over-generated"]
      };
    }

    const languageWinner = compareLanguagePreference(left, right);
    if (languageWinner) {
      return languageWinner;
    }

    if (coverageGap > POLICY.comparison.coverageTieGap) {
      const winner = leftCoverage > rightCoverage ? left : right;
      const loser = winner === left ? right : left;
      return {
        winner,
        loser,
        reasons: [
          `coverage:${formatComparableNumber(winner.coverageRatio)}>${formatComparableNumber(loser.coverageRatio)}`
        ]
      };
    }

    const segmentQualityGap = Math.abs(
      (left.__segmentQualityScore || 0) - (right.__segmentQualityScore || 0)
    );
    if (segmentQualityGap > POLICY.comparison.segmentQualityGap) {
      const winner =
        (left.__segmentQualityScore || 0) > (right.__segmentQualityScore || 0)
          ? left
          : right;
      const loser = winner === left ? right : left;
      return {
        winner,
        loser,
        reasons: [
          `segment-quality:${Math.round(winner.__segmentQualityScore || 0)}>${Math.round(
            loser.__segmentQualityScore || 0
          )}`
        ]
      };
    }

    const leftVolume = calculateUsableVolume(left);
    const rightVolume = calculateUsableVolume(right);
    if (Math.abs(leftVolume - rightVolume) > POLICY.comparison.usableVolumeGap) {
      const winner = leftVolume > rightVolume ? left : right;
      const loser = winner === left ? right : left;
      return {
        winner,
        loser,
        reasons: [`usable-volume:${Math.round(leftVolume)}>${Math.round(rightVolume)}`]
      };
    }

    if (left.providerClass !== right.providerClass) {
      const winner = left.providerClass === "local" ? left : right;
      const loser = winner === left ? right : left;
      return {
        winner,
        loser,
        reasons: ["privacy-tiebreaker:local"]
      };
    }

    const winner = (left.__priorityRank || 99) <= (right.__priorityRank || 99) ? left : right;
    const loser = winner === left ? right : left;
    return {
      winner,
      loser,
      reasons: [`priority-tiebreaker:${winner.strategy}>${loser.strategy}`]
    };
  }

  function isTranscriptStrategy(strategy) {
    return TRANSCRIPT_STRATEGIES.has(strategy);
  }

  function isTranscriptClassQuality(quality) {
    return quality === "strong-transcript" || quality === "partial-transcript";
  }

  function isEligibleTranscriptCandidate(candidate) {
    return Boolean(
      candidate &&
        candidate.kind === "transcript" &&
        isTranscriptClassQuality(candidate.quality) &&
        candidate.qualityGate &&
        candidate.qualityGate.eligible === true
    );
  }

  function isRealTranscriptSource(candidate) {
    return isEligibleTranscriptCandidate(candidate);
  }

  function mapTranscriptAcquisitionState(quality, ok) {
    if (!ok || quality === "enhanced-extraction-unavailable") {
      return "transcript-unavailable";
    }
    if (quality === "strong-transcript") {
      return "transcript-acquired";
    }
    if (quality === "partial-transcript") {
      return "partial-transcript";
    }
    return "fallback-text-only";
  }

  function shouldEscalateToBackend(candidate) {
    const failureCodes = getFailureCodes(candidate);
    if (failureCodes.includes("navigation_changed")) {
      return {
        shouldEscalate: false,
        reason: "navigation_changed"
      };
    }

    if (failureCodes.some((code) => ESCALATION_FAILURE_CODES.has(code))) {
      return {
        shouldEscalate: true,
        reason: failureCodes.find((code) => ESCALATION_FAILURE_CODES.has(code))
      };
    }

    if (!candidate?.ok) {
      return {
        shouldEscalate: true,
        reason: "no_transcript_class_source"
      };
    }

    if (!isTranscriptClassQuality(candidate.quality)) {
      return {
        shouldEscalate: true,
        reason: "quality_below_threshold"
      };
    }

    if (!candidate.qualityGate?.eligible) {
      return {
        shouldEscalate: true,
        reason: firstListValue(candidate.qualityGate?.rejectedReasons) || "quality_gate_rejected"
      };
    }

    return {
      shouldEscalate: false,
      reason: "local_transcript_eligible"
    };
  }

  function getFailureCodes(candidate) {
    const codes = [];

    if (candidate?.failureReason) {
      codes.push(candidate.failureReason);
    }

    (candidate?.errors || []).forEach((error) => {
      if (error?.code) {
        codes.push(error.code);
      }
    });

    (candidate?.resolverAttempts || []).forEach((attempt) => {
      if (attempt?.errorCode) {
        codes.push(attempt.errorCode);
      }
    });

    return dedupeList(codes);
  }

  function compareTranscriptPriority(left, right) {
    const leftRealTranscript = isRealTranscriptSource(left);
    const rightRealTranscript = isRealTranscriptSource(right);
    if (leftRealTranscript !== rightRealTranscript) {
      const winner = leftRealTranscript ? left : right;
      const loser = winner === left ? right : left;
      return {
        winner,
        loser,
        reasons: ["transcript-over-fallback"]
      };
    }

    return null;
  }

  function compareLanguagePreference(left, right) {
    const leftDecision = left.qualityGate?.languageDecision || "ok";
    const rightDecision = right.qualityGate?.languageDecision || "ok";
    if (leftDecision !== rightDecision) {
      const winner = leftDecision === "ok" ? left : right;
      const loser = winner === left ? right : left;
      return {
        winner,
        loser,
        reasons: [`language-preference:${winner.languageCode || "unknown"}`]
      };
    }

    const leftOriginal = isCanonicalLanguageCandidate(left);
    const rightOriginal = isCanonicalLanguageCandidate(right);
    if (leftOriginal !== rightOriginal) {
      const winner = leftOriginal ? left : right;
      const loser = winner === left ? right : left;
      return {
        winner,
        loser,
        reasons: [`original-language:${leftOriginal}>${rightOriginal}`]
      };
    }

    return null;
  }

  function buildTranscriptQualityGate(input) {
    if (!TRANSCRIPT_STRATEGIES.has(input.strategy)) {
      return null;
    }

    const rejectedReasons = [];
    const thresholds = POLICY.thresholds;
    const effectiveThresholds = resolveAdaptiveTranscriptThresholds(
      thresholds,
      input.videoDurationSeconds,
      input.transcriptSpanSeconds
    );
    const coverageThreshold =
      input.originKind === "audio_asr"
        ? effectiveThresholds.minCoverageRatioAudio
        : effectiveThresholds.minCoverageRatioTranscript;

    if (!input.text || input.wordCount < effectiveThresholds.minWordCount) {
      rejectedReasons.push("word_count_below_threshold");
    }
    if ((input.sentenceUnits || 0) < effectiveThresholds.minSentenceUnits) {
      rejectedReasons.push("sentence_structure_below_threshold");
    }
    if (
      typeof input.coverageRatio === "number" &&
      input.coverageRatio < coverageThreshold
    ) {
      rejectedReasons.push("coverage_below_threshold");
    }
    if (
      typeof input.uniqueSegmentRatio === "number" &&
      input.uniqueSegmentRatio < thresholds.minUniqueSegmentRatio
    ) {
      rejectedReasons.push("repetition_detected");
    }
    if (
      input.segmentCount >= thresholds.minAverageWordsPerSegmentCount &&
      typeof input.averageWordsPerSegment === "number" &&
      input.averageWordsPerSegment < thresholds.minAverageWordsPerSegment
    ) {
      rejectedReasons.push("segments_too_sparse");
    }
    if (
      typeof input.nonLetterCharacterRatio === "number" &&
      input.nonLetterCharacterRatio > thresholds.maxNonLetterCharacterRatio
    ) {
      rejectedReasons.push("non_letter_noise");
    }
    if (input.languageDecision.status === "reject") {
      rejectedReasons.push("language_mismatch");
    }

    return {
      eligible: rejectedReasons.length === 0,
      rejectedReasons,
      wordCount: input.wordCount,
      sentenceUnits: input.sentenceUnits,
      coverageRatio:
        typeof input.coverageRatio === "number" ? input.coverageRatio : null,
      effectiveMinWordCount: effectiveThresholds.minWordCount,
      effectiveMinSentenceUnits: effectiveThresholds.minSentenceUnits,
      languageDecision: input.languageDecision.status
    };
  }

  function resolveAdaptiveTranscriptThresholds(thresholds, videoDurationSeconds, transcriptSpanSeconds) {
    const durationSeconds =
      toFiniteNumber(videoDurationSeconds) ||
      toFiniteNumber(transcriptSpanSeconds) ||
      null;
    if (!durationSeconds || durationSeconds >= 90) {
      return thresholds;
    }

    return {
      ...thresholds,
      minWordCount: Math.min(
        thresholds.minWordCount,
        Math.max(30, Math.ceil(durationSeconds * 1.5))
      ),
      minSentenceUnits: Math.min(
        thresholds.minSentenceUnits,
        Math.max(1, Math.ceil(durationSeconds / 30))
      )
    };
  }

  function evaluateLanguageDecision(input) {
    const requestedBase = baseLanguage(input.requestedLanguageCode);
    const languageBase = baseLanguage(input.languageCode);
    const originalBase = baseLanguage(input.originalLanguageCode);

    if (requestedBase) {
      const languageMatchesRequested = languageBase === requestedBase;
      const originalMatchesRequested = originalBase === requestedBase;

      if (!languageMatchesRequested && !originalMatchesRequested) {
        return {
          status: "reject",
          warningCodes: ["language_requested_mismatch"]
        };
      }

      if (
        !languageMatchesRequested &&
        originalMatchesRequested &&
        (input.isTranslated || input.isMachineTranslated)
      ) {
        return {
          status: "downgrade",
          warningCodes: ["translated_requested_language"]
        };
      }
    }

    if (!requestedBase) {
      if (
        (input.isTranslated || input.isMachineTranslated) &&
        languageBase &&
        originalBase &&
        languageBase !== originalBase
      ) {
        return {
          status: "downgrade",
          warningCodes: ["language_mismatch_downgrade", "translated_text"]
        };
      }
    }

    return {
      status: "ok",
      warningCodes: []
    };
  }

  function buildCandidateText(rawCandidate, segments, strategy) {
    if (strategy === "title-description") {
      return Text.sanitizeInput(rawCandidate?.text || "");
    }

    if (segments.length) {
      return Text.sanitizeInput(
        segments
          .map((segment) => segment.text)
          .filter(Boolean)
          .join("\n")
      );
    }

    return Text.sanitizeInput(rawCandidate?.text || "");
  }

  function normalizeSegments(segments, strategy) {
    if (strategy === "title-description") {
      return [];
    }

    return (Array.isArray(segments) ? segments : [])
      .map((segment) => ({
        startMs: toFiniteNumber(segment?.startMs),
        durationMs: toFiniteNumber(segment?.durationMs),
        text: Text.sanitizeInput(segment?.text || "")
      }))
      .filter((segment) => Boolean(segment.text));
  }

  function deriveProviderClass(explicitValue, provider) {
    const value = String(explicitValue || "").trim().toLowerCase();
    if (value === "backend") {
      return "backend";
    }
    if (value === "local") {
      return "local";
    }

    return /backend/i.test(String(provider || "")) ? "backend" : "local";
  }

  function deriveSourceConfidence(strategy, isGenerated, providerClass, originKind) {
    if (originKind === "audio_asr") {
      return "low";
    }
    if (originKind === "headless_transcript") {
      return "medium";
    }
    if (providerClass === "backend" && strategy === "backend-transcript") {
      return "high";
    }
    if (strategy === "youtubei-transcript") {
      return "medium";
    }
    if (strategy === "caption-track") {
      return isGenerated ? "medium" : "high";
    }
    if (strategy === "dom-transcript") {
      return "medium";
    }
    if (strategy === "description-transcript" || strategy === "title-description") {
      return "low";
    }
    return providerClass === "backend" ? "high" : "medium";
  }

  function deriveDirectSourceConfidence(input) {
    if (!input.wordCount) {
      return "low";
    }

    if (input.kind === "manual-input") {
      if (input.wordCount >= 500) {
        return "high";
      }
      return input.wordCount >= 180 ? "medium" : "low";
    }

    if (input.kind === "selection") {
      if (input.wordCount >= 320) {
        return "high";
      }
      return input.wordCount >= 110 ? "medium" : "low";
    }

    if (input.kind === "article-content") {
      if (
        input.wordCount >= 450 &&
        input.blockCount >= 5 &&
        (input.coverageRatio === null || input.coverageRatio >= 0.18)
      ) {
        return "high";
      }
      return input.wordCount >= 180 ? "medium" : "low";
    }

    if (input.kind === "page-content") {
      if (
        input.wordCount >= 550 &&
        input.blockCount >= 6 &&
        (input.coverageRatio === null || input.coverageRatio >= 0.24)
      ) {
        return "high";
      }
      return input.wordCount >= 180 ? "medium" : "low";
    }

    return input.wordCount >= 180 ? "medium" : "low";
  }

  function deriveQuality(input) {
    if (!input.text) {
      return "enhanced-extraction-unavailable";
    }

    if (
      TRANSCRIPT_STRATEGIES.has(input.strategy) &&
      input.usableTranscript &&
      input.sourceConfidence === "high" &&
      (((input.coverageRatio || 0) >= 0.45) || ((input.transcriptSpanSeconds || 0) >= 120)) &&
      input.segmentQualityScore >= 60
    ) {
      return "strong-transcript";
    }

    if (TRANSCRIPT_STRATEGIES.has(input.strategy)) {
      return "partial-transcript";
    }

    if (input.strategy === "description-transcript" || input.strategy === "title-description") {
      return "weak-fallback";
    }

    return "enhanced-extraction-unavailable";
  }

  function deriveDirectQuality(text, sourceConfidence) {
    if (!text) {
      return "enhanced-extraction-unavailable";
    }
    if (sourceConfidence === "high") {
      return "strong-transcript";
    }
    if (sourceConfidence === "medium") {
      return "partial-transcript";
    }
    return "weak-fallback";
  }

  function isUsableTranscript(strategy, qualityGate) {
    if (!TRANSCRIPT_STRATEGIES.has(strategy)) {
      return false;
    }
    return Boolean(qualityGate?.eligible);
  }

  function computeCoverageRatio(input) {
    if (!input.text) {
      return null;
    }

    if (input.strategy === "title-description") {
      return null;
    }

    if (isFiniteNumber(input.transcriptSpanSeconds) && isFiniteNumber(input.videoDurationSeconds)) {
      return roundTo(
        Stats.clamp(input.transcriptSpanSeconds / Math.max(1, input.videoDurationSeconds), 0, 1),
        3
      );
    }

    if (input.segmentCount > 0) {
      return roundTo(
        Stats.clamp(Math.max(input.segmentCount / 48, Text.countWords(input.text) / 900), 0, 1),
        3
      );
    }

    return null;
  }

  function computeTranscriptSpanSeconds(segments) {
    const withTimestamps = segments.filter((segment) => isFiniteNumber(segment.startMs));
    if (!withTimestamps.length) {
      return null;
    }

    const startMs = Math.min(...withTimestamps.map((segment) => segment.startMs));
    const endMs = Math.max(
      ...withTimestamps.map((segment) => segment.startMs + Math.max(segment.durationMs || 0, 0))
    );
    if (!isFiniteNumber(startMs) || !isFiniteNumber(endMs) || endMs <= startMs) {
      return null;
    }

    return roundTo((endMs - startMs) / 1000, 1);
  }

  function computeSegmentQualityScore(segments) {
    if (!segments.length) {
      return 0;
    }

    const timestampRatio =
      segments.filter((segment) => isFiniteNumber(segment.startMs)).length / segments.length;
    const avgWords = average(
      segments.map((segment) => Math.max(1, Text.countWords(segment.text || "")))
    );
    const nearEmptyRatio =
      segments.filter((segment) => Text.countWords(segment.text || "") <= 1).length /
      segments.length;
    const monotonicity = computeMonotonicity(segments);
    const countScore = Stats.normalizeRange(segments.length, 4, 48) * 25;
    const timestampScore = timestampRatio * 30;
    const continuityScore = monotonicity * 15;
    const densityScore = Math.max(0, 20 - Math.abs(avgWords - 10) * 2);
    const emptyPenalty = nearEmptyRatio * 20;

    return Math.round(
      Stats.clamp(countScore + timestampScore + continuityScore + densityScore - emptyPenalty, 0, 100)
    );
  }

  function computeMonotonicity(segments) {
    const values = segments
      .map((segment) => segment.startMs)
      .filter((value) => isFiniteNumber(value));
    if (values.length <= 1) {
      return 0;
    }

    let monotonicPairs = 0;
    for (let index = 1; index < values.length; index += 1) {
      if (values[index] >= values[index - 1]) {
        monotonicPairs += 1;
      }
    }
    return monotonicPairs / Math.max(1, values.length - 1);
  }

  function computeUniqueSegmentRatio(segments) {
    if (!Array.isArray(segments) || !segments.length) {
      return null;
    }
    const unique = new Set(
      segments
        .map((segment) => Text.sanitizeInput(segment.text || "").toLowerCase())
        .filter(Boolean)
    );
    return roundTo(unique.size / Math.max(1, segments.length), 3);
  }

  function computeAverageWordsPerSegment(segments) {
    if (!Array.isArray(segments) || !segments.length) {
      return null;
    }
    return roundTo(
      average(
        segments.map((segment) => Math.max(0, Text.countWords(segment.text || "")))
      ),
      2
    );
  }

  function computeNonLetterCharacterRatio(text) {
    const source = String(text || "").replace(/\s+/g, "");
    if (!source) {
      return 0;
    }
    const nonLetterCount = source.replace(/[A-Za-z0-9]/g, "").length;
    return roundTo(nonLetterCount / Math.max(1, source.length), 3);
  }

  function calculateUsableVolume(candidate) {
    const span = normalizeComparableNumber(candidate.transcriptSpanSeconds) * 120;
    const words = normalizeComparableNumber(candidate.__wordCount || 0);
    return span + words;
  }

  function buildSourceLabel(strategy, rawCandidate, originKind) {
    if (rawCandidate?.sourceLabel) {
      return rawCandidate.sourceLabel;
    }
    if (originKind === "audio_asr") {
      return "Audio-derived transcript";
    }
    if (originKind === "headless_transcript") {
      return "Headless transcript recovery";
    }
    if (strategy === "youtubei-transcript") {
      return rawCandidate?.trackLabel || "YouTube transcript";
    }
    if (strategy === "caption-track") {
      return rawCandidate?.trackLabel || "Caption track";
    }
    if (strategy === "dom-transcript") {
      return "Visible transcript";
    }
    if (strategy === "backend-transcript") {
      return "Recovered transcript";
    }
    if (strategy === "backend-headless-transcript") {
      return "Recovered transcript";
    }
    if (strategy === "backend-asr") {
      return "Audio-derived transcript";
    }
    if (strategy === "description-transcript") {
      return "Description transcript";
    }
    if (strategy === "title-description") {
      return "Title + description fallback";
    }
    if (strategy === "local-whisper") {
      return "Recovered transcript";
    }
    return "Transcript source";
  }

  function buildDirectSourceLabel(kind, rawCandidate) {
    if (rawCandidate?.sourceLabel) {
      return rawCandidate.sourceLabel;
    }

    if (kind === "manual-input") {
      return "Pasted text";
    }
    if (kind === "selection") {
      return "Selected text";
    }
    if (kind === "article-content") {
      return "Article content";
    }
    return "Visible page content";
  }

  function isCanonicalLanguageCandidate(candidate) {
    if (candidate.isMachineTranslated || candidate.isTranslated) {
      return false;
    }
    if (!candidate.languageCode || !candidate.originalLanguageCode) {
      return true;
    }
    return baseLanguage(candidate.languageCode) === baseLanguage(candidate.originalLanguageCode);
  }

  function deriveFailureReason(rawCandidate, errors) {
    if (rawCandidate?.failureReason) {
      return rawCandidate.failureReason;
    }

    if (Array.isArray(errors) && errors.length) {
      return errors[0].code || null;
    }

    if (Array.isArray(rawCandidate?.resolverAttempts)) {
      const failedAttempt = rawCandidate.resolverAttempts.find((attempt) => attempt.errorCode);
      if (failedAttempt?.errorCode) {
        return failedAttempt.errorCode;
      }
    }

    return null;
  }

  function deriveOriginKind(rawCandidate, strategy) {
    if (PolicyApi.getOriginKind) {
      const value = PolicyApi.getOriginKind({
        ...rawCandidate,
        strategy
      });
      if (value && value !== "unavailable") {
        return value;
      }
    }
    if (strategy === "title-description" || strategy === "description-transcript") {
      return "fallback_text";
    }
    return "unavailable";
  }

  function deriveSourceTrustTier(originKind) {
    if (PolicyApi.getSourceTrustTier) {
      return PolicyApi.getSourceTrustTier(originKind);
    }
    return originKind || "unavailable";
  }

  function deriveRecoveryTier(rawCandidate, providerClass, originKind) {
    if (rawCandidate?.recoveryTier) {
      return rawCandidate.recoveryTier;
    }
    if (originKind === "audio_asr") {
      return "hosted_asr";
    }
    if (providerClass === "backend") {
      return "hosted_transcript";
    }
    return "local";
  }

  function deriveFailureRecoveryTier(input) {
    if (String(input?.strategy || "").includes("backend")) {
      return "hosted_transcript";
    }
    return input?.providerClass === "backend" ? "hosted_transcript" : "local";
  }

  function compareTrustOrder(left, right) {
    const leftRank = PolicyApi.getTrustRank
      ? PolicyApi.getTrustRank(left.originKind)
      : 99;
    const rightRank = PolicyApi.getTrustRank
      ? PolicyApi.getTrustRank(right.originKind)
      : 99;
    return leftRank - rightRank;
  }

  function downgradeConfidence(value) {
    if (value === "high") {
      return "medium";
    }
    if (value === "medium") {
      return "low";
    }
    return "low";
  }

  function baseLanguage(value) {
    if (PolicyApi.getBaseLanguage) {
      return PolicyApi.getBaseLanguage(value);
    }
    const normalized = normalizeLanguage(value);
    return normalized ? normalized.split("-")[0] : null;
  }

  function normalizeComparableNumber(value) {
    return isFiniteNumber(value) ? Number(value) : -1;
  }

  function formatComparableNumber(value) {
    return isFiniteNumber(value) ? Number(value).toFixed(2) : "n/a";
  }

  function normalizeLanguage(value) {
    const normalized = PolicyApi.normalizeLanguageCode
      ? PolicyApi.normalizeLanguageCode(value)
      : String(value || "").trim().toLowerCase();
    return normalized || null;
  }

  function normalizeConfidence(value) {
    const normalized = String(value || "").trim().toLowerCase();
    return VALID_CONFIDENCES.has(normalized) ? normalized : null;
  }

  function normalizeQuality(value) {
    const normalized = String(value || "").trim().toLowerCase();
    return VALID_QUALITIES.has(normalized) ? normalized : null;
  }

  function normalizeDirectKind(value) {
    const text = String(value || "").trim().toLowerCase();
    if (text === "manual-input" || text === "manual") {
      return "manual-input";
    }
    if (text === "selection") {
      return "selection";
    }
    if (text === "article-content" || text === "article") {
      return "article-content";
    }
    return "page-content";
  }

  function firstListValue(values) {
    return Array.isArray(values) && values.length ? String(values[0] || "").trim() : "";
  }

  function toFiniteNumber(value) {
    const nextValue = Number(value);
    return Number.isFinite(nextValue) ? nextValue : null;
  }

  function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function average(values) {
    if (!Array.isArray(values) || !values.length) {
      return 0;
    }
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  function roundTo(value, precision) {
    if (!isFiniteNumber(value)) {
      return null;
    }
    const factor = 10 ** precision;
    return Math.round(value * factor) / factor;
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

  function buildFallbackPolicy() {
    return {
      thresholds: {
        minWordCount: 120,
        minSentenceUnits: 3,
        minCoverageRatioTranscript: 0.2,
        minCoverageRatioAudio: 0.25,
        minUniqueSegmentRatio: 0.55,
        minAverageWordsPerSegment: 2.5,
        minAverageWordsPerSegmentCount: 20,
        maxNonLetterCharacterRatio: 0.35
      },
      comparison: {
        coverageTieGap: 0.02,
        coverageManualBiasGap: 0.15,
        segmentQualityGap: 3,
        usableVolumeGap: 20
      }
    };
  }
})(globalThis);

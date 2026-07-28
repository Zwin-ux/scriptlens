(function (root, factory) {
  const api = factory(root || globalThis);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  const globalRoot = root || globalThis;
  globalRoot.ScriptLensServiceWorkerReport = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  const Contracts = root.ScriptLensContracts || {};
  const TranscriptPolicy = root.ScriptLens?.transcript?.policy || {};

  function buildAnalysisReport(input, options = {}) {
    const acquisition = input.acquisition;
    const detection = input.detection;
    const legacyReport = input.legacyReport || {};
    const inputQuality = buildInputQuality(acquisition);
    const interpretation = buildInterpretation(acquisition, inputQuality);
    const sourceInfo = buildSourceInfo(acquisition);
    const analysisMode =
      acquisition?.analysisMode ||
      input.directMeta?.analysisMode ||
      (input.directMeta?.sourceType === "youtube"
        ? TranscriptPolicy.ANALYSIS_MODES?.youtubeTranscriptFirst || "youtube-transcript-first"
        : TranscriptPolicy.ANALYSIS_MODES?.genericText || "generic-text");
    const scoringStatus =
      detection.scoringStatus || Contracts.SCORING_STATUSES?.scored || "scored";

    return {
      acquisition,
      detection,
      analysisMode,
      contractVersion: Contracts.CONTRACT_VERSION || "2026-03-11",
      failureCategory: null,
      inputQuality,
      interpretation,
      metadata: {
        ...(legacyReport.metadata || {}),
        sensitivity: input.settings.sensitivity
      },
      disclaimer:
        options.disclaimer ||
        "This score reflects AI-like writing patterns, not proof of authorship.",
      source: input.sourceLabel,
      sourceInfo,
      score: detection.aiScore ?? null,
      verdict: detection.verdict,
      explanation: detection.explanation,
      topReasons: detection.reasons,
      categoryScores: detection.categoryScores,
      triggeredPatterns: detection.triggeredPatterns,
      flaggedSentences: detection.flaggedSentences,
      scoringStatus,
      scoringError: detection.scoringError || "",
      scoringSummary: detection.scoringSummary || "",
      quality: {
        label: inputQuality.label,
        summary: inputQuality.summary,
        reasons: inputQuality.reasons
      },
      sourceMeta: {
        kind: acquisition?.kind || mapDirectKind(input.directMeta),
        sourceType: input.directMeta?.sourceType || "",
        includedSources: Array.isArray(input.directMeta?.includedSources)
          ? input.directMeta.includedSources.slice()
          : [],
        provider: acquisition?.provider || null,
        providerClass: acquisition?.providerClass || "local",
        strategy: acquisition?.strategy || null,
        sourceConfidence: acquisition?.sourceConfidence || null,
        quality: acquisition?.quality || null,
        acquisitionState: acquisition?.acquisitionState || null,
        transcriptRequiredSatisfied: acquisition?.transcriptRequiredSatisfied ?? true,
        failureReason: acquisition?.failureReason || null,
        recoveryTier:
          acquisition?.kind === "transcript"
            ? acquisition?.recoveryTier || "local"
            : acquisition?.recoveryTier || null,
        originKind: acquisition?.originKind || null,
        sourceTrustTier: acquisition?.sourceTrustTier || null,
        winnerReason: acquisition?.winnerReason || null,
        languageCode: acquisition?.languageCode || null,
        originalLanguageCode: acquisition?.originalLanguageCode || null,
        segmentCount: acquisition?.segmentCount || 0,
        coverageRatio: acquisition?.coverageRatio ?? null,
        transcriptSpanSeconds: acquisition?.transcriptSpanSeconds ?? null,
        qualityGate: acquisition?.qualityGate || null,
        extractor: input.directMeta?.extractor || null,
        extractorWarnings: Array.isArray(input.directMeta?.extractorWarnings)
          ? input.directMeta.extractorWarnings.slice()
          : [],
        extractorDurationMs: input.directMeta?.extractorDurationMs ?? null,
        legacyExtractorDurationMs: input.directMeta?.legacyExtractorDurationMs ?? null,
        defuddleExtractorDurationMs: input.directMeta?.defuddleExtractorDurationMs ?? null,
        defuddleAttempted: input.directMeta?.defuddleAttempted === true
      }
    };
  }

  function buildInsufficientInputReport(input, options = {}) {
    if (
      input?.acquisition?.kind !== "transcript" ||
      !isInsufficientInputError(input?.detectionError)
    ) {
      return null;
    }

    const textApi = root.AIScriptDetector?.text;
    const normalizedText = textApi?.sanitizeInput
      ? textApi.sanitizeInput(input.acquisition.text || "")
      : String(input.acquisition.text || "").trim();
    const wordCount = textApi?.countWords ? textApi.countWords(normalizedText) : 0;
    const sentenceCount = textApi?.splitSentences
      ? textApi.splitSentences(normalizedText).length
      : 0;
    const scoringSummary =
      "ScriptLens recovered a transcript, but this video does not contain enough spoken text for a reliable score.";

    return buildAnalysisReport(
      {
        sourceLabel: input.sourceLabel,
        acquisition: {
          ...input.acquisition,
          warnings: Array.isArray(input.acquisition.warnings)
            ? Array.from(new Set([...input.acquisition.warnings, "insufficient_scoring_input"]))
            : ["insufficient_scoring_input"]
        },
        directMeta: {
          sourceType: input.sourceType || "youtube"
        },
        detection: {
          aiScore: null,
          detectorConfidence: "not scored",
          verdict: "Not enough spoken text",
          explanation: scoringSummary,
          reasons: [
            "ScriptLens recovered transcript text for this video.",
            input.detectionError
          ].filter(Boolean),
          categoryScores: {},
          triggeredPatterns: [],
          flaggedSentences: [],
          scoringStatus:
            Contracts.SCORING_STATUSES?.insufficientInput || "insufficient-input",
          scoringError: input.detectionError || "",
          scoringSummary
        },
        legacyReport: {
          metadata: {
            wordCount,
            sentenceCount
          }
        },
        settings: input.settings
      },
      options
    );
  }

  function buildInputQuality(acquisition) {
    const reducedTrustAudio = acquisition?.sourceTrustTier === "audio-derived";
    const reducedTrustHeadless = acquisition?.sourceTrustTier === "headless-derived";
    if (acquisition.quality === "strong-transcript") {
      return {
        label: "Strong input",
        summary:
          acquisition.kind === "transcript"
            ? reducedTrustAudio
              ? "This analysis is grounded in an audio-derived transcript that passed quality checks, but it still carries reduced trust compared with caption or direct transcript sources."
              : reducedTrustHeadless
                ? "This analysis is grounded in a transcript recovered through a headless path, so trust is lower than a direct YouTube transcript or manual captions."
                : acquisition.providerClass === "backend"
                  ? "This analysis is grounded in a strong recovered transcript because the local path needed help."
                  : "This analysis is grounded in a strong transcript source with meaningful coverage."
            : "This analysis uses a relatively clean and substantive direct content source.",
        reasons: buildAcquisitionReasons(acquisition)
      };
    }

    if (acquisition.quality === "partial-transcript") {
      return {
        label: "Useful input",
        summary:
          acquisition.kind === "transcript"
            ? reducedTrustAudio
              ? "This analysis uses audio-derived transcript recovery. Treat it as reduced trust even though ScriptLens had enough material to score it."
              : reducedTrustHeadless
                ? "This analysis uses transcript material recovered through a headless path, so trust is lower than direct transcript or manual caption recovery."
                : acquisition.providerClass === "backend"
                  ? "This analysis uses recovered transcript material because the on-page transcript path was incomplete."
                  : "This analysis uses transcript material, but coverage or segment quality is still limited."
            : "This analysis uses useful local content, but source cleanliness and sample size still shape the score.",
        reasons: buildAcquisitionReasons(acquisition)
      };
    }

    return {
      label: "Weak input",
      summary:
        acquisition.quality === "enhanced-extraction-unavailable"
          ? acquisition.kind === "transcript"
            ? buildTranscriptUnavailableMessage(acquisition)
            : "ScriptLens could not retrieve a reliable source from this page."
          : acquisition.kind === "transcript"
            ? "This score is directional only because ScriptLens had to rely on title and description fallback instead of a real transcript."
            : "This score is directional only because the available content is short, noisy, or limited in context.",
      reasons: buildAcquisitionReasons(acquisition)
    };
  }

  function buildAcquisitionReasons(acquisition) {
    const reasons = [];
    reasons.push(`${capitalize(formatSourceKind(acquisition.kind))}: ${acquisition.sourceLabel}.`);
    reasons.push(`Source confidence: ${capitalize(acquisition.sourceConfidence)}.`);
    if (acquisition.originKind) {
      reasons.push(`Recovery tier: ${acquisition.recoveryTier || "local"} via ${acquisition.originKind}.`);
    }
    if (acquisition.winnerReason) {
      reasons.push(`Winner reason: ${acquisition.winnerReason}.`);
    }
    if (typeof acquisition.coverageRatio === "number") {
      reasons.push(`Coverage ratio: ${Math.round(acquisition.coverageRatio * 100)}%.`);
    }
    if (acquisition.kind === "transcript" && acquisition.segmentCount) {
      reasons.push(`Captured ${acquisition.segmentCount} normalized segments.`);
    }
    if (acquisition.providerClass === "backend") {
      reasons.push("Recovered transcript text was used after the on-page transcript path came back weak or unavailable.");
    }
    if (acquisition.sourceTrustTier === "audio-derived") {
      reasons.push("Audio-derived transcript recovery always carries reduced trust compared with caption or direct transcript sources.");
    }
    if (acquisition.sourceTrustTier === "headless-derived") {
      reasons.push("Headless transcript recovery is treated as weaker than direct transcript and manual caption sources.");
    }
    if (acquisition.isGenerated === true) {
      reasons.push("The winning source uses generated captions.");
    }
    if (acquisition.kind === "selection") {
      reasons.push("Only the selected passage was analyzed, so broader page context is excluded.");
    }
    if (acquisition.kind === "manual-input") {
      reasons.push("Pasted text avoids page extraction noise and is scored directly.");
    }
    if (acquisition.warnings?.includes("fallback_source")) {
      reasons.push("Fallback context was used instead of a full transcript.");
    }
    return reasons.slice(0, 4);
  }

  function buildInterpretation(acquisition, inputQuality) {
    const weakEvidence = acquisition?.quality === "weak-fallback";
    const transcriptMissing = acquisition?.quality === "enhanced-extraction-unavailable";
    const contentSource = acquisition?.kind && acquisition.kind !== "transcript";

    return {
      means:
        "The score reflects how strongly the writing matches AI-like patterns in structure, phrasing, and rhythm.",
      notMeans:
        "It is not proof of authorship and should not be treated as a definitive human-vs-AI judgment.",
      falsePositives: [
        "Highly polished scripts, voiceovers, study guides, and SEO copy can trigger strong pattern matches.",
        weakEvidence
          ? contentSource
            ? "Short or noisy page captures can overstate patterns because there is less surrounding context."
            : "Short title and description fallbacks can overstate packaging signals without enough transcript context."
          : contentSource
            ? "Heavily edited article or page content can read more uniform than the original authored workflow."
            : "Edited transcripts can sound more uniform than the original spoken performance.",
        "Heavily edited marketing or educational copy can read as more templated than its source."
      ],
      trustMore: transcriptMissing
        ? [
            contentSource
              ? "Use a longer direct text sample or a cleaner article page when possible."
              : "Use a video with readable captions or a visible transcript panel when possible.",
            "Longer direct text samples usually produce a more stable result."
          ]
        : inputQuality.label === "Strong input"
          ? [
              "The source is relatively clean and long enough to surface repeated structure instead of one-off phrasing.",
              "Transcript provenance and confidence are separate from AI-likelihood, so read both together."
            ]
          : [
              contentSource
                ? "Use longer text and cleaner article or page captures for a more stable result."
                : "Use longer text and cleaner transcript sources for a more stable result.",
              contentSource
                ? "Short selections and noisy page captures should be treated as weak evidence."
                : "Fallback title and description analysis should be treated as weak evidence."
            ]
    };
  }

  function buildSourceInfo(acquisition) {
    return {
      kind: acquisition.kind || null,
      analysisMode: acquisition.analysisMode || null,
      sourceLabel: acquisition.sourceLabel,
      sourceConfidence: acquisition.sourceConfidence,
      quality: acquisition.quality,
      provider: acquisition.provider,
      providerClass: acquisition.providerClass || "local",
      strategy: acquisition.strategy,
      acquisitionState: acquisition.acquisitionState || null,
      transcriptRequiredSatisfied: acquisition.transcriptRequiredSatisfied ?? true,
      failureReason: acquisition.failureReason || null,
      recoveryTier:
        acquisition.kind === "transcript"
          ? acquisition.recoveryTier || "local"
          : acquisition.recoveryTier || null,
      originKind: acquisition.originKind || null,
      sourceTrustTier: acquisition.sourceTrustTier || null,
      winnerReason: acquisition.winnerReason || null,
      languageCode: acquisition.languageCode,
      originalLanguageCode: acquisition.originalLanguageCode,
      isGenerated: acquisition.isGenerated,
      isTranslated: acquisition.isTranslated,
      warnings: acquisition.warnings || [],
      requestShapeValidation: acquisition.requestShapeValidation || null,
      qualityGate: acquisition.qualityGate || null
    };
  }

  function buildAcquisitionFailureMessage(acquisition) {
    if (!acquisition) {
      return "No usable text could be extracted.";
    }
    if (acquisition.quality === "enhanced-extraction-unavailable") {
      return acquisition.kind === "transcript"
        ? acquisition.failureReason === "transcript_required"
          ? "ScriptLens could not get a transcript for this video, and the current settings did not allow a title or description fallback."
          : buildTranscriptUnavailableMessage(acquisition)
        : "ScriptLens could not retrieve a reliable source from this page.";
    }
    return "No usable video text could be extracted from the selected sources.";
  }

  function buildTranscriptUnavailableMessage(acquisition) {
    const failureReason = String(acquisition?.failureReason || "").trim();
    const warnings = Array.isArray(acquisition?.warnings) ? acquisition.warnings : [];
    const hasCode = (code) => failureReason === code || warnings.includes(code);

    if (
      hasCode("caption_fetch_failed") ||
      hasCode("youtubei_failed_precondition") ||
      hasCode("youtubei_failed")
    ) {
      return "ScriptLens found transcript info for this video, but YouTube did not return enough transcript text to score right now.";
    }
    if (hasCode("backend_timeout")) {
      return "ScriptLens found transcript info for this video, but the optional recovery step did not finish in time.";
    }
    if (hasCode("language_mismatch") || hasCode("language_requested_mismatch")) {
      return "ScriptLens found transcript material, but it did not match the requested language closely enough to score safely.";
    }
    if (hasCode("quality_gate_rejected")) {
      return "ScriptLens found transcript material, but it was too weak or degraded to score safely.";
    }
    return "ScriptLens could not retrieve a usable transcript for this video right now.";
  }

  function buildAnalysisDisplaySource(acquisition, title) {
    const safeTitle = String(title || "").trim();

    if (acquisition.kind === "transcript") {
      return buildYouTubeSourceLabel(safeTitle || "Untitled video", acquisition);
    }
    if (acquisition.kind === "article-content") {
      const label = acquisition.sourceLabel || "Article content";
      return safeTitle ? `${label} - ${safeTitle}` : label;
    }
    if (acquisition.kind === "page-content") {
      const label = acquisition.sourceLabel || "Visible page content";
      return safeTitle ? `${label} - ${safeTitle}` : label;
    }
    if (acquisition.kind === "selection") {
      return safeTitle ? `Selected text - ${safeTitle}` : "Selected text";
    }
    if (acquisition.kind === "manual-input") {
      return "Pasted text";
    }
    return safeTitle || acquisition.sourceLabel || "Local analysis";
  }

  function buildDirectSourceLabel(sourceMeta) {
    return buildAnalysisDisplaySource(
      {
        kind: mapDirectKind(sourceMeta),
        sourceLabel: sourceMeta?.sourceLabel || "Local analysis"
      },
      sourceMeta?.title || ""
    );
  }

  function buildYouTubeSourceLabel(title, acquisition) {
    return `YouTube video - ${title} - ${acquisition.sourceLabel}`;
  }

  function mapDirectKind(sourceMeta) {
    const sourceType = String(sourceMeta?.kind || sourceMeta?.sourceType || "").toLowerCase();
    if (sourceType === "manual" || sourceType === "manual-input") {
      return "manual-input";
    }
    if (sourceType === "selection") {
      return "selection";
    }
    if (sourceType === "article" || sourceType === "article-content") {
      return "article-content";
    }
    return "page-content";
  }

  function isInsufficientInputError(value) {
    const message = String(value || "").trim();
    return (
      message === "The text is too short for a useful heuristic read. Try at least 40 words or 180 characters." ||
      message === "Add a few more complete sentences for a reliable score."
    );
  }

  function formatSourceKind(kind) {
    if (kind === "manual-input") {
      return "manual input";
    }
    if (kind === "article-content") {
      return "article content";
    }
    if (kind === "page-content") {
      return "page content";
    }
    if (kind === "selection") {
      return "selection";
    }
    return "transcript source";
  }

  function capitalize(value) {
    const text = String(value || "");
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
  }

  return {
    buildAnalysisReport,
    buildInsufficientInputReport,
    buildInputQuality,
    buildAcquisitionReasons,
    buildInterpretation,
    buildSourceInfo,
    buildAcquisitionFailureMessage,
    buildTranscriptUnavailableMessage,
    buildDirectSourceLabel,
    buildYouTubeSourceLabel,
    buildAnalysisDisplaySource,
    mapDirectKind,
    isInsufficientInputError
  };
});

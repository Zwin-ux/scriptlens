(function (root) {
  const Surface = (root.ScriptLensSurface = root.ScriptLensSurface || {});
  const Contracts = root.ScriptLensContracts || {};

  Surface.buildPageContextViewModel = buildPageContextViewModel;
  Surface.buildReportViewModel = buildReportViewModel;
  Surface.buildInlineReportViewModel = buildInlineReportViewModel;
  Surface.buildRecentReportsViewModel = buildRecentReportsViewModel;
  Surface.getRequestLabel = getRequestLabel;
  Surface.renderBadges = renderBadges;
  Surface.getScorePalette = getScorePalette;
  Surface.getVerdictClass = getVerdictClass;
  Surface.formatAcquisitionQuality = formatAcquisitionQuality;
  Surface.formatCategoryName = formatCategoryName;
  Surface.toClassToken = toClassToken;
  Surface.capitalize = capitalize;
  Surface.escapeHtml = escapeHtml;
  Surface.formatSourceKind = formatSourceKind;

  function buildPageContextViewModel(context) {
    if (!context?.supported) {
      return {
        title: "Open a YouTube video",
        summary:
          context?.error ||
          "ScriptLens for Chrome currently supports desktop YouTube watch pages only.",
        badges: [{ label: "YouTube only", variant: "attention" }]
      };
    }

    const badges = [];
    if (context.isYouTubeVideo) {
      badges.push({ label: "YouTube watch page", variant: "primary" });
    }
    if (context.transcriptAvailable) {
      badges.push({ label: "Transcript available", variant: "primary" });
    } else if (context.isYouTubeVideo) {
      badges.push({ label: "Transcript unavailable", variant: "attention" });
    }
    if (context.hostname) {
      badges.push({ label: context.hostname });
    }

    return {
      title: context.title || "Current page",
      summary: context.isYouTubeVideo
        ? "ScriptLens stays transcript-first by default and keeps fallback controls tucked away until you need them."
        : "ScriptLens currently supports desktop YouTube watch pages only.",
      badges
    };
  }

  function buildReportViewModel(report, settings) {
    if (!report) {
      return null;
    }

    const acquisition = report.acquisition || {};
    const detection = report.detection || {};
    const scoringStatus = report.scoringStatus || detection.scoringStatus || "scored";
    const notScored = scoringStatus !== "scored";
    const score = notScored ? null : Number(detection.aiScore ?? report.score ?? 0) || 0;
    const verdict = detection.verdict || report.verdict || (notScored ? "Not scored" : "Unavailable");
    const palette = getScorePalette(score);
    const acquisitionQuality = notScored ? "Not scored" : formatAcquisitionQuality(acquisition);
    const acquisitionClass = notScored ? "partial-transcript" : acquisition?.quality || "weak-fallback";
    const inputLabel = report.inputQuality?.label || report.quality?.label || "Weak input";
    const providerLabel =
      acquisition.kind === "transcript"
        ? acquisition.sourceTrustTier === "audio-derived"
          ? "Audio-derived transcript"
          : acquisition.providerClass === "backend"
          ? "Recovered transcript"
          : "Local transcript"
        : "Local content";
    const acquisitionStateNote =
      notScored
        ? acquisition.kind === "transcript"
          ? "ScriptLens recovered a real transcript, but there was not enough spoken text to score safely."
          : "ScriptLens extracted page content, but there was not enough clean text to score safely."
        : acquisition.kind === "transcript"
          ? acquisition.acquisitionState === "transcript-acquired"
            ? "ScriptLens analyzed a real transcript source."
            : acquisition.acquisitionState === "partial-transcript"
              ? "ScriptLens analyzed a real transcript source, but coverage or transcript quality was still limited."
              : acquisition.acquisitionState === "fallback-text-only"
                ? "This score came from title and description fallback, not the spoken transcript."
                : "ScriptLens could not retrieve a usable transcript before this analysis finished."
          : acquisition.quality === "enhanced-extraction-unavailable"
            ? "ScriptLens could not retrieve reliable page content from this video page."
            : "ScriptLens analyzed extracted page content because a usable transcript was not available.";
    const sourceMeta = acquisition.kind === "transcript"
      ? [
          providerLabel,
          acquisition.recoveryTier ? `Recovery: ${formatRecoveryTier(acquisition.recoveryTier)}` : "",
          acquisition.originKind ? `Origin: ${formatOriginKind(acquisition.originKind)}` : "",
          acquisition.sourceTrustTier ? `Trust: ${formatTrustTier(acquisition.sourceTrustTier)}` : "",
          acquisition.isGenerated === true
            ? "Auto captions"
            : acquisition.isGenerated === false
              ? "Manual captions"
              : "",
          acquisition.languageCode ? `Language: ${acquisition.languageCode}` : ""
        ]
      : [
          formatSourceKind(acquisition.kind),
          acquisition.coverageRatio != null
            ? `${Math.round(acquisition.coverageRatio * 100)}% extraction coverage`
            : "",
          acquisition.languageCode || ""
        ];
    const confidenceMeta = [
      acquisition.sourceTrustTier === "audio-derived" ? "Reduced trust" : "",
      acquisition.isGenerated === true ? "Generated" : acquisition.isGenerated === false ? "Manual" : "",
      acquisition.coverageRatio != null
        ? `${Math.round(acquisition.coverageRatio * 100)}% coverage`
        : ""
    ].filter(Boolean);

    if (!confidenceMeta.length && acquisition.kind === "manual-input") {
      confidenceMeta.push("Direct pasted text");
    }
    if (!confidenceMeta.length && acquisition.kind === "selection") {
      confidenceMeta.push("Selected context only");
    }

    return {
      contractVersion: report.contractVersion || Contracts.CONTRACT_VERSION || "2026-03-11",
      failureCategory:
        report.failureCategory ||
        Contracts.resolveFailureCategory?.(report) ||
        null,
      score,
      scoreDisplay: notScored ? "Not scored" : String(score),
      verdict,
      verdictClass: notScored ? "mid" : getVerdictClass(score),
      palette,
      acquisitionQuality,
      acquisitionClass,
      inputLabel,
      inputClass: toClassToken(inputLabel),
      explanation:
        (notScored && (report.scoringSummary || detection.scoringSummary)) ||
        detection.explanation ||
        report.explanation ||
        report.error ||
        "",
      source: report.source || "Local analysis",
      counts: `${report.metadata?.wordCount || 0} words - ${report.metadata?.sentenceCount || 0} sentences`,
      meta: `Sensitivity: ${capitalize(report.metadata?.sensitivity || settings?.sensitivity || "medium")}`,
      sourceLabel: acquisition.sourceLabel || "Not applicable",
      sourceMeta: sourceMeta.filter(Boolean).join(" - "),
      sourceConfidence: capitalize(acquisition.sourceConfidence || "not applicable"),
      sourceConfidenceMeta: confidenceMeta.join(" - "),
      providerLabel,
      privacyDisclosure:
        acquisition.providerClass === "backend"
          ? "Only the video ID and requested language were sent to ScriptLens to retrieve the transcript."
          : "",
      acquisitionStateNote,
      detectorConfidence: notScored
        ? "Not scored"
        : capitalize(detection.detectorConfidence || "low"),
      detectorConfidenceMeta:
        notScored
          ? acquisition.kind === "transcript"
            ? "ScriptLens intentionally skipped scoring because the recovered transcript was too short or sentence-poor for a reliable heuristic read."
            : "ScriptLens intentionally skipped scoring because the extracted content sample was too short or sparse for a reliable heuristic read."
          : acquisition.sourceTrustTier === "audio-derived"
            ? "Detector confidence is capped because the source was reconstructed from audio."
            : acquisition.kind !== "transcript"
              ? "Detector confidence is capped by extraction cleanliness and sample size."
              : acquisition.quality === "weak-fallback"
                ? "Detector confidence is capped because this score comes from title and description fallback."
                : "Detector confidence is capped by source confidence and sample size.",
      inputSummary: report.inputQuality?.summary || report.quality?.summary || "",
      interpretationMeans: report.interpretation?.means || "",
      interpretationNotMeans: report.interpretation?.notMeans || report.disclaimer || "",
      falsePositives: report.interpretation?.falsePositives || [],
      trustMore: report.interpretation?.trustMore || [],
      topReasons: report.topReasons || detection.reasons || [],
      categoryScores: report.categoryScores || detection.categoryScores || {},
      flaggedSentences: report.flaggedSentences || detection.flaggedSentences || [],
      debugVisible: Boolean(settings?.debugMode && report.acquisition),
      debugWinningPath: (report.acquisition?.resolverPath || []).join(" -> ") || "Not available",
      debugWinnerReason:
        report.acquisition?.winnerReason ||
        (report.acquisition?.winnerSelectedBy || []).join(" | ") ||
        "Single candidate",
      debugWarnings: (report.acquisition?.warnings || []).join(", ") || "None",
      debugErrors:
        (report.acquisition?.errors || [])
          .map((error) => `${error.strategy}:${error.code}`)
          .join(" | ") || "No resolver errors"
    };
  }

  function buildRecentReportsViewModel(recentReports) {
    return Array.isArray(recentReports) ? recentReports : [];
  }

  function buildInlineReportViewModel(report) {
    if (!report) {
      return null;
    }

    const acquisition = report.acquisition || {};
    const detection = report.detection || {};
    const scoringStatus = report.scoringStatus || detection.scoringStatus || "scored";
    const notScored = scoringStatus !== "scored";
    const score = notScored ? null : Number(detection.aiScore ?? report.score ?? 0) || 0;
    const verdict = detection.verdict || report.verdict || (notScored ? "Not scored" : "Unavailable");
    const scoreClass = notScored ? "mid" : getVerdictClass(score);
    const sourceLabel = getConsumerSourceLabel(acquisition);
    const qualityLabel = notScored
      ? acquisition.kind === "transcript"
        ? "Short transcript"
        : "Short sample"
      : getConsumerQualityLabel(acquisition);
    const confidenceLabel = notScored
      ? "Short sample"
      : capitalize(acquisition.sourceConfidence || "low");
    const explanation =
      (notScored && (report.scoringSummary || detection.scoringSummary)) ||
      detection.explanation ||
      report.explanation ||
      (acquisition.kind === "transcript"
        ? "ScriptLens reviewed the available transcript material for this video."
        : "ScriptLens reviewed extracted page content from this video page because a usable transcript was not available.");
    const detailSummary =
      (notScored && (report.scoringSummary || detection.scoringSummary)) ||
      report.inputQuality?.summary ||
      report.quality?.summary ||
      "Use the full workspace for a deeper breakdown.";
    const transcriptMeta = []
      .concat(acquisition.isGenerated === true ? ["Auto captions"] : [])
      .concat(
        typeof acquisition.coverageRatio === "number"
          ? [`${Math.round(acquisition.coverageRatio * 100)}% coverage`]
          : []
      )
      .concat(acquisition.segmentCount ? [`${acquisition.segmentCount} segments`] : [])
      .concat(
        acquisition.transcriptSpanSeconds ? [`${Math.round(acquisition.transcriptSpanSeconds)}s span`] : []
      )
      .join(" - ");

    return {
      contractVersion: report.contractVersion || Contracts.CONTRACT_VERSION || "2026-03-11",
      failureCategory:
        report.failureCategory ||
        Contracts.resolveFailureCategory?.(report) ||
        null,
      score,
      scoreClass,
      verdict,
      explanation,
      qualityLabel,
      sourceLabel,
      confidenceLabel,
      secondaryBadgeLabel: notScored
        ? "Not enough text to score"
        : acquisition.sourceTrustTier === "audio-derived"
          ? "Audio-derived transcript"
          : `${confidenceLabel} transcript quality`,
      reducedTrustLabel:
        acquisition.sourceTrustTier === "audio-derived"
          ? "Audio-derived transcript"
          : "",
      detailSummary,
      transcriptMeta,
      reasonPreview: (report.topReasons || detection.reasons || []).slice(0, 3),
      privacyDisclosure: getConsumerPrivacyDisclosure(acquisition),
      canShowDetails: Boolean(acquisition.kind === "transcript"),
      advancedSourceLabel: acquisition.sourceLabel || "Transcript",
      advancedSourceMeta: [
        acquisition.recoveryTier ? formatRecoveryTier(acquisition.recoveryTier) : "",
        acquisition.originKind ? formatOriginKind(acquisition.originKind) : "",
        acquisition.sourceTrustTier ? formatTrustTier(acquisition.sourceTrustTier) : "",
        acquisition.languageCode || "unknown language"
      ]
        .filter(Boolean)
        .join(" - "),
      winnerReason: acquisition.winnerReason || "",
      qualityGateNote: buildQualityGateNote(acquisition),
      detectorConfidence: notScored
        ? "Not scored"
        : capitalize(detection.detectorConfidence || "low"),
      rawScoreText: notScored ? "Not scored" : `${score}/100`
    };
  }

  function getRequestLabel(request) {
    if (request?.mode === "selection") {
      return {
        title: "Analyze the live selection",
        copy: "Use only the highlighted passage from the current tab.",
        button: "Analyze Selection"
      };
    }
    if (request?.mode === "page") {
      return {
        title: "Analyze the visible page",
        copy: "Use the main readable content from the current tab.",
        button: "Analyze Page"
      };
    }
    if (request?.mode === "youtube") {
      return {
        title: "Analyze this video",
        copy: "Run a transcript-first check for AI-like writing patterns, with fallback controls available only if you need them.",
        button: "Analyze Video"
      };
    }
    if (request?.mode === "manual") {
      return {
        title: "Analyze pasted text",
        copy: "Use the manual input exactly as written.",
        button: "Analyze Pasted Text"
      };
    }
    return {
      title: "Choose a source",
      copy: "ScriptLens could not find a strong default source on this tab yet.",
      button: "Unavailable"
    };
  }

  function renderBadges(badges) {
    return (badges || [])
      .map((badge) => {
        const variant = badge.variant ? ` ${badge.variant}` : "";
        return `<span class="context-badge${variant}">${escapeHtml(badge.label)}</span>`;
      })
      .join("");
  }

  function getVerdictClass(score) {
    if (!Number.isFinite(score)) {
      return "mid";
    }
    if (score >= 75) {
      return "high";
    }
    if (score >= 30) {
      return "mid";
    }
    return "low";
  }

  function getScorePalette(score) {
    if (!Number.isFinite(score)) {
      return {
        background: "#fbf4e8",
        border: "#e7d5b0",
        text: "#8a6326"
      };
    }
    if (score >= 75) {
      return {
        background: "#faeded",
        border: "#efc7c7",
        text: "#9d3f3f"
      };
    }
    if (score >= 30) {
      return {
        background: "#fbf4e8",
        border: "#e7d5b0",
        text: "#8a6326"
      };
    }
    return {
      background: "#edf6ef",
      border: "#cfe1d3",
      text: "#256444"
    };
  }

  function formatAcquisitionQuality(acquisition) {
    if (!acquisition?.quality) {
      return "Unavailable";
    }

    if (acquisition.kind !== "transcript") {
      if (acquisition.quality === "strong-transcript") {
        return "Strong content";
      }
      if (acquisition.quality === "partial-transcript") {
        return "Useful content";
      }
      if (acquisition.quality === "weak-fallback") {
        return "Weak content";
      }
    }

    if (acquisition.acquisitionState === "transcript-acquired") {
      return "Transcript acquired";
    }
    if (acquisition.acquisitionState === "partial-transcript") {
      return "Partial transcript";
    }
    if (acquisition.acquisitionState === "fallback-text-only") {
      return "Fallback text only";
    }
    if (acquisition.acquisitionState === "transcript-unavailable") {
      return "Transcript unavailable";
    }

    return acquisition.quality
      .split("-")
      .map((part) => capitalize(part))
      .join(" ");
  }

  function formatSourceKind(kind) {
    if (kind === "manual-input") {
      return "Manual input";
    }
    if (kind === "article-content") {
      return "Article content";
    }
    if (kind === "page-content") {
      return "Page content";
    }
    if (kind === "selection") {
      return "Selection";
    }
    return "Transcript";
  }

  function getConsumerSourceLabel(acquisition) {
    if (acquisition.kind !== "transcript") {
      return acquisition.sourceLabel || formatSourceKind(acquisition.kind);
    }
    if (acquisition.sourceTrustTier === "audio-derived") {
      return "Recovered transcript";
    }
    if (acquisition.providerClass === "backend") {
      return "Recovered transcript";
    }
    if (acquisition.strategy === "title-description") {
      return "Title and description";
    }
    if (acquisition.isGenerated === true) {
      return "YouTube captions";
    }
    return "YouTube transcript";
  }

  function getConsumerQualityLabel(acquisition) {
    if (acquisition.kind !== "transcript") {
      if (acquisition.quality === "strong-transcript") {
        return "Strong input";
      }
      if (acquisition.quality === "partial-transcript") {
        return "Useful input";
      }
      if (acquisition.quality === "weak-fallback") {
        return "Weak input";
      }
      if (acquisition.quality === "enhanced-extraction-unavailable") {
        return "Source unavailable";
      }
      return "Direct input";
    }
    if (acquisition.acquisitionState === "transcript-acquired") {
      return "Strong transcript";
    }
    if (acquisition.acquisitionState === "partial-transcript") {
      return "Usable transcript";
    }
    if (acquisition.acquisitionState === "fallback-text-only") {
      return "Fallback text";
    }
    if (acquisition.acquisitionState === "transcript-unavailable") {
      return "Transcript unavailable";
    }
    return "Transcript check";
  }

  function getConsumerPrivacyDisclosure(acquisition) {
    if (acquisition.providerClass !== "backend") {
      return "";
    }

    return "To recover the transcript, ScriptLens only shared the video ID and requested language with the recovery service.";
  }

  function buildQualityGateNote(acquisition) {
    if (!acquisition?.qualityGate) {
      return "";
    }
    const reducedTrustPrefix =
      acquisition.sourceTrustTier === "audio-derived"
        ? "Audio-derived transcript: ScriptLens reconstructed this text from audio, so trust is reduced compared with captions or a direct transcript. "
        : "";
    if (acquisition.qualityGate.eligible) {
      return `${reducedTrustPrefix}Quality gate passed (${acquisition.qualityGate.wordCount || 0} words, ${acquisition.qualityGate.sentenceUnits || 0} sentence units).`;
    }
    return `${reducedTrustPrefix}Quality gate rejected: ${(acquisition.qualityGate.rejectedReasons || []).join(", ") || "unknown"}.`;
  }

  function formatRecoveryTier(value) {
    if (value === "hosted_asr") {
      return "Hosted ASR";
    }
    if (value === "hosted_transcript") {
      return "Hosted transcript recovery";
    }
    return "Local recovery";
  }

  function formatOriginKind(value) {
    if (value === "youtube_transcript") {
      return "YouTube transcript";
    }
    if (value === "manual_caption_track") {
      return "Manual captions";
    }
    if (value === "generated_caption_track") {
      return "Generated captions";
    }
    if (value === "headless_transcript") {
      return "Headless transcript";
    }
    if (value === "audio_asr") {
      return "Audio ASR";
    }
    return capitalize(String(value || "unknown").replace(/_/g, " "));
  }

  function formatTrustTier(value) {
    if (value === "direct-transcript") {
      return "Direct transcript";
    }
    if (value === "caption-derived") {
      return "Caption-derived";
    }
    if (value === "headless-derived") {
      return "Headless-derived";
    }
    if (value === "audio-derived") {
      return "Audio-derived";
    }
    return capitalize(String(value || "unknown").replace(/_/g, " "));
  }

  function formatCategoryName(key) {
    return String(key || "")
      .split(/[_-]/)
      .map((part) => capitalize(part))
      .join(" ");
  }

  function toClassToken(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/\s+/g, "-");
  }

  function capitalize(value) {
    const text = String(value || "");
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
})(globalThis);

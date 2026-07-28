(function (root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  const globalRoot = root || globalThis;
  const ScriptLens = (globalRoot.ScriptLens = globalRoot.ScriptLens || {});
  const Transcript = (ScriptLens.transcript = ScriptLens.transcript || {});
  Transcript.policy = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const ANALYSIS_MODES = {
    youtubeTranscriptFirst: "youtube-transcript-first",
    genericText: "generic-text"
  };

  const TRUST_ORDER = {
    youtube_transcript: 1,
    manual_caption_track: 2,
    generated_caption_track: 3,
    headless_transcript: 4,
    audio_asr: 5,
    fallback_text: 6,
    unavailable: 99
  };

  const SOURCE_TRUST_TIERS = {
    youtube_transcript: "direct-transcript",
    manual_caption_track: "caption-derived",
    generated_caption_track: "caption-derived",
    headless_transcript: "headless-derived",
    audio_asr: "audio-derived",
    fallback_text: "fallback-text",
    unavailable: "unavailable"
  };

  const ESCALATION_FAILURE_CODES = [
    "youtubei_failed_precondition",
    "youtubei_params_missing",
    "youtubei_bootstrap_incomplete",
    "youtubei_empty",
    "caption_tracks_missing",
    "caption_track_unavailable",
    "caption_fetch_failed"
  ];

  const DEFAULT_POLICY = {
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
      backendImprovementThresholds: {
        coverageRatio: 0.15,
        transcriptSpanSeconds: 90,
        segmentQualityScore: 10
      },
      coverageTieGap: 0.02,
      coverageManualBiasGap: 0.15,
      segmentQualityGap: 3,
      usableVolumeGap: 20
    },
    timeouts: {
      extensionLocalMs: 2500,
      extensionTotalMs: 36000,
      backendRequestMs: 45000,
      backendTranscriptMs: 30000,
      backendAsrMs: 30000,
      backendStage: {
        watchPageMs: 4000,
        youtubeiMs: 2500,
        ytDlpMs: 12000,
        headlessMs: 15000,
        asrMs: 30000
      }
    },
    backend: {
      auth: {
        mode: "disabled",
        cookieFilePath: "",
        useForYtDlp: true,
        useForBrowserSession: true
      },
      rateLimit: {
        recoveryRequests: {
          limit: 20,
          windowMs: 15 * 60 * 1000
        },
        asrRequests: {
          limit: 6,
          windowMs: 60 * 60 * 1000
        }
      },
      concurrency: {
        perClient: 2,
        transcriptJobs: 25,
        asrJobs: 4
      },
      cacheTtlMs: {
        transcriptSuccess: 24 * 60 * 60 * 1000,
        asrSuccess: 7 * 24 * 60 * 60 * 1000,
        unavailable: 15 * 60 * 1000
      },
      maxVideoLengthSeconds: {
        automaticAsr: 35 * 60,
        manualAsr: 90 * 60,
        absolute: 90 * 60
      },
      allowAutomaticAsrWithoutKnownDuration: false,
      headless: {
        chromiumSandbox: false,
        navigationTimeoutMs: 15000,
        transcriptWaitMs: 6000,
        settleMs: 1500,
        launchArgs: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--no-zygote"
        ],
        extraLaunchArgs: []
      },
      circuitBreaker: {
        forcedOpen: false,
        asrQueueDepthOpen: 4,
        failureRateOpen: 0.5,
        minimumSamples: 8,
        rollingWindowSize: 20,
        openMs: 60 * 1000
      }
    }
  };

  return {
    ANALYSIS_MODES,
    TRUST_ORDER,
    SOURCE_TRUST_TIERS,
    ESCALATION_FAILURE_CODES,
    DEFAULT_POLICY,
    resolvePolicy,
    normalizeLanguageCode,
    getBaseLanguage,
    languagesMateriallyMismatch,
    getOriginKind,
    getSourceTrustTier,
    getTrustRank
  };

  function resolvePolicy(overrides) {
    return mergeObjects(DEFAULT_POLICY, overrides || {});
  }

  function normalizeLanguageCode(value) {
    const text = String(value || "").trim().toLowerCase();
    return text || null;
  }

  function getBaseLanguage(value) {
    const normalized = normalizeLanguageCode(value);
    if (!normalized) {
      return null;
    }
    return normalized.split("-")[0] || normalized;
  }

  function languagesMateriallyMismatch(left, right) {
    const leftBase = getBaseLanguage(left);
    const rightBase = getBaseLanguage(right);
    if (!leftBase || !rightBase) {
      return false;
    }
    return leftBase !== rightBase;
  }

  function getOriginKind(input) {
    if (input?.originKind) {
      return input.originKind;
    }

    const strategy = String(input?.strategy || "").trim().toLowerCase();
    if (strategy === "backend-asr" || strategy === "audio-asr") {
      return "audio_asr";
    }
    if (strategy === "backend-headless-transcript") {
      return "headless_transcript";
    }
    if (strategy === "youtubei-transcript" || strategy === "dom-transcript") {
      return "youtube_transcript";
    }
    if (strategy === "caption-track") {
      return input?.isGenerated === true
        ? "generated_caption_track"
        : "manual_caption_track";
    }
    if (strategy === "backend-transcript") {
      if (input?.isHeadless === true) {
        return "headless_transcript";
      }
      if (input?.isGenerated === true) {
        return "generated_caption_track";
      }
      if (input?.sourceLabel && /caption/i.test(String(input.sourceLabel))) {
        return input?.isGenerated === true
          ? "generated_caption_track"
          : "manual_caption_track";
      }
      return "youtube_transcript";
    }
    if (strategy === "title-description" || strategy === "description-transcript") {
      return "fallback_text";
    }
    return "unavailable";
  }

  function getSourceTrustTier(originKind) {
    return SOURCE_TRUST_TIERS[originKind] || SOURCE_TRUST_TIERS.unavailable;
  }

  function getTrustRank(originKind) {
    return TRUST_ORDER[originKind] || TRUST_ORDER.unavailable;
  }

  function mergeObjects(baseValue, overrideValue) {
    if (!isPlainObject(baseValue)) {
      return overrideValue === undefined ? baseValue : overrideValue;
    }

    const result = { ...baseValue };
    Object.keys(overrideValue || {}).forEach((key) => {
      const baseEntry = baseValue[key];
      const overrideEntry = overrideValue[key];
      result[key] = isPlainObject(baseEntry) && isPlainObject(overrideEntry)
        ? mergeObjects(baseEntry, overrideEntry)
        : overrideEntry;
    });
    return result;
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }
});

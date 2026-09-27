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
    fallback_text: 4,
    unavailable: 99
  };

  const SOURCE_TRUST_TIERS = {
    youtube_transcript: "direct-transcript",
    manual_caption_track: "caption-derived",
    generated_caption_track: "caption-derived",
    fallback_text: "fallback-text",
    unavailable: "unavailable"
  };

  const DEFAULT_POLICY = {
    thresholds: {
      minWordCount: 120,
      minSentenceUnits: 3,
      minCoverageRatioTranscript: 0.2,
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
    },
    timeouts: {
      extensionLocalMs: 2500,
      extensionTotalMs: 36000
    }
  };

  return {
    ANALYSIS_MODES,
    TRUST_ORDER,
    SOURCE_TRUST_TIERS,
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
    if (strategy === "youtubei-transcript" || strategy === "dom-transcript") {
      return "youtube_transcript";
    }
    if (strategy === "caption-track") {
      return input?.isGenerated === true
        ? "generated_caption_track"
        : "manual_caption_track";
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

(function (root) {
  const App = (root.AIScriptDetector = root.AIScriptDetector || {});
  const Text = App.text || {};
  const Dom = App.dom || {};

  App.defuddleExtractor = {
    extractDocumentPayload
  };

  function extractDocumentPayload(doc, options = {}) {
    const legacyResult = runLegacyExtractor(doc);
    const legacyPayload = legacyResult.payload;
    const diagnostics = createDiagnostics({
      legacyDurationMs: legacyResult.durationMs
    });

    if (!options.enableDefuddleExperiment) {
      return finalizePayload(legacyPayload, "legacy", [], diagnostics);
    }

    const defuddleAttempt = runDefuddle(doc, legacyPayload, options);
    const nextDiagnostics = mergeDiagnostics(diagnostics, defuddleAttempt.diagnostics);
    const warnings = []
      .concat(defuddleAttempt.warnings || [])
      .filter(Boolean);

    if (!defuddleAttempt.ok || !defuddleAttempt.payload) {
      return finalizePayload(legacyPayload, "legacy", warnings, nextDiagnostics);
    }

    const decision = chooseExtractor(defuddleAttempt.payload, legacyPayload);
    if (!decision.useDefuddle) {
      return finalizePayload(
        legacyPayload,
        "legacy",
        warnings.concat(decision.warningCode ? [decision.warningCode] : []),
        nextDiagnostics
      );
    }

    return finalizePayload(defuddleAttempt.payload, "defuddle", warnings, nextDiagnostics);
  }

  function runDefuddle(doc, legacyPayload, options) {
    const DefuddleCtor = resolveDefuddleConstructor();
    if (!DefuddleCtor) {
      return {
        ok: false,
        warnings: ["defuddle_unavailable"],
        diagnostics: createDiagnostics({
          defuddleAttempted: true
        })
      };
    }

    const clonedDoc = cloneDocument(doc);
    if (!clonedDoc) {
      return {
        ok: false,
        warnings: ["defuddle_clone_failed"],
        diagnostics: createDiagnostics({
          defuddleAttempted: true
        })
      };
    }

    const startedAt = now();
    try {
      // Defuddle mutates the document it parses, so it runs on a detached clone.
      const instance = new DefuddleCtor(clonedDoc, {
        url: String(options.url || doc?.URL || "").trim(),
        useAsync: false,
        debug: false
      });
      const result = instance.parse();
      const payload = buildDefuddlePayload(result, legacyPayload, doc);
      if (
        !payload.text ||
        Number(payload.metadata?.extractedWordCount || 0) < 60
      ) {
        return {
          ok: false,
          payload,
          warnings: ["defuddle_insufficient_text"],
          diagnostics: buildDefuddleDiagnostics(payload, startedAt)
        };
      }

      return {
        ok: true,
        payload,
        warnings: [],
        diagnostics: buildDefuddleDiagnostics(payload, startedAt)
      };
    } catch (error) {
      return {
        ok: false,
        warnings: ["defuddle_parse_failed"],
        diagnostics: createDiagnostics({
          defuddleAttempted: true,
          defuddleDurationMs: elapsedSince(startedAt)
        })
      };
    }
  }

  function buildDefuddlePayload(result, legacyPayload, doc) {
    const html = String(result?.content || "").trim();
    const text = extractTextFromHtml(doc, html);
    const extractedWordCount = countWords(text);
    const visibleWordCount = Math.max(
      extractedWordCount,
      toFiniteNumber(legacyPayload?.metadata?.visibleWordCount) || 0
    );
    const blockCount = countHtmlBlocks(doc, html, text);
    const baseKind = String(legacyPayload?.metadata?.contentKind || "").trim();
    const contentKind =
      baseKind === "article-content" || baseKind === "page-content"
        ? baseKind
        : extractedWordCount >= 220 && blockCount >= 5
          ? "article-content"
          : "page-content";

    return {
      text,
      metadata: {
        blockCount,
        extractedWordCount,
        visibleWordCount,
        coverageRatio:
          visibleWordCount > 0
            ? roundTo(extractedWordCount / Math.max(1, visibleWordCount), 3)
            : 0,
        contentKind,
        rootSelector: "defuddle",
        rootTag: "body"
      }
    };
  }

  function chooseExtractor(candidate, legacyPayload) {
    const legacyWordCount =
      toFiniteNumber(legacyPayload?.metadata?.extractedWordCount) ||
      countWords(legacyPayload?.text || "");
    const legacyBlockCount = Math.max(
      0,
      Math.round(Number(legacyPayload?.metadata?.blockCount) || 0)
    );
    const legacyCoverage = toFiniteNumber(legacyPayload?.metadata?.coverageRatio);
    const candidateCoverage = toFiniteNumber(candidate?.metadata?.coverageRatio);
    const legacyNoise = computeNoiseRatio(legacyPayload?.text || "");
    const candidateNoise = computeNoiseRatio(candidate?.text || "");
    const candidateWordCount =
      toFiniteNumber(candidate?.metadata?.extractedWordCount) ||
      countWords(candidate?.text || "");
    const candidateBlockCount = Math.max(
      0,
      Math.round(Number(candidate?.metadata?.blockCount) || 0)
    );

    if (candidateWordCount < 60) {
      return {
        useDefuddle: false,
        warningCode: "defuddle_word_count_below_threshold"
      };
    }

    if (
      legacyWordCount >= 100 &&
      candidateWordCount < legacyWordCount * 0.55
    ) {
      return {
        useDefuddle: false,
        warningCode: "defuddle_coverage_regression"
      };
    }

    if (
      legacyCoverage !== null &&
      candidateCoverage !== null &&
      candidateCoverage + 0.08 < legacyCoverage
    ) {
      return {
        useDefuddle: false,
        warningCode: "defuddle_coverage_regression"
      };
    }

    if (legacyBlockCount >= 5 && candidateBlockCount < 3) {
      return {
        useDefuddle: false,
        warningCode: "defuddle_block_regression"
      };
    }

    if (
      legacyNoise !== null &&
      candidateNoise !== null &&
      candidateNoise > legacyNoise + 0.08 &&
      candidateWordCount <= legacyWordCount * 1.1
    ) {
      return {
        useDefuddle: false,
        warningCode: "defuddle_noise_regression"
      };
    }

    return {
      useDefuddle: true,
      warningCode: null
    };
  }

  function finalizePayload(payload, extractor, warnings, diagnostics) {
    const mergedDiagnostics = mergeDiagnostics(
      diagnostics,
      payload?.metadata?.extractorDiagnostics
    );
    return {
      text: String(payload?.text || ""),
      metadata: {
        ...(payload?.metadata || buildLegacyMetadata()),
        extractor,
        extractorWarnings: dedupeList(warnings),
        extractorDurationMs: mergedDiagnostics.extractorDurationMs,
        legacyExtractorDurationMs: mergedDiagnostics.legacyDurationMs,
        defuddleExtractorDurationMs: mergedDiagnostics.defuddleDurationMs,
        defuddleAttempted: mergedDiagnostics.defuddleAttempted,
        extractorDiagnostics: mergedDiagnostics
      }
    };
  }

  function runLegacyExtractor(doc) {
    const legacyExtractor = Dom.extractVisibleDocumentPayload;
    const startedAt = now();
    const payload =
      typeof legacyExtractor === "function"
        ? legacyExtractor(doc)
        : {
            text: "",
            metadata: buildLegacyMetadata()
          };
    return {
      payload,
      durationMs: elapsedSince(startedAt)
    };
  }

  function resolveDefuddleConstructor() {
    if (typeof root.Defuddle === "function") {
      return root.Defuddle;
    }
    if (typeof root.Defuddle?.default === "function") {
      return root.Defuddle.default;
    }
    return null;
  }

  function cloneDocument(doc) {
    if (!doc) {
      return null;
    }

    try {
      if (typeof doc.cloneNode === "function") {
        const cloned = doc.cloneNode(true);
        if (cloned?.documentElement) {
          return cloned;
        }
      }
    } catch (error) {
      // Fall through to the DOMParser path.
    }

    try {
      const parser = new DOMParser();
      return parser.parseFromString(doc.documentElement.outerHTML, "text/html");
    } catch (error) {
      return null;
    }
  }

  function extractTextFromHtml(doc, html) {
    if (!html) {
      return "";
    }

    const container = doc.createElement("div");
    container.innerHTML = html;
    const textSource = container.innerText || container.textContent || "";
    return sanitizeText(textSource);
  }

  function countHtmlBlocks(doc, html, fallbackText) {
    if (!html) {
      return 0;
    }

    const container = doc.createElement("div");
    container.innerHTML = html;
    const selectors = [
      "p",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "li",
      "blockquote",
      "pre",
      "figcaption",
      "td",
      "th"
    ].join(",");
    const blocks = Array.from(container.querySelectorAll(selectors)).filter((element) => {
      return countWords(sanitizeText(element.textContent || "")) >= 3;
    });
    if (blocks.length) {
      return blocks.length;
    }

    const paragraphs = String(fallbackText || "")
      .split(/\n{2,}/)
      .map((part) => sanitizeText(part))
      .filter((part) => countWords(part) >= 3);
    return paragraphs.length;
  }

  function computeNoiseRatio(value) {
    const text = String(value || "");
    if (!text) {
      return null;
    }

    const matches = text.match(/[^A-Za-z0-9\s]/g);
    return roundTo((matches ? matches.length : 0) / text.length, 3);
  }

  function sanitizeText(value) {
    return typeof Text.sanitizeInput === "function"
      ? Text.sanitizeInput(value)
      : String(value || "").replace(/\s+/g, " ").trim();
  }

  function countWords(value) {
    return typeof Text.countWords === "function"
      ? Text.countWords(value)
      : sanitizeText(value).split(/\s+/).filter(Boolean).length;
  }

  function buildLegacyMetadata() {
    return {
      blockCount: 0,
      extractedWordCount: 0,
      visibleWordCount: 0,
      coverageRatio: 0,
      contentKind: "page-content",
      rootSelector: "body",
      rootTag: "body",
      extractorDurationMs: null,
      legacyExtractorDurationMs: null,
      defuddleExtractorDurationMs: null,
      defuddleAttempted: false,
      extractorDiagnostics: createDiagnostics()
    };
  }

  function buildDefuddleDiagnostics(payload, startedAt) {
    return createDiagnostics({
      defuddleAttempted: true,
      defuddleDurationMs: elapsedSince(startedAt),
      defuddleWordCount: toFiniteNumber(payload?.metadata?.extractedWordCount),
      defuddleBlockCount: toFiniteNumber(payload?.metadata?.blockCount),
      defuddleCoverageRatio: toFiniteNumber(payload?.metadata?.coverageRatio)
    });
  }

  function createDiagnostics(overrides = {}) {
    return {
      legacyDurationMs: toFiniteNumber(overrides.legacyDurationMs),
      defuddleDurationMs: toFiniteNumber(overrides.defuddleDurationMs),
      extractorDurationMs: toFiniteNumber(overrides.extractorDurationMs),
      defuddleAttempted: overrides.defuddleAttempted === true,
      defuddleWordCount: toFiniteNumber(overrides.defuddleWordCount),
      defuddleBlockCount: toFiniteNumber(overrides.defuddleBlockCount),
      defuddleCoverageRatio: toFiniteNumber(overrides.defuddleCoverageRatio)
    };
  }

  function mergeDiagnostics(base, updates) {
    const merged = createDiagnostics({
      ...(base || {}),
      ...(updates || {})
    });

    if (merged.extractorDurationMs === null) {
      const total =
        (merged.legacyDurationMs || 0) +
        (merged.defuddleAttempted ? merged.defuddleDurationMs || 0 : 0);
      merged.extractorDurationMs = total > 0 ? total : null;
    }

    return merged;
  }

  function now() {
    return Date.now();
  }

  function elapsedSince(startedAt) {
    const durationMs = now() - Number(startedAt || 0);
    return durationMs >= 0 ? durationMs : 0;
  }

  function toFiniteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function roundTo(value, decimals) {
    const factor = Math.pow(10, decimals);
    return Math.round((Number(value) || 0) * factor) / factor;
  }

  function dedupeList(values) {
    return Array.from(new Set((Array.isArray(values) ? values : []).filter(Boolean)));
  }
})(globalThis);

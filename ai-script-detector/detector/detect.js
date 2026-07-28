(function (root) {
  const App = (root.AIScriptDetector = root.AIScriptDetector || {});

  App.detect = {
    runDetection
  };

  function runDetection(inputText, options) {
    const result = App.analyze.runAnalysis(inputText, options);
    if (!result.ok) {
      return result;
    }

    const report = result.report;
    const baseConfidence = deriveBaseConfidence(report.metadata || {});
    const detectorConfidence = capConfidence(
      baseConfidence,
      options?.sourceConfidence || null
    );

    return {
      ok: true,
      detection: {
        aiScore: report.score,
        detectorConfidence,
        verdict: report.verdict,
        reasons: report.topReasons || [],
        categoryScores: report.categoryScores || {},
        triggeredPatterns: report.triggeredPatterns || [],
        flaggedSentences: report.flaggedSentences || [],
        explanation: report.explanation || ""
      },
      legacyReport: report
    };
  }

  function deriveBaseConfidence(metadata) {
    const wordCount = Number(metadata?.wordCount) || 0;
    const sentenceCount = Number(metadata?.sentenceCount) || 0;

    if (wordCount >= 700 && sentenceCount >= 12) {
      return "high";
    }
    if (wordCount >= 220 && sentenceCount >= 4) {
      return "medium";
    }
    return "low";
  }

  function capConfidence(baseConfidence, sourceConfidence) {
    const rank = {
      high: 3,
      medium: 2,
      low: 1
    };

    if (!sourceConfidence) {
      return baseConfidence;
    }

    const nextRank = Math.min(rank[baseConfidence] || 1, rank[sourceConfidence] || 1);
    return Object.keys(rank).find((key) => rank[key] === nextRank) || "low";
  }
})(globalThis);

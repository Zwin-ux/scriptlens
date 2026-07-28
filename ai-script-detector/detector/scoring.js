(function (root) {
  const App = (root.AIScriptDetector = root.AIScriptDetector || {});
  const Stats = App.stats;

  const WEIGHTS = {
    repetition: 0.16,
    uniformity: 0.14,
    genericity: 0.18,
    script_template: 0.14,
    title_packaging: 0.24,
    specificity_deficit: 0.08,
    burstiness: 0.06
  };

  const SENSITIVITY = {
    low: {
      multiplier: 0.9,
      categoryMultiplier: 0.92,
      flagLimit: 6
    },
    medium: {
      multiplier: 1,
      categoryMultiplier: 1,
      flagLimit: 8
    },
    high: {
      multiplier: 1.1,
      categoryMultiplier: 1.08,
      flagLimit: 10
    }
  };

  App.scoring = {
    SENSITIVITY,
    compileReport
  };

  function compileReport(context, categoryResults, options) {
    const sensitivityProfile = SENSITIVITY[options.sensitivity] || SENSITIVITY.medium;
    const categoryScores = {};
    const reasons = [];
    const triggeredPatterns = [];

    let weightedScore = 0;

    categoryResults.forEach((result) => {
      const adjustedScore = Stats.clamp(
        result.score * sensitivityProfile.categoryMultiplier,
        0,
        100
      );
      categoryScores[result.category] = Stats.round(adjustedScore);
      weightedScore += adjustedScore * (WEIGHTS[result.category] || 0);

      if (adjustedScore >= 28) {
        result.reasons.forEach((reason) => {
          reasons.push({
            category: result.category,
            score: adjustedScore,
            reason
          });
        });
      }

      result.triggers.forEach((trigger) => {
        triggeredPatterns.push({
          ...trigger,
          score: adjustedScore
        });
      });
    });

    const strongCategories = Object.values(categoryScores).filter((score) => score >= 60).length;
    const moderateCategories = Object.values(categoryScores).filter((score) => score >= 40).length;
    const crossSignalBoost =
      Math.max(0, strongCategories - 1) * 4 + Math.max(0, moderateCategories - 2) * 2;
    const dominantCategory = Math.max(...Object.values(categoryScores), 0);
    const strongTriggerCount = triggeredPatterns.filter((pattern) => (pattern.weight || 0) >= 14).length;
    const concentratedPatternBoost =
      context.wordCount <= 160
        ? Math.min(
            18,
            Math.max(0, dominantCategory - 65) * 0.18 + Math.max(0, strongTriggerCount - 1) * 2.5
          )
        : Math.min(8, Math.max(0, strongTriggerCount - 3) * 1.5);

    const finalScore = Stats.round(
      Stats.clamp(
        weightedScore * sensitivityProfile.multiplier +
          crossSignalBoost +
          concentratedPatternBoost,
        0,
        100
      )
    );

    const orderedReasons = reasons
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.reason);

    const topReasons = dedupeList(orderedReasons).slice(0, 5);
    const explanation = buildExplanation(topReasons);
    const flaggedSentences = compileFlaggedSentences(
      context,
      categoryResults,
      sensitivityProfile.flagLimit
    );

    return {
      score: finalScore,
      verdict: getVerdict(finalScore),
      explanation,
      topReasons,
      categoryScores,
      triggeredPatterns: triggeredPatterns
        .sort((left, right) => right.weight - left.weight)
        .slice(0, 12),
      flaggedSentences,
      metadata: {
        wordCount: context.wordCount,
        sentenceCount: context.sentenceCount,
        paragraphCount: context.paragraphCount,
        sensitivity: options.sensitivity,
        truncated: Boolean(options.truncated),
        preview: App.text.preview(context.text, 140)
      }
    };
  }

  function compileFlaggedSentences(context, categoryResults, limit) {
    const flagMap = new Map();

    categoryResults.forEach((result) => {
      result.flags.forEach((flag) => {
        if (!flagMap.has(flag.sentenceIndex)) {
          flagMap.set(flag.sentenceIndex, {
            sentenceIndex: flag.sentenceIndex,
            sentence: context.sentenceRecords[flag.sentenceIndex]?.sentence || "",
            reasons: [],
            severity: 0
          });
        }

        const entry = flagMap.get(flag.sentenceIndex);
        entry.severity += flag.weight || 0;
        if (!entry.reasons.includes(flag.reason)) {
          entry.reasons.push(flag.reason);
        }
      });
    });

    return Array.from(flagMap.values())
      .map((entry) => ({
        sentenceNumber: entry.sentenceIndex + 1,
        sentence: entry.sentence,
        reasons: entry.reasons.slice(0, 3),
        severity: Stats.clamp(Stats.round(entry.severity), 1, 100)
      }))
      .filter((entry) => entry.sentence)
      .sort((left, right) => right.severity - left.severity)
      .slice(0, limit);
  }

  function buildExplanation(topReasons) {
    if (!topReasons.length) {
      return "The passage did not trigger enough strong AI-like heuristics to support a high score.";
    }

    return topReasons.slice(0, 3).join(" ");
  }

  function getVerdict(score) {
    if (score >= 75) {
      return "Strongly AI-like";
    }
    if (score >= 55) {
      return "Likely AI-assisted";
    }
    if (score >= 30) {
      return "Mixed / possibly assisted";
    }
    return "Likely human / unclear";
  }

  function dedupeList(values) {
    const seen = new Set();
    return values.filter((value) => {
      if (seen.has(value)) {
        return false;
      }
      seen.add(value);
      return true;
    });
  }
})(globalThis);

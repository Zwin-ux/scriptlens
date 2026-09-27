(function (root) {
  const App = (root.AIScriptDetector = root.AIScriptDetector || {});
  const Stats = App.stats;

  // Lexical categories are direct evidence and combine like independent signals:
  // one strong category can carry the score without being averaged away by the
  // categories that found nothing. Each weight is how far that category alone can
  // push the lexical evidence toward certainty.
  const LEXICAL_WEIGHTS = {
    assistant_phrasing: 0.95,
    title_packaging: 0.85,
    genericity: 0.5,
    script_template: 0.3,
    repetition: 0.3
  };

  // Stylometric categories are weak, noisy evidence (especially for speech), so
  // they only contribute a bounded share of the final score.
  const STYLE_WEIGHTS = {
    specificity_deficit: 0.4,
    uniformity: 0.35,
    burstiness: 0.25
  };
  const STYLE_SHARE_PUNCTUATED = 0.25;
  const STYLE_SHARE_UNPUNCTUATED = 0.1;

  // How strongly unscripted-speech markers pull the score down (0..1 of the score).
  const SPONTANEITY_DAMPING = 0.55;

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

    let lexicalMiss = 1;
    let styleTotal = 0;
    let styleWeightTotal = 0;

    categoryResults.forEach((result) => {
      const adjustedScore = Stats.clamp(
        result.score * sensitivityProfile.categoryMultiplier,
        0,
        100
      );
      categoryScores[result.category] = Stats.round(adjustedScore);
      if (LEXICAL_WEIGHTS[result.category]) {
        lexicalMiss *= 1 - LEXICAL_WEIGHTS[result.category] * (adjustedScore / 100);
      }
      if (STYLE_WEIGHTS[result.category]) {
        styleTotal += adjustedScore * STYLE_WEIGHTS[result.category];
        styleWeightTotal += STYLE_WEIGHTS[result.category];
      }

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

    const lexicalEvidence = 1 - lexicalMiss;
    const styleEvidence = styleWeightTotal ? styleTotal / styleWeightTotal / 100 : 0;
    const styleShare =
      context.punctuated === false ? STYLE_SHARE_UNPUNCTUATED : STYLE_SHARE_PUNCTUATED;
    const spontaneity = Stats.clamp(Number(options.spontaneity?.score) || 0, 0, 1);
    const rawScore =
      100 * ((1 - styleShare) * lexicalEvidence + styleShare * styleEvidence) *
      (1 - SPONTANEITY_DAMPING * spontaneity);

    const finalScore = Stats.round(
      Stats.clamp(rawScore * sensitivityProfile.multiplier, 0, 100)
    );

    if (spontaneity >= 0.35) {
      reasons.push({
        category: "spontaneity",
        score: spontaneity * 100,
        reason:
          "Unscripted speech markers such as fillers, hedges, and self-corrections point toward a human speaker."
      });
    }

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
        segmentation: context.segmentation || "prose",
        punctuated: context.punctuated !== false,
        spontaneity: Stats.round(spontaneity * 100),
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

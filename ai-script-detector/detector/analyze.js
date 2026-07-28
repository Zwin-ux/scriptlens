(function (root) {
  const App = (root.AIScriptDetector = root.AIScriptDetector || {});
  const Text = App.text;

  App.analyze = {
    runAnalysis
  };

  function runAnalysis(inputText, options) {
    const safeOptions = {
      sensitivity: options?.sensitivity || "medium",
      source: options?.source || "Local analysis",
      maxTextLength: Number(options?.maxTextLength) || 18000,
      minCharacters: Number(options?.minCharacters) || 180,
      minWords: Number(options?.minWords) || 40
    };

    const sanitized = Text.sanitizeInput(inputText);
    if (!sanitized) {
      return {
        ok: false,
        error: "Provide more text to analyze."
      };
    }

    const truncated = Text.smartTruncate(sanitized, safeOptions.maxTextLength);
    const trimmedWordCount = Text.countWords(truncated.text);
    if (
      truncated.text.length < safeOptions.minCharacters ||
      trimmedWordCount < safeOptions.minWords
    ) {
      return {
        ok: false,
        error:
          "The text is too short for a useful heuristic read. Try at least 40 words or 180 characters."
      };
    }

    const context = App.heuristics.buildContext(truncated.text);
    if (context.sentenceCount < 3) {
      return {
        ok: false,
        error: "Add a few more complete sentences for a reliable score."
      };
    }

    const categoryResults = [
      App.heuristics.analyzeRepetition(context),
      App.heuristics.analyzeUniformity(context),
      App.heuristics.analyzeGenericity(context),
      App.heuristics.analyzeScriptTemplates(context),
      App.heuristics.analyzeTitlePackaging(context),
      App.heuristics.analyzeSpecificityDeficit(context),
      App.heuristics.analyzeBurstiness(context)
    ];

    const report = App.scoring.compileReport(context, categoryResults, {
      sensitivity: safeOptions.sensitivity,
      truncated: truncated.truncated
    });

    report.source = safeOptions.source;
    report.disclaimer =
      "This score reflects AI-like writing patterns, not proof of authorship.";

    return {
      ok: true,
      report
    };
  }
})(globalThis);

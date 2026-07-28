(function (root) {
  const ScriptLens = (root.ScriptLens = root.ScriptLens || {});
  const Transcript = (ScriptLens.transcript = ScriptLens.transcript || {});
  const Strategies = (Transcript.strategies = Transcript.strategies || {});
  const Text = (root.AIScriptDetector || {}).text;

  Strategies.titleDescription = {
    run
  };

  function run(context) {
    const adapter = context?.adapter || {};
    const parts = [adapter.title || "", adapter.description || ""]
      .map((part) => Text.sanitizeInput(part))
      .filter(Boolean);
    const text = Text.sanitizeInput(parts.join("\n\n"));
    if (!text) {
      return {
        ok: false,
        warningCodes: ["title_description_missing"],
        errorCode: "title_description_missing",
        errorMessage: "Neither the title nor description exposed usable text."
      };
    }

    return {
      ok: true,
      provider: "youtubeResolver",
      strategy: "title-description",
      languageCode: adapter.bootstrapSnapshot?.hl || null,
      originalLanguageCode: adapter.bootstrapSnapshot?.hl || null,
      requestedLanguageCode: context?.requestedLanguageCode || null,
      isGenerated: null,
      isTranslated: false,
      isMachineTranslated: false,
      videoDurationSeconds: adapter.videoDurationSeconds || null,
      segments: [],
      text,
      warnings: ["fallback_source", "weak_evidence"]
    };
  }
})(globalThis);

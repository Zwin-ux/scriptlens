(function (root) {
  const ScriptLens = (root.ScriptLens = root.ScriptLens || {});
  const Transcript = (ScriptLens.transcript = ScriptLens.transcript || {});
  const Strategies = (Transcript.strategies = Transcript.strategies || {});
  const Text = (root.AIScriptDetector || {}).text;

  Strategies.descriptionTranscript = {
    run
  };

  function run(context) {
    const adapter = context?.adapter || {};
    const text = Text.sanitizeInput(adapter.descriptionTranscriptText || "");
    if (!text) {
      return {
        ok: false,
        warningCodes: ["description_transcript_missing"],
        errorCode: "description_transcript_missing",
        errorMessage: "The description does not contain a usable transcript block."
      };
    }

    return {
      ok: true,
      provider: "youtubeResolver",
      strategy: "description-transcript",
      languageCode: adapter.bootstrapSnapshot?.hl || null,
      originalLanguageCode: adapter.bootstrapSnapshot?.hl || null,
      requestedLanguageCode: context?.requestedLanguageCode || null,
      isGenerated: null,
      isTranslated: false,
      isMachineTranslated: false,
      videoDurationSeconds: adapter.videoDurationSeconds || null,
      segments: [],
      text,
      warnings: ["fallback_source"]
    };
  }
})(globalThis);

(function (root) {
  const ScriptLens = (root.ScriptLens = root.ScriptLens || {});
  const Transcript = (ScriptLens.transcript = ScriptLens.transcript || {});
  const Strategies = (Transcript.strategies = Transcript.strategies || {});
  const Text = (root.AIScriptDetector || {}).text;

  Strategies.domTranscript = {
    run
  };

  async function run(context) {
    let adapter = context?.adapter || {};
    let segments = Array.isArray(adapter.domTranscriptSegments)
      ? adapter.domTranscriptSegments
      : [];

    if (!segments.length && typeof context?.domTranscriptLoader === "function") {
      const loadedAdapter = await context.domTranscriptLoader().catch(() => null);
      if (loadedAdapter) {
        adapter = loadedAdapter;
        segments = Array.isArray(adapter.domTranscriptSegments)
          ? adapter.domTranscriptSegments
          : [];
      }
    }

    const text = Text.sanitizeInput(segments.map((segment) => segment.text || "").join("\n"));
    if (!text) {
      return {
        ok: false,
        warningCodes: ["dom_transcript_unavailable"],
        errorCode: "dom_transcript_unavailable",
        errorMessage: "No visible transcript panel text was found after opening the transcript UI."
      };
    }

    return {
      ok: true,
      provider: "youtubeResolver",
      strategy: "dom-transcript",
      languageCode: adapter.domTranscriptLanguageCode || adapter.bootstrapSnapshot?.hl || null,
      originalLanguageCode:
        adapter.domTranscriptLanguageCode || adapter.bootstrapSnapshot?.hl || null,
      requestedLanguageCode: context?.requestedLanguageCode || null,
      isGenerated: null,
      isTranslated: false,
      isMachineTranslated: false,
      videoDurationSeconds: adapter.videoDurationSeconds || null,
      segments,
      text,
      warnings: [],
      requestShapeValidation: adapter.requestShapeValidation || null
    };
  }
})(globalThis);

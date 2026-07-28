(function (root) {
  const ScriptLens = (root.ScriptLens = root.ScriptLens || {});
  const Transcript = (ScriptLens.transcript = ScriptLens.transcript || {});
  const Providers = (Transcript.providers = Transcript.providers || {});

  Providers.nativeHelper = {
    resolve
  };

  async function resolve(context) {
    return {
      ok: false,
      provider: "nativeHelper",
      strategy: "local-whisper",
      skipped: true,
      warningCodes: ["helper_unavailable"],
      errorCode: "helper_unavailable",
      errorMessage:
        "Enhanced extraction is not available in this extension-only build."
    };
  }
})(globalThis);

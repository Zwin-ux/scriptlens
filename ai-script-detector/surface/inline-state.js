(function (root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  const globalRoot = root || globalThis;
  globalRoot.ScriptLensInlineState = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const DEFAULT_SELECTION = Object.freeze({
    includeSources: ["transcript"],
    trackBaseUrl: "",
    allowFallbackText: false
  });

  function syncVideoSelection(input) {
    const video = input?.context?.video;
    const currentSelection = input?.currentSelection || DEFAULT_SELECTION;
    const preserveCurrentSelection = input?.preserveCurrentSelection === true;
    const defaultSelection = input?.defaultSelection || DEFAULT_SELECTION;

    if (!video) {
      return { ...defaultSelection };
    }

    const defaultPreset = video.defaultPreset || defaultSelection;
    let includeSources = preserveCurrentSelection
      ? (currentSelection.includeSources || []).filter(
          (source) => video.availableSources?.[source]
        )
      : [];
    if (!includeSources.length) {
      includeSources = (defaultPreset.includeSources || []).slice();
    }

    const trackOptions = (video.transcriptTracks || []).filter(
      (track) =>
        track.kind !== "visible" &&
        track.kind !== "description-transcript" &&
        track.baseUrl !== "visible-dom-transcript" &&
        track.baseUrl !== "description-transcript"
    );
    let trackBaseUrl = preserveCurrentSelection ? currentSelection.trackBaseUrl : "";
    if (!trackOptions.find((track) => track.baseUrl === trackBaseUrl)) {
      trackBaseUrl = defaultPreset.trackBaseUrl || trackOptions[0]?.baseUrl || "";
    }

    return {
      includeSources,
      trackBaseUrl,
      allowFallbackText: preserveCurrentSelection
        ? Boolean(currentSelection.allowFallbackText)
        : Boolean(defaultPreset.allowFallbackText)
    };
  }

  function summarizeContext(context) {
    if (!context) {
      return null;
    }

    return {
      supported: Boolean(context.supported),
      isYouTubeVideo: Boolean(context.isYouTubeVideo),
      transcriptAvailable: Boolean(context.transcriptAvailable),
      video: context.video
        ? {
            title: context.video.title || "",
            videoId: context.video.videoId || "",
            availableSources: context.video.availableSources || {},
            transcriptTrackCount: Array.isArray(context.video.transcriptTracks)
              ? context.video.transcriptTracks.length
              : 0
          }
        : null
    };
  }

  function summarizeError(error) {
    if (!error) {
      return null;
    }

    return {
      message: error.message || String(error),
      stack: error.stack || ""
    };
  }

  function buildInlineRuntimeError(error, phase) {
    const message = String(error?.message || "");
    if (/timed out/i.test(message)) {
      return phase === "init"
        ? "ScriptLens took too long to load this video. Refresh the page and try again."
        : "ScriptLens took too long to finish the transcript check. Try again on this video.";
    }
    return message || "ScriptLens could not finish the transcript check for this video.";
  }

  return {
    DEFAULT_SELECTION,
    syncVideoSelection,
    summarizeContext,
    summarizeError,
    buildInlineRuntimeError
  };
});

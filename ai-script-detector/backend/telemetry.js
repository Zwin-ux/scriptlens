module.exports = {
  emitStageEvent,
  normalizeTelemetryDetail,
  summarizeError,
  summarizeTelemetryCandidate
};

function emitStageEvent(events, callback, event) {
  const detail = normalizeTelemetryDetail(event.detail);
  const normalizedEvent = {
    traceId: event.traceId || "",
    type: event.type || "stage",
    stage: event.stage || "",
    outcome: event.outcome || "unknown",
    startedAt: toFiniteNumber(event.startedAt),
    endedAt: toFiniteNumber(event.endedAt),
    durationMs: toFiniteNumber(event.durationMs),
    cacheStatus: event.cacheStatus || null,
    errorCode: event.errorCode || null,
    warnings: Array.isArray(event.warnings) ? event.warnings.slice(0, 8) : [],
    circuitState: event.circuitState || null,
    warning: event.warning || null,
    videoDurationSeconds: toFiniteNumber(event.videoDurationSeconds),
    candidate: event.candidate || null,
    winnerReason: event.winnerReason || event.candidate?.winnerReason || null,
    authenticatedModeEnabled:
      typeof event.authenticatedModeEnabled === "boolean"
        ? event.authenticatedModeEnabled
        : event.candidate?.authenticatedModeEnabled ??
          detail?.authenticatedModeEnabled ??
          detail?.authentication?.authenticatedModeEnabled ??
          null,
    authenticatedAcquisitionUsed:
      typeof event.authenticatedAcquisitionUsed === "boolean"
        ? event.authenticatedAcquisitionUsed
        : event.candidate?.authenticatedAcquisitionUsed ??
          detail?.authenticatedAcquisitionUsed ??
          detail?.authentication?.authenticatedAcquisitionUsed ??
          (Array.isArray(detail?.attempts)
            ? detail.attempts.some((attempt) => attempt?.authenticatedAcquisitionUsed === true)
            : null),
    acquisitionPathUsed:
      event.acquisitionPathUsed ||
      event.candidate?.acquisitionPathUsed ||
      detail?.acquisitionPathUsed ||
      detail?.authentication?.acquisitionPathUsed ||
      (Array.isArray(detail?.attempts)
        ? detail.attempts.find(
            (attempt) => attempt?.authenticatedAcquisitionUsed === true && attempt?.acquisitionPathUsed
          )?.acquisitionPathUsed || null
        : null),
    detail
  };
  events.push(normalizedEvent);
  if (typeof callback === "function") {
    callback(normalizedEvent);
  }
}

function normalizeTelemetryDetail(detail) {
  if (detail === undefined || detail === null) {
    return null;
  }

  try {
    return JSON.parse(JSON.stringify(detail));
  } catch (error) {
    return {
      value: truncateText(String(detail || ""), 400)
    };
  }
}

function summarizeError(error) {
  if (!error) {
    return null;
  }
  return {
    name: error.name || "Error",
    message: truncateText(error.message || String(error), 400)
  };
}

function summarizeTelemetryCandidate(candidate) {
  if (!candidate) {
    return null;
  }
  return {
    strategy: candidate.strategy || null,
    quality: candidate.quality || null,
    originKind: candidate.originKind || null,
    recoveryTier: candidate.recoveryTier || null,
    sourceTrustTier: candidate.sourceTrustTier || null,
    sourceConfidence: candidate.sourceConfidence || null,
    winnerReason: candidate.winnerReason || null,
    qualityGate: candidate.qualityGate || null,
    authenticatedModeEnabled:
      typeof candidate.authenticatedModeEnabled === "boolean"
        ? candidate.authenticatedModeEnabled
        : null,
    authenticatedAcquisitionUsed:
      typeof candidate.authenticatedAcquisitionUsed === "boolean"
        ? candidate.authenticatedAcquisitionUsed
        : null,
    acquisitionPathUsed: candidate.acquisitionPathUsed || null,
    coverageRatio:
      typeof candidate.coverageRatio === "number" ? candidate.coverageRatio : null,
    segmentCount: Array.isArray(candidate.segments)
      ? candidate.segments.length
      : candidate.segmentCount || 0,
    languageCode: candidate.languageCode || null,
    originalLanguageCode: candidate.originalLanguageCode || null
  };
}

function toFiniteNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function truncateText(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1))}...`;
}

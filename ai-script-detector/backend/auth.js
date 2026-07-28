const DISABLED_MODE = "disabled";
const COOKIE_FILE_MODE = "cookie-file";

module.exports = {
  COOKIE_FILE_MODE,
  DISABLED_MODE,
  resolveBackendAuthConfig,
  normalizeAuthenticatedMode,
  resolveAuthenticationMetadata,
  eventUsesAuthenticatedAcquisition,
  inferAcquisitionPathUsed
};

function resolveBackendAuthConfig(policy) {
  const auth = policy?.backend?.auth || {};
  const mode = normalizeAuthenticatedMode(auth.mode);
  const cookieFilePath = String(auth.cookieFilePath || "").trim();
  return {
    mode,
    enabled: mode !== DISABLED_MODE && Boolean(cookieFilePath),
    cookieFilePath,
    useForYtDlp: auth.useForYtDlp !== false,
    useForBrowserSession: auth.useForBrowserSession !== false
  };
}

function normalizeAuthenticatedMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return DISABLED_MODE;
  }
  if (["1", "true", "yes", "on", "enabled", "cookie-file", "cookies"].includes(normalized)) {
    return COOKIE_FILE_MODE;
  }
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) {
    return DISABLED_MODE;
  }
  return normalized;
}

function resolveAuthenticationMetadata(input = {}) {
  const authConfig = resolveBackendAuthConfig(input.policy);
  const stageTelemetry = Array.isArray(input.stageTelemetry) ? input.stageTelemetry : [];
  const authenticatedAcquisitionUsed =
    typeof input.authenticatedAcquisitionUsed === "boolean"
      ? input.authenticatedAcquisitionUsed
      : stageTelemetry.some((event) => eventUsesAuthenticatedAcquisition(event));
  const acquisitionPathUsed =
    input.acquisitionPathUsed || inferAcquisitionPathUsed(stageTelemetry) || null;
  return {
    authenticatedModeEnabled:
      typeof input.authenticatedModeEnabled === "boolean"
        ? input.authenticatedModeEnabled
        : authConfig.enabled,
    authenticatedAcquisitionUsed,
    acquisitionPathUsed
  };
}

function eventUsesAuthenticatedAcquisition(event) {
  if (!event || typeof event !== "object") {
    return false;
  }
  if (event.authenticatedAcquisitionUsed === true) {
    return true;
  }
  if (event.candidate?.authenticatedAcquisitionUsed === true) {
    return true;
  }
  if (event.detail?.authenticatedAcquisitionUsed === true) {
    return true;
  }
  if (event.detail?.authentication?.authenticatedAcquisitionUsed === true) {
    return true;
  }
  if (Array.isArray(event.detail?.attempts)) {
    return event.detail.attempts.some((attempt) => attempt?.authenticatedAcquisitionUsed === true);
  }
  return false;
}

function inferAcquisitionPathUsed(stageTelemetry) {
  const events = Array.isArray(stageTelemetry) ? stageTelemetry.slice().reverse() : [];
  for (const event of events) {
    if (event?.acquisitionPathUsed) {
      return event.acquisitionPathUsed;
    }
    if (event?.candidate?.acquisitionPathUsed) {
      return event.candidate.acquisitionPathUsed;
    }
    if (event?.detail?.acquisitionPathUsed) {
      return event.detail.acquisitionPathUsed;
    }
    if (event?.detail?.authentication?.acquisitionPathUsed) {
      return event.detail.authentication.acquisitionPathUsed;
    }
    if (Array.isArray(event?.detail?.attempts)) {
      const authenticatedAttempt = event.detail.attempts.find(
        (attempt) => attempt?.authenticatedAcquisitionUsed === true && attempt?.acquisitionPathUsed
      );
      if (authenticatedAttempt?.acquisitionPathUsed) {
        return authenticatedAttempt.acquisitionPathUsed;
      }
    }
  }
  return null;
}

export function isRetryableInlineTransportError(error) {
  const message = String(error?.message || "");
  return /ERR_NETWORK_CHANGED|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_(CLOSED|RESET|TIMED_OUT)|ERR_ABORTED/i.test(
    message
  );
}

export function buildSummary(results) {
  const backendSuccess = results.filter((entry) => entry.backend?.ok).length;
  const inlineSuccess = results.filter((entry) => entry.inline?.outcome === "success").length;
  const inlineMeasured = results.filter(
    (entry) => entry.inline && entry.inline.outcome !== "transport"
  ).length;
  const inlineCompact = results.filter((entry) => entry.inline?.compactInline === true).length;
  const inlineTransportIssues = results.filter(
    (entry) => entry.inline?.outcome === "transport"
  ).length;
  const backendGoodInlineErrors = results.filter(
    (entry) => entry.backend?.ok && entry.inline && entry.inline.outcome !== "success"
  ).length;
  const canaryMismatches = results
    .filter((entry) => entry.canary)
    .filter((entry) => entry.backend?.meetsExpectation === false)
    .map((entry) => `${entry.id}: expected canary outcome did not match actual winner ${entry.backend?.winnerReason || "unknown"}`);

  return {
    total: results.length,
    backendSuccess,
    inlineSuccess,
    inlineMeasured,
    inlineCompact,
    inlineTransportIssues,
    backendGoodInlineErrors,
    canaryMismatches
  };
}

export function formatInlineOutcome(inline) {
  if (inline.outcome === "transport") {
    return "transport (env)";
  }
  if (inline.understandable === false) {
    return `${inline.outcome} (unclear)`;
  }
  return inline.outcome;
}

export function formatInlineCompact(inline) {
  if (inline.outcome === "transport" || inline.compactInline == null) {
    return "skipped";
  }
  return inline.compactInline ? "yes" : "no";
}

export function formatWorkspaceHandoff(inline) {
  if (inline.outcome === "transport" || inline.workspaceHandoffWorks == null) {
    return "skipped";
  }
  return inline.workspaceHandoffWorks ? "yes" : "no";
}

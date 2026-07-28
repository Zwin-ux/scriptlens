const path = require("path");
const { test, expect } = require("@playwright/test");

const Auth = require(path.join(__dirname, "..", "backend", "auth.js"));
const Telemetry = require(path.join(__dirname, "..", "backend", "telemetry.js"));

test.describe("ScriptLens backend helper modules", () => {
  test("resolves auth metadata from policy and telemetry", () => {
    const metadata = Auth.resolveAuthenticationMetadata({
      policy: {
        backend: {
          auth: {
            mode: "cookie-file",
            cookieFilePath: "/secrets/youtube/cookies.txt"
          }
        }
      },
      stageTelemetry: [
        {
          detail: {
            authentication: {
              authenticatedAcquisitionUsed: true,
              acquisitionPathUsed: "yt-dlp"
            }
          }
        }
      ]
    });

    expect(metadata).toEqual({
      authenticatedModeEnabled: true,
      authenticatedAcquisitionUsed: true,
      acquisitionPathUsed: "yt-dlp"
    });
  });

  test("normalizes telemetry detail and winner summaries", () => {
    const events = [];
    Telemetry.emitStageEvent(events, null, {
      traceId: "trace-1",
      stage: "winner",
      outcome: "success",
      winnerReason: "quality-eligible:manual_caption_track",
      candidate: {
        originKind: "manual_caption_track",
        recoveryTier: "hosted_transcript",
        sourceTrustTier: "caption-derived"
      },
      detail: {
        nested: true
      }
    });

    expect(events).toHaveLength(1);
    expect(events[0].detail).toEqual({ nested: true });
    expect(events[0].winnerReason).toBe("quality-eligible:manual_caption_track");
  });
});

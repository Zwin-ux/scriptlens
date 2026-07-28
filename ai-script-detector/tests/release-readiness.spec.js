import { test, expect } from "@playwright/test";
import { evaluateReleaseReadiness } from "../scripts/release-readiness-lib.mjs";

test.describe("release readiness gate", () => {
  test("passes a healthy canary bundle with backend metadata", () => {
    const report = evaluateReleaseReadiness({
      mode: "canary",
      defuddleReport: {
        summary: {
          total: 8,
          transcriptRegressions: 0,
          labelingIssues: 0,
          expectationMismatchCounts: {
            control: 0,
            defuddle: 0
          }
        }
      },
      stagedCanaryReport: {
        backendOrigin: "https://backend.example.com",
        summary: {
          total: 6,
          backendSuccess: 4,
          inlineSuccess: 4,
          inlineMeasured: 4,
          inlineCompact: 4,
          inlineTransportIssues: 0,
          backendGoodInlineErrors: 0,
          canaryMismatches: []
        },
        matrix: [
          {
            backend: {
              meetsExpectation: true
            }
          }
        ]
      },
      stagedQaReport: {
        backendOrigin: "https://backend.example.com",
        summary: {
          total: 10,
          backendSuccess: 7,
          inlineSuccess: 7,
          inlineMeasured: 7,
          inlineCompact: 7,
          inlineTransportIssues: 0,
          backendGoodInlineErrors: 0,
          canaryMismatches: []
        },
        matrix: [
          {
            backend: {
              meetsExpectation: true
            }
          }
        ]
      },
      backendMetadata: {
        origin: "https://backend.example.com",
        version: {
          ok: true,
          status: 200,
          body: {
            service: "scriptlens-backend",
            version: "0.1.0",
            authenticatedModeEnabled: true,
            asrEnabled: false,
            capabilities: {
              ytDlp: {
                available: true,
                source: "auto-detected-binary"
              },
              asr: {
                configured: false
              }
            }
          }
        }
      }
    });

    expect(report.ok).toBeTruthy();
    expect(report.healthScore).toBe(90);
    expect(report.checks.every((check) => check.status !== "fail")).toBeTruthy();
  });

  test("fails public readiness when corpus honesty or backend capability checks regress", () => {
    const report = evaluateReleaseReadiness({
      mode: "public",
      defuddleReport: {
        summary: {
          total: 8,
          transcriptRegressions: 1,
          labelingIssues: 0,
          expectationMismatchCounts: {
            control: 0,
            defuddle: 2
          }
        }
      },
      stagedCanaryReport: {
        backendOrigin: "https://backend.example.com",
        summary: {
          total: 6,
          backendSuccess: 3,
          inlineSuccess: 1,
          inlineMeasured: 2,
          inlineCompact: 2,
          inlineTransportIssues: 0,
          backendGoodInlineErrors: 1,
          canaryMismatches: ["video-1"]
        },
        matrix: [
          {
            backend: {
              meetsExpectation: false
            }
          }
        ]
      },
      stagedQaReport: {
        backendOrigin: "https://backend.example.com",
        summary: {
          total: 10,
          backendSuccess: 4,
          inlineSuccess: 2,
          inlineMeasured: 4,
          inlineCompact: 3,
          inlineTransportIssues: 1,
          backendGoodInlineErrors: 1,
          canaryMismatches: []
        },
        matrix: [
          {
            backend: {
              meetsExpectation: false
            }
          }
        ]
      },
      backendMetadata: {
        origin: "https://backend.example.com",
        version: {
          ok: true,
          status: 200,
          body: {
            service: "scriptlens-backend",
            version: "0.1.0",
            authenticatedModeEnabled: false,
            asrEnabled: true,
            capabilities: {
              ytDlp: {
                available: false,
                source: null
              },
              asr: {
                configured: false
              }
            }
          }
        }
      }
    });

    expect(report.ok).toBeFalsy();
    expect(report.checks.filter((check) => check.status === "fail").length).toBeGreaterThan(0);
    expect(report.healthScore).toBeLessThan(50);
    const capabilityCheck = report.checks.find((check) => check.id === "backend-capabilities");
    expect(capabilityCheck?.status).toBe("fail");
  });
});

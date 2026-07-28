import { test, expect } from "@playwright/test";
import {
  buildSummary,
  isRetryableInlineTransportError
} from "../scripts/staged-consumer-qa-lib.mjs";

test.describe("staged consumer qa runner", () => {
  test("retries inline navigation for transient browser transport errors", () => {
    expect(
      isRetryableInlineTransportError(
        new Error("page.goto: net::ERR_INTERNET_DISCONNECTED at https://www.youtube.com/watch?v=dQw4w9WgXcQ")
      )
    ).toBe(true);
    expect(
      isRetryableInlineTransportError(
        new Error("page.goto: net::ERR_CONNECTION_RESET at https://www.youtube.com/watch?v=jNQXAC9IVRw")
      )
    ).toBe(true);
    expect(
      isRetryableInlineTransportError(
        new Error("page.goto: Target closed while navigating")
      )
    ).toBe(false);
  });

  test("excludes transport-only inline failures from product compact metrics", () => {
    const summary = buildSummary([
      {
        backend: { ok: true },
        inline: {
          outcome: "success",
          compactInline: true
        }
      },
      {
        backend: { ok: false },
        inline: {
          outcome: "transport",
          compactInline: null
        }
      },
      {
        backend: { ok: false },
        inline: {
          outcome: "error",
          compactInline: true
        }
      }
    ]);

    expect(summary.backendSuccess).toBe(1);
    expect(summary.inlineSuccess).toBe(1);
    expect(summary.inlineMeasured).toBe(2);
    expect(summary.inlineCompact).toBe(2);
    expect(summary.inlineTransportIssues).toBe(1);
    expect(summary.backendGoodInlineErrors).toBe(0);
  });
});

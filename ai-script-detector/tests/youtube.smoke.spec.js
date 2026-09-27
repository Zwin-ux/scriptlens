const { test, expect, waitForActiveTabInfo } = require("./fixtures");

const SAMPLE_VIDEO_URL =
  process.env.SCRIPTLENS_TEST_VIDEO_URL ||
  "https://www.youtube.com/watch?v=vWQk67meYUA";

test.describe("ScriptLens YouTube release flow", () => {
  test.describe.configure({ timeout: 180000 });

  test("keeps inline analysis on the YouTube page until the user explicitly opens the workspace", async ({
    context,
    serviceWorker
  }) => {
    await saveExtensionSettings(serviceWorker, {});

    const videoPage = await context.newPage();
    await gotoVideoWithRetry(videoPage, SAMPLE_VIDEO_URL);
    await videoPage.bringToFront();
    await videoPage.waitForTimeout(2500);

    const overlay = videoPage.locator("#scriptlens-youtube-cta-root");
    await expect(overlay).toBeVisible({ timeout: 15000 });
    await expect(overlay.getByRole("button", { name: "Analyze video" })).toBeVisible();
    await expect(overlay.getByRole("button", { name: "Open full workspace" })).toHaveCount(0);
    await expect.poll(() => getPanelLaunchRequest(serviceWorker)).toBeNull();

    await clickOverlayButtonWithRetry(overlay, "Analyze video");
    const outcome = await waitForInlineOutcome(videoPage, overlay, 20000);

    await expect.poll(() => getPanelLaunchRequest(serviceWorker)).toBeNull();
    await videoPage.evaluate(() => {
      window.dispatchEvent(new Event("yt-page-data-updated"));
    });

    if (outcome === "success") {
      await expect(overlay.getByRole("button", { name: "Details" })).toBeVisible();
      await expect(overlay).toContainText("/100");
      await expect(overlay).toContainText("/100");
    } else {
      expect(outcome).toBe("error");
      await expect(overlay).toContainText("We couldn't finish the transcript check");
      await expect(overlay.getByRole("button", { name: "Try again" })).toBeVisible({
        timeout: 10000
      });
    }

    await videoPage.bringToFront();
    await clickOverlayButtonWithRetry(overlay, "Open full workspace");

    await expect
      .poll(async () => {
        const launchRequest = await getPanelLaunchRequest(serviceWorker);
        return launchRequest?.request?.mode || "";
      })
      .toBe("youtube");
  });

  test("renders fallback text only when the user analyzes title and description instead of transcript", async ({
    context,
    extensionId,
    serviceWorker
  }) => {
    const videoPage = await context.newPage();
    await gotoVideoWithRetry(videoPage, SAMPLE_VIDEO_URL);
    await videoPage.bringToFront();
    await videoPage.waitForTimeout(2500);

    const targetTab = await waitForActiveTabInfo(
      serviceWorker,
      (tab) => Boolean(tab?.url && /^https:\/\/www\.youtube\.com\/watch\?/.test(tab.url))
    );

    const popupPage = await context.newPage();
    await popupPage.goto(
      `chrome-extension://${extensionId}/popup.html?targetTabId=${targetTab.id}&targetWindowId=${targetTab.windowId}`,
      { waitUntil: "domcontentloaded" }
    );

    await expect(popupPage.locator("#youtubeControls")).toBeVisible();
    await expect(popupPage.locator("#videoSourceChips")).toContainText("Transcript");

    const response = await popupPage.evaluate(async ({ tabId, windowId }) => {
      return await chrome.runtime.sendMessage({
        type: "popup:analyze",
        tabId,
        windowId,
        request: {
          mode: "youtube",
          includeSources: ["description", "title"],
          trackBaseUrl: "",
          transcriptBias: "manual-en",
          requireTranscript: true,
          allowFallbackText: false
        }
      });
    }, { tabId: targetTab.id, windowId: targetTab.windowId });

    expect(response.ok).toBeTruthy();
    expect(response.report.acquisition.acquisitionState).toBe("fallback-text-only");
    expect(response.report.acquisition.sourceLabel).toContain("fallback");
    expect(response.report.inputQuality.label).toBe("Weak input");
    expect(response.report.explanation).toBeTruthy();
  });
});

async function waitForAnalysisResult(page, timeoutMs) {
  try {
    await expect(page.locator("#resultContent")).toBeVisible({ timeout: timeoutMs });
    return true;
  } catch (error) {
    return false;
  }
}

async function waitForInlineOutcome(page, overlay, timeoutMs) {
  const successButton = overlay.getByRole("button", { name: "Details" });
  const errorButton = overlay.getByRole("button", { name: "Try again" });
  const deadlineAt = Date.now() + timeoutMs;

  while (Date.now() < deadlineAt) {
    if ((await successButton.count()) && (await successButton.first().isVisible().catch(() => false))) {
      return "success";
    }
    if ((await errorButton.count()) && (await errorButton.first().isVisible().catch(() => false))) {
      return "error";
    }
    await page.waitForTimeout(250);
  }

  return "timeout";
}

async function clickOverlayButtonWithRetry(overlay, name, attempts = 5) {
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const button = overlay.getByRole("button", { name }).first();
      await button.waitFor({ state: "visible", timeout: 10000 });
      await button.click();
      return;
    } catch (error) {
      lastError = error;
      if (!/detached|not stable|closed/i.test(String(error?.message || ""))) {
        throw error;
      }
    }
  }

  throw lastError;
}

async function gotoVideoWithRetry(page, url, attempts = 3) {
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      return;
    } catch (error) {
      lastError = error;
      if (!/ERR_NETWORK_CHANGED/i.test(String(error?.message || "")) || attempt === attempts - 1) {
        throw error;
      }
      await page.waitForTimeout(500);
    }
  }

  throw lastError;
}

async function saveExtensionSettings(serviceWorker, partialSettings) {
  await serviceWorker.evaluate(async (updates) => {
    const defaultSettings = {
      sensitivity: "medium",
      maxTextLength: 18000,
      minCharacters: 180,
      minWords: 40,
      recentReportsLimit: 5,
      debugMode: false
    };

    await new Promise((resolve, reject) => {
      chrome.storage.local.set(
        {
          settings: {
            ...defaultSettings,
            ...updates
          }
        },
        () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve();
        }
      );
    });
  }, partialSettings);
}

async function getPanelLaunchRequest(serviceWorker) {
  return await serviceWorker.evaluate(async () => {
    return await new Promise((resolve, reject) => {
      chrome.storage.session.get(["panelLaunchRequest"], (values) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(values.panelLaunchRequest || null);
      });
    });
  });
}

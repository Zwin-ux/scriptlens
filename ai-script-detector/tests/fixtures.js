const path = require("path");
const { test: base, expect, chromium } = require("@playwright/test");

const extensionPath = process.env.SCRIPTLENS_EXTENSION_PATH
  ? path.resolve(process.env.SCRIPTLENS_EXTENSION_PATH)
  : path.resolve(__dirname, "..");

const test = base.extend({
  context: async ({}, use, testInfo) => {
    const userDataDir = path.join(testInfo.outputDir, "user-data");
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chromium",
      headless: process.env.PW_HEADLESS === "1",
      viewport: {
        width: 1600,
        height: 1000
      },
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`
      ]
    });

    await use(context);
    await context.close();
  },

  serviceWorker: async ({ context }, use) => {
    let [serviceWorker] = context.serviceWorkers();
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent("serviceworker");
    }

    await use(serviceWorker);
  },

  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host);
  }
});

async function getActiveTabInfo(serviceWorker) {
  return serviceWorker.evaluate(() => {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs && tabs[0];
        resolve(
          tab
            ? {
                id: tab.id,
                windowId: tab.windowId,
                url: tab.url || "",
                title: tab.title || ""
              }
            : null
        );
      });
    });
  });
}

async function waitForActiveTabInfo(serviceWorker, predicate, timeoutMs = 15000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const tab = await getActiveTabInfo(serviceWorker);
    if (predicate(tab)) {
      return tab;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error("Timed out while waiting for the expected active tab.");
}

module.exports = {
  test,
  expect,
  extensionPath,
  getActiveTabInfo,
  waitForActiveTabInfo
};

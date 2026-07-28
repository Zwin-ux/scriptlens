const http = require("http");
const path = require("path");
const { test, expect } = require("./fixtures");

const ROOT_DIR = path.resolve(__dirname, "..");

test.describe("ScriptLens article and popup contracts", () => {
  test("extracts a clean article page as article content without layout noise", async ({
    context
  }) => {
    const server = await startArticleServer();
    try {
      const articlePage = await context.newPage();
      await articlePage.goto(server.url, { waitUntil: "domcontentloaded" });
      await articlePage.addScriptTag({ path: path.join(ROOT_DIR, "utils", "text.js") });
      await articlePage.addScriptTag({ path: path.join(ROOT_DIR, "utils", "dom.js") });

      const payload = await articlePage.evaluate(() => {
        return globalThis.AIScriptDetector.dom.extractVisibleDocumentPayload(document);
      });

      expect(payload.metadata.contentKind).toBe("article-content");
      expect(payload.metadata.extractedWordCount).toBeGreaterThan(180);
      expect(payload.metadata.blockCount).toBeGreaterThanOrEqual(5);
      expect(payload.text).toContain("Field Notes From A Long Interview");
      expect(payload.text).toContain("On October 12, 2025");
      expect(payload.text).not.toContain("Related stories and newsletter promos");
      expect(payload.text).not.toContain("ScriptLens sample article page");
    } finally {
      await stopServer(server);
    }
  });

  test("stores debug reports when manual popup analysis runs with debug enabled", async ({
    context,
    extensionId,
    serviceWorker
  }) => {
    const popupPage = await context.newPage();
    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`, {
      waitUntil: "domcontentloaded"
    });

    const debugReportsBefore = await serviceWorker.evaluate(() => {
      return new Promise((resolve) => {
        chrome.storage.local.get(["debugReports"], (value) => {
          resolve(value.debugReports || []);
        });
      });
    });

    expect(debugReportsBefore).toEqual([]);

    await popupPage.locator("#settingsPanel summary").click();
    await popupPage.locator("#debugModeInput").check();
    await popupPage.locator("#saveSettingsButton").click();
    await popupPage.locator("#manualInput").fill(
      [
        "Here is the main idea behind the process and why it matters to the audience.",
        "In this breakdown we walk through the system step by step so the structure stays easy to follow.",
        "The language is intentionally repetitive so the detector has a stable local signal to work with."
      ].join(" ")
    );
    await popupPage.locator("#analyzeManualButton").click();
    await expect(popupPage.locator("#resultContent")).toBeVisible({ timeout: 15000 });

    const debugReports = await serviceWorker.evaluate(() => {
      return new Promise((resolve) => {
        chrome.storage.local.get(["debugReports"], (value) => {
          resolve(value.debugReports || []);
        });
      });
    });

    expect(Array.isArray(debugReports)).toBeTruthy();
    expect(debugReports.length).toBeGreaterThan(0);
    expect(debugReports[0].kind).toBe("manual-input");
    expect(typeof debugReports[0].normalizedTextSlice).toBe("string");
    expect(debugReports[0].normalizedTextSlice.length).toBeGreaterThan(50);
  });
});

async function startArticleServer() {
  const html = buildArticleHtml();
  const server = http.createServer((request, response) => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8"
    });
    response.end(html);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${address.port}/article`
  };
}

async function stopServer(serverInfo) {
  await new Promise((resolve, reject) => {
    serverInfo.server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function buildArticleHtml() {
  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Field Notes From A Long Interview</title>
      <style>
        body { font-family: Georgia, serif; margin: 0; background: #f7f5ef; color: #1c2533; }
        header, footer, nav, aside { padding: 16px 24px; background: #ebe7dd; }
        main { max-width: 760px; margin: 0 auto; padding: 24px; }
        article { background: white; border: 1px solid #d8d1c6; border-radius: 16px; padding: 28px; }
        p { line-height: 1.7; margin: 0 0 16px; }
      </style>
    </head>
    <body>
      <nav>Home / Magazine / Interviews</nav>
      <main>
        <article>
          <h1>Field Notes From A Long Interview</h1>
          <p>On October 12, 2025, the reporting team met in Sacramento to reconstruct a series of manufacturing delays that had quietly disrupted three supply contracts. The first notes came from warehouse staff, who described missed delivery windows, mislabeled pallets, and a review process that had been shortened to meet quarter-end targets.</p>
          <p>Over the next week, the editor compared those interviews against shipping manifests, maintenance records, and an internal memo distributed on September 30. The memo named two line supervisors, referenced a defective sealing machine, and estimated that 14 percent of outbound inventory required manual rework before it could leave the facility.</p>
          <p>What made the story harder to untangle was the gap between the official timeline and the lived one. Executives framed the disruption as a brief equipment problem, but operators described repeated stoppages, improvised workarounds, and overtime shifts that stretched into early morning handoffs. Several interview subjects independently mentioned the same maintenance ticket number and the same Friday inspection that never happened.</p>
          <p>By the time the final transcript was assembled, the language was concrete rather than theatrical. There were names, dates, counts, and conflicting recollections. There was also uncertainty: some records were missing, one witness contradicted another, and the team had to verify whether a third-party carrier had rejected part of the shipment or whether the goods had never been staged for pickup at all.</p>
          <p>The finished article kept those ambiguities visible. Instead of flattening the sequence into a single tidy narrative, it showed where the evidence aligned, where it diverged, and why the remaining gaps mattered for the workers, the customers, and the company's own compliance record.</p>
        </article>
      </main>
      <aside>Related stories and newsletter promos that should not dominate extraction.</aside>
      <footer>Copyright ScriptLens sample article page.</footer>
    </body>
  </html>`;
}

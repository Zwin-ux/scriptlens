const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { test, expect } = require("@playwright/test");

test.describe("ScriptLens YouTube content defaults", () => {
  test("prefers the page language track over the first foreign manual caption", () => {
    const content = loadContentModule();
    const track = content.pickDefaultCaptionTrack(
      [
        {
          baseUrl: "https://example.com/ar",
          languageCode: "ar",
          kind: "manual",
          label: "Arabic captions"
        },
        {
          baseUrl: "https://example.com/en",
          languageCode: "en",
          kind: "manual",
          label: "English captions"
        }
      ],
      "en-US"
    );

    expect(track?.baseUrl).toBe("https://example.com/en");
  });

  test("falls back to English auto captions before an unrelated manual track", () => {
    const content = loadContentModule();
    const track = content.pickDefaultCaptionTrack(
      [
        {
          baseUrl: "https://example.com/zh",
          languageCode: "zh",
          kind: "manual",
          label: "Chinese captions"
        },
        {
          baseUrl: "https://example.com/en-asr",
          languageCode: "en",
          kind: "asr",
          label: "English auto captions"
        }
      ],
      "en"
    );

    expect(track?.baseUrl).toBe("https://example.com/en-asr");
  });
});

function loadContentModule() {
  const sourcePath = path.join(__dirname, "..", "content.js");
  const code = fs.readFileSync(sourcePath, "utf8");
  const context = {
    console,
    chrome: {
      runtime: {
        onMessage: {
          addListener() {}
        }
      }
    },
    location: {
      href: "https://www.youtube.com/watch?v=test"
    },
    globalThis: {}
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(code, context, { filename: sourcePath });
  return context.globalThis.ScriptLensContent;
}

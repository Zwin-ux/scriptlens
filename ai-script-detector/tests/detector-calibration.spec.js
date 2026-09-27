const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { test, expect } = require("@playwright/test");
const {
  AI_SAMPLES,
  HUMAN_SAMPLES,
  HELD_OUT_AI_SAMPLES,
  HELD_OUT_HUMAN_SAMPLES,
  toCaptionLines
} = require("./detector-corpus");

const ROOT_DIR = path.resolve(__dirname, "..");
const DETECTOR_FILES = [
  "utils/text.js",
  "utils/stats.js",
  "detector/patterns.js",
  "detector/heuristics.js",
  "detector/scoring.js",
  "detector/analyze.js",
  "detector/detect.js"
];

// The three shapes transcript text actually reaches the detector in.
const RENDERINGS = {
  prose: (text) => text,
  "caption lines": (text) => toCaptionLines(text),
  "unpunctuated auto-captions": (text) => toCaptionLines(text, { stripPunctuation: true })
};

const ALL_HUMAN_SAMPLES = HUMAN_SAMPLES.concat(HELD_OUT_HUMAN_SAMPLES);

test.describe("ScriptLens detector calibration", () => {
  const detector = loadDetector();

  for (const [renderingName, render] of Object.entries(RENDERINGS)) {
    test(`keeps human transcripts out of AI verdicts (${renderingName})`, () => {
      for (const sample of ALL_HUMAN_SAMPLES) {
        const report = score(detector, render(sample.text));
        expect(report.score, `${sample.id} scored ${report.score}`).toBeLessThan(30);
      }
    });

    test(`scores every assistant-style script above every human transcript (${renderingName})`, () => {
      const aiScores = AI_SAMPLES.map((sample) => score(detector, render(sample.text)).score);
      const humanScores = ALL_HUMAN_SAMPLES.map(
        (sample) => score(detector, render(sample.text)).score
      );

      expect(Math.min(...aiScores)).toBeGreaterThan(Math.max(...humanScores) + 20);
      expect(mean(aiScores)).toBeGreaterThanOrEqual(55);
    });

    test(`separates held-out samples it was not tuned on (${renderingName})`, () => {
      const aiScores = HELD_OUT_AI_SAMPLES.map((sample) => score(detector, render(sample.text)).score);
      const humanScores = HELD_OUT_HUMAN_SAMPLES.map(
        (sample) => score(detector, render(sample.text)).score
      );

      expect(mean(aiScores)).toBeGreaterThan(mean(humanScores) + 15);
    });
  }

  test("scores caption-line transcripts the same as the equivalent prose", () => {
    for (const sample of AI_SAMPLES.concat(HUMAN_SAMPLES)) {
      const prose = score(detector, sample.text);
      const captions = score(detector, toCaptionLines(sample.text));
      expect(Math.abs(prose.score - captions.score), sample.id).toBeLessThanOrEqual(3);
      expect(captions.metadata.segmentation).toBe("caption-reflowed");
    }
  });

  test("scores unpunctuated auto-captions instead of rejecting them", () => {
    const text = toCaptionLines(AI_SAMPLES[0].text, { stripPunctuation: true });
    const result = detector.detect.runDetection(text, { sensitivity: "medium" });

    expect(result.ok).toBeTruthy();
    expect(result.legacyReport.metadata.segmentation).toBe("caption-lines");
    expect(result.legacyReport.categoryScores.uniformity).toBe(0);
    expect(result.legacyReport.categoryScores.burstiness).toBe(0);
    expect(result.detection.detectorConfidence).not.toBe("high");
  });

  test("names assistant phrasing and spontaneous speech in the reasons", () => {
    const aiReport = score(detector, AI_SAMPLES[0].text);
    const humanReport = score(detector, HUMAN_SAMPLES[1].text);

    expect(aiReport.topReasons.join(" ")).toMatch(/AI-assistant writing/);
    expect(humanReport.topReasons.join(" ")).toMatch(/Unscripted speech markers/);
  });
});

function score(detector, text) {
  const result = detector.analyze.runAnalysis(text, { sensitivity: "medium" });
  expect(result.ok, result.error).toBeTruthy();
  return result.report;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function loadDetector() {
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  DETECTOR_FILES.forEach((relativePath) => {
    const absolutePath = path.join(ROOT_DIR, relativePath);
    vm.runInContext(fs.readFileSync(absolutePath, "utf8"), sandbox, { filename: absolutePath });
  });

  return sandbox.AIScriptDetector;
}

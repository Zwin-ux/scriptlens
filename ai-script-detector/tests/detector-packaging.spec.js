const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { test, expect } = require("@playwright/test");

const ROOT_DIR = path.resolve(__dirname, "..");
const DETECTOR_FILES = [
  "utils/text.js",
  "utils/stats.js",
  "detector/patterns.js",
  "detector/heuristics.js",
  "detector/scoring.js",
  "detector/analyze.js"
];

test.describe("ScriptLens detector heuristics", () => {
  test("raises recap-style YouTube packaging above the low-score floor", () => {
    const detector = loadDetector();
    const recapText = [
      "She Blows an Ancient Whistle and Now She Must PASS Her DEATH to Someone or DIE",
      "An ancient whistle curses a group of friends, causing death to chase them one by one to kill them with their future demise while they try to find a way to stop it.",
      "Watch the full recap to see how they survive."
    ].join("\n\n");

    const result = detector.analyze.runAnalysis(recapText, {
      sensitivity: "medium",
      source: "recap"
    });

    expect(result.ok).toBeTruthy();
    expect(result.report.score).toBeGreaterThanOrEqual(35);
    expect(result.report.categoryScores.title_packaging).toBeGreaterThanOrEqual(70);
  });

  test("keeps a concrete human note below the recap sample", () => {
    const detector = loadDetector();
    const humanText = [
      "On Tuesday I met Sarah Chen at the downtown branch library after the 6:30 budgeting workshop.",
      "She showed me the spreadsheet she uses for her bakery payroll, including line items for flour, card fees, and weekend staffing.",
      "We compared it with my own numbers from January and found that my delivery costs had risen 14 percent since 2024."
    ].join(" ");

    const result = detector.analyze.runAnalysis(humanText, {
      sensitivity: "medium",
      source: "human"
    });

    expect(result.ok).toBeTruthy();
    expect(result.report.score).toBeLessThan(30);
    expect(result.report.categoryScores.title_packaging).toBe(0);
  });
});

function loadDetector() {
  const sandbox = {
    console,
    globalThis: {}
  };

  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  DETECTOR_FILES.forEach((relativePath) => {
    const absolutePath = path.join(ROOT_DIR, relativePath);
    const source = fs.readFileSync(absolutePath, "utf8");
    vm.runInContext(source, sandbox, { filename: absolutePath });
  });

  return sandbox.AIScriptDetector;
}

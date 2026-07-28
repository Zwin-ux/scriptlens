import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildReleaseReadinessMarkdown,
  evaluateReleaseReadiness,
  fetchBackendMetadata,
  loadJsonIfExists,
  resolveBackendOrigin
} from "./release-readiness-lib.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");

const DEFAULTS = {
  mode: "canary",
  defuddleReport: path.join(ROOT_DIR, "release", "defuddle-video-report.json"),
  stagedCanaryReport: path.join(ROOT_DIR, "release", "staged-canary-report.json"),
  stagedQaReport: path.join(ROOT_DIR, "release", "staged-qa-report.json"),
  reportJson: path.join(ROOT_DIR, "release", "release-readiness-report.json"),
  reportMarkdown: path.join(ROOT_DIR, "release", "release-readiness-report.md")
};

const args = parseArgs(process.argv.slice(2));

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const defuddleReport = loadJsonIfExists(args.defuddleReport || DEFAULTS.defuddleReport);
  const stagedCanaryReport = loadJsonIfExists(
    args.stagedCanaryReport || DEFAULTS.stagedCanaryReport
  );
  const stagedQaReport = loadJsonIfExists(args.stagedQaReport || DEFAULTS.stagedQaReport);

  const backendOrigin =
    resolveBackendOrigin(args.backendOrigin) ||
    resolveBackendOrigin(stagedQaReport?.backendOrigin) ||
    resolveBackendOrigin(stagedCanaryReport?.backendOrigin) ||
    "";
  const backendMetadata =
    (backendOrigin ? await fetchBackendMetadata(backendOrigin) : null) ||
    stagedQaReport?.backendMetadata ||
    stagedCanaryReport?.backendMetadata ||
    defuddleReport?.backendMetadata ||
    null;

  const report = evaluateReleaseReadiness({
    mode: args.mode || DEFAULTS.mode,
    backendOrigin,
    backendMetadata,
    defuddleReport,
    stagedCanaryReport,
    stagedQaReport
  });

  fs.writeFileSync(
    args.reportJson || DEFAULTS.reportJson,
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8"
  );
  fs.writeFileSync(
    args.reportMarkdown || DEFAULTS.reportMarkdown,
    `${buildReleaseReadinessMarkdown(report)}\n`,
    "utf8"
  );

  console.log(`Release readiness report written to ${args.reportMarkdown || DEFAULTS.reportMarkdown}`);
  console.log(
    `Mode: ${report.mode} | Overall: ${report.ok ? "PASS" : "FAIL"} | Health score: ${report.healthScore}/100`
  );
  report.checks.forEach((check) => {
    console.log(`- ${check.status.toUpperCase()} ${check.label}: ${check.summary}`);
  });

  if (!report.ok) {
    process.exitCode = 1;
  }
}

function parseArgs(argv) {
  const options = {
    mode: DEFAULTS.mode,
    defuddleReport: DEFAULTS.defuddleReport,
    stagedCanaryReport: DEFAULTS.stagedCanaryReport,
    stagedQaReport: DEFAULTS.stagedQaReport,
    reportJson: DEFAULTS.reportJson,
    reportMarkdown: DEFAULTS.reportMarkdown,
    backendOrigin: ""
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--mode") {
      options.mode = argv[index + 1] || DEFAULTS.mode;
      index += 1;
      continue;
    }
    if (value === "--defuddle-report") {
      options.defuddleReport = argv[index + 1] || options.defuddleReport;
      index += 1;
      continue;
    }
    if (value === "--staged-canary-report") {
      options.stagedCanaryReport = argv[index + 1] || options.stagedCanaryReport;
      index += 1;
      continue;
    }
    if (value === "--staged-qa-report") {
      options.stagedQaReport = argv[index + 1] || options.stagedQaReport;
      index += 1;
      continue;
    }
    if (value === "--backend-origin") {
      options.backendOrigin = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (value === "--report-json") {
      options.reportJson = argv[index + 1] || options.reportJson;
      index += 1;
      continue;
    }
    if (value === "--report-markdown") {
      options.reportMarkdown = argv[index + 1] || options.reportMarkdown;
      index += 1;
      continue;
    }
    if (value === "--help" || value === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${value}`);
  }

  return options;
}

function printHelp() {
  console.log("ScriptLens release readiness");
  console.log("");
  console.log("Options:");
  console.log("  --mode <canary|public>        Readiness threshold set");
  console.log("  --defuddle-report <path>      Defuddle QA report JSON");
  console.log("  --staged-canary-report <path> Staged canary report JSON");
  console.log("  --staged-qa-report <path>     Full staged QA report JSON");
  console.log("  --backend-origin <origin>     Backend origin for live /version metadata");
  console.log("  --report-json <path>          Output JSON path");
  console.log("  --report-markdown <path>      Output Markdown path");
}

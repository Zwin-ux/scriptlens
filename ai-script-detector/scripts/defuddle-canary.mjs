import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ROOT_DIR, buildExtension, packageExtension } from "./release-lib.mjs";

const DEFAULT_TESTS = [
  "tests/popup.render.spec.js",
  "tests/service-worker.inline.spec.js",
  "tests/youtube.smoke.spec.js"
];

const command = String(process.argv[2] || "help").trim().toLowerCase();
const passthroughArgs = process.argv.slice(3);

switch (command) {
  case "build":
    await runBuild();
    break;
  case "package":
    await runPackage();
    break;
  case "test":
    await runTests(passthroughArgs);
    break;
  default:
    printUsage();
    process.exit(command === "help" ? 0 : 1);
}

async function runBuild() {
  const build = await withDefuddleEnv(() => buildExtension(ROOT_DIR));
  console.log(`Built Defuddle canary extension at ${build.stagingDir}`);
}

async function runPackage() {
  const artifact = await withDefuddleEnv(() => packageExtension(ROOT_DIR));
  console.log(`Packaged Defuddle canary zip at ${artifact.zipPath}`);
}

async function runTests(extraArgs) {
  const build = await withDefuddleEnv(() => buildExtension(ROOT_DIR));
  const args =
    Array.isArray(extraArgs) && extraArgs.length
      ? extraArgs.slice()
      : DEFAULT_TESTS.concat(["--reporter=line"]);
  await spawnChecked(resolveNpxCommand(), ["playwright", "test", ...args], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      SCRIPTLENS_ENABLE_DEFUDDLE_EXPERIMENT: "true",
      SCRIPTLENS_EXTENSION_PATH: build.stagingDir
    }
  });
}

async function withDefuddleEnv(callback) {
  const previousValue = process.env.SCRIPTLENS_ENABLE_DEFUDDLE_EXPERIMENT;
  process.env.SCRIPTLENS_ENABLE_DEFUDDLE_EXPERIMENT = "true";
  try {
    return await callback();
  } finally {
    if (previousValue === undefined) {
      delete process.env.SCRIPTLENS_ENABLE_DEFUDDLE_EXPERIMENT;
    } else {
      process.env.SCRIPTLENS_ENABLE_DEFUDDLE_EXPERIMENT = previousValue;
    }
  }
}

function resolveNpxCommand() {
  return "npx";
}

function spawnChecked(commandName, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(commandName, args, {
      stdio: "inherit",
      shell: process.platform === "win32",
      ...options
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          signal
            ? `Command terminated by signal ${signal}`
            : `Command exited with code ${code || 1}`
        )
      );
    });
  });
}

function printUsage() {
  const scriptPath = path.relative(process.cwd(), fileURLToPath(import.meta.url));
  console.log(`Usage: node ${scriptPath} <build|package|test> [playwright args...]`);
}

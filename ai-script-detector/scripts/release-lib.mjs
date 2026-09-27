import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ROOT_DIR = path.resolve(__dirname, "..");
export const RUNTIME_PATHS = [
  "manifest.json",
  "runtime-config.js",
  "content.js",
  "service-worker.js",
  "youtube-main.js",
  "youtube-overlay.js",
  "popup.html",
  "popup.css",
  "popup.js",
  "sidepanel.html",
  "sidepanel.css",
  "sidepanel.js",
  "icons",
  "shared",
  "surface",
  "transcript",
  "detector",
  "utils",
  "vendor"
];

export function loadManifest(rootDir = ROOT_DIR) {
  const manifestPath = path.join(rootDir, "manifest.json");
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

export function resolveReleasePaths(rootDir = ROOT_DIR, options = {}) {
  const distRoot = process.env.SCRIPTLENS_DIST_ROOT
    ? path.resolve(process.env.SCRIPTLENS_DIST_ROOT)
    : path.join(rootDir, "dist");

  return {
    rootDir,
    distRoot,
    stagingDir: options.stagingDir
      ? path.resolve(options.stagingDir)
      : path.join(distRoot, "chrome-unpacked"),
    packageDir: options.packageDir
      ? path.resolve(options.packageDir)
      : path.join(distRoot, "packages")
  };
}

export function buildExtension(rootDir = ROOT_DIR, options = {}) {
  const { stagingDir } = resolveReleasePaths(rootDir, options);
  const runtimeConfig = resolveBuildRuntimeConfig(options.environment || process.env);
  const manifest = loadManifest(rootDir);

  resetDirectory(stagingDir);

  for (const relativePath of RUNTIME_PATHS) {
    const sourcePath = path.join(rootDir, relativePath);
    const destinationPath = path.join(stagingDir, relativePath);

    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Missing runtime asset: ${relativePath}`);
    }

    fs.cpSync(sourcePath, destinationPath, {
      recursive: true,
      force: true
    });
  }

  writeRuntimeConfig(path.join(stagingDir, "runtime-config.js"), runtimeConfig);
  writeManifest(
    path.join(stagingDir, "manifest.json"),
    buildReleaseManifest(manifest, runtimeConfig)
  );

  return {
    manifest: buildReleaseManifest(manifest, runtimeConfig),
    stagingDir,
    runtimePaths: RUNTIME_PATHS.slice(),
    runtimeConfig
  };
}

export async function packageExtension(rootDir = ROOT_DIR, options = {}) {
  const releasePaths = resolveReleasePaths(rootDir, options);
  const useTemporaryStage = !options.stagingDir;
  const packageStagingDir = useTemporaryStage
    ? path.join(
        releasePaths.distRoot,
        `.package-stage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      )
    : releasePaths.stagingDir;
  const build = buildExtension(rootDir, {
    ...options,
    stagingDir: packageStagingDir
  });
  const { packageDir } = releasePaths;
  const packageName = `scriptlens-youtube-v${build.manifest.version}.zip`;
  const zipPath = path.join(packageDir, packageName);

  fs.mkdirSync(packageDir, { recursive: true });
  fs.rmSync(zipPath, { force: true });

  try {
    await createZipArchive(build.stagingDir, zipPath);

    return {
      manifest: build.manifest,
      stagingDir: build.stagingDir,
      zipPath
    };
  } finally {
    if (useTemporaryStage) {
      fs.rmSync(packageStagingDir, {
        recursive: true,
        force: true
      });
    }
  }
}

export function syncPublicDocsMirror(
  sourceDir = path.join(ROOT_DIR, "docs"),
  targetDir = path.resolve(ROOT_DIR, "..", "docs")
) {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Missing public docs source: ${sourceDir}`);
  }

  fs.rmSync(targetDir, {
    recursive: true,
    force: true
  });
  fs.mkdirSync(path.dirname(targetDir), {
    recursive: true
  });
  fs.cpSync(sourceDir, targetDir, {
    recursive: true,
    force: true
  });

  return {
    sourceDir,
    targetDir
  };
}

function resetDirectory(targetDir) {
  fs.rmSync(targetDir, {
    recursive: true,
    force: true
  });
  fs.mkdirSync(targetDir, { recursive: true });
}

async function createZipArchive(sourceDir, zipPath) {
  if (process.platform === "win32") {
    const command = [
      "Compress-Archive",
      "-Path",
      `'${toPowerShellPath(path.join(sourceDir, "*"))}'`,
      "-DestinationPath",
      `'${toPowerShellPath(zipPath)}'`,
      "-Force"
    ].join(" ");

    await execFileAsync("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      command
    ]);
    return;
  }

  await execFileAsync("zip", ["-qr", zipPath, "."], {
    cwd: sourceDir
  });
}

function toPowerShellPath(value) {
  return String(value).replace(/'/g, "''");
}

export function resolveBuildRuntimeConfig(environment = process.env) {
  const publicSiteOrigin = normalizeOrigin(
    String(environment.SCRIPTLENS_PUBLIC_SITE_ORIGIN || environment.SCRIPTLENS_PUBLIC_SITE_URL || "").trim()
  );
  const enableDefuddleExperiment = readBooleanEnv(
    environment.SCRIPTLENS_ENABLE_DEFUDDLE_EXPERIMENT
  );

  return {
    publicSiteOrigin,
    enableDefuddleExperiment
  };
}

function buildReleaseManifest(manifest, runtimeConfig) {
  const nextManifest = JSON.parse(JSON.stringify(manifest));

  if (runtimeConfig.publicSiteOrigin) {
    nextManifest.homepage_url = `${runtimeConfig.publicSiteOrigin.replace(/\/$/, "")}/`;
  } else {
    delete nextManifest.homepage_url;
  }

  return nextManifest;
}

function writeRuntimeConfig(targetPath, runtimeConfig) {
  const contents = `(function (root) {
  root.ScriptLensRuntimeConfig = {
    publicSiteOrigin: ${JSON.stringify(runtimeConfig.publicSiteOrigin || "")},
    enableDefuddleExperiment: ${runtimeConfig.enableDefuddleExperiment ? "true" : "false"}
  };
})(globalThis);
`;
  fs.writeFileSync(targetPath, contents, "utf8");
}

function writeManifest(targetPath, manifest) {
  fs.writeFileSync(targetPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function normalizeOrigin(value) {
  if (!value) {
    return "";
  }
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}`;
  } catch (error) {
    return "";
  }
}

function readBooleanEnv(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

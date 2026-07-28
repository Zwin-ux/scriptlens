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
  const environment = createBuildEnvironment(options.environment || process.env, options);
  const runtimeConfig = resolveBuildRuntimeConfig(environment);
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

export function createBuildEnvironment(environment = process.env, options = {}) {
  const backendMode = normalizePackagingBackendMode(options.backendMode);
  if (backendMode !== "local-only") {
    return environment;
  }

  const nextEnvironment = {
    ...environment
  };

  delete nextEnvironment.SCRIPTLENS_BACKEND_ENDPOINT;
  delete nextEnvironment.SCRIPTLENS_BACKEND_ORIGIN;

  return nextEnvironment;
}

function resetDirectory(targetDir) {
  fs.rmSync(targetDir, {
    recursive: true,
    force: true
  });
  fs.mkdirSync(targetDir, { recursive: true });
}

export function normalizePackagingBackendMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized || normalized === "ambient") {
    return "ambient";
  }
  if (normalized === "local-only") {
    return "local-only";
  }
  throw new Error(
    `Unsupported packaging backend mode "${value}". Expected "ambient" or "local-only".`
  );
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
  const endpoint = String(environment.SCRIPTLENS_BACKEND_ENDPOINT || "").trim();
  const backendOrigin = normalizeOrigin(
    String(environment.SCRIPTLENS_BACKEND_ORIGIN || endpoint || "").trim()
  );
  const publicSiteOrigin = normalizeOrigin(
    String(environment.SCRIPTLENS_PUBLIC_SITE_ORIGIN || environment.SCRIPTLENS_PUBLIC_SITE_URL || "").trim()
  );
  const backendPermissionMode =
    String(environment.SCRIPTLENS_BACKEND_PERMISSION_MODE || "required").trim().toLowerCase() ===
    "optional"
      ? "optional"
      : "required";
  const enableDefuddleExperiment = readBooleanEnv(
    environment.SCRIPTLENS_ENABLE_DEFUDDLE_EXPERIMENT
  );

  return {
    defaultBackendTranscriptEndpoint: endpoint,
    allowBackendTranscriptFallbackByDefault: Boolean(endpoint),
    backendOrigin,
    backendPermissionMode,
    publicSiteOrigin,
    enableDefuddleExperiment
  };
}

function buildReleaseManifest(manifest, runtimeConfig) {
  const nextManifest = JSON.parse(JSON.stringify(manifest));
  const backendPattern = runtimeConfig.backendOrigin
    ? `${runtimeConfig.backendOrigin.replace(/\/$/, "")}/*`
    : "";

  if (backendPattern) {
    if (runtimeConfig.backendPermissionMode === "optional") {
      nextManifest.optional_host_permissions = dedupeList([
        ...(nextManifest.optional_host_permissions || []),
        backendPattern
      ]);
    } else {
      nextManifest.host_permissions = dedupeList([
        ...(nextManifest.host_permissions || []),
        backendPattern
      ]);
    }
  }

  if (!nextManifest.optional_host_permissions?.length) {
    delete nextManifest.optional_host_permissions;
  }

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
    defaultBackendTranscriptEndpoint: ${JSON.stringify(
      runtimeConfig.defaultBackendTranscriptEndpoint || ""
    )},
    allowBackendTranscriptFallbackByDefault: ${runtimeConfig.allowBackendTranscriptFallbackByDefault ? "true" : "false"},
    backendPermissionMode: ${JSON.stringify(runtimeConfig.backendPermissionMode)},
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

function dedupeList(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).filter(Boolean)));
}

function readBooleanEnv(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

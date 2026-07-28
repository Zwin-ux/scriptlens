const fs = require("fs");
const os = require("os");
const path = require("path");
const { test, expect } = require("@playwright/test");

const rootDir = path.join(__dirname, "..");

test.describe("ScriptLens release packaging", () => {
  test("manifest stays trimmed to the YouTube-only release permissions", async () => {
    const { loadManifest } = await import(path.join(rootDir, "scripts", "release-lib.mjs"));
    const manifest = loadManifest(rootDir);

    expect(manifest.permissions).toEqual(["sidePanel", "storage"]);
    expect(manifest.host_permissions).toEqual(["https://www.youtube.com/*"]);
    expect(manifest.description).toContain("YouTube");
    expect(manifest.description).not.toContain("page");
  });

  test("buildExtension stages only runtime assets", async () => {
    const distRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scriptlens-build-"));
    process.env.SCRIPTLENS_DIST_ROOT = distRoot;

    try {
      const { buildExtension } = await import(path.join(rootDir, "scripts", "release-lib.mjs"));
      const build = buildExtension(rootDir);
      const entries = listRelativeFiles(build.stagingDir);

      expect(entries).toContain("manifest.json");
      expect(entries).toContain("runtime-config.js");
      expect(entries).toContain("shared/contracts.js");
      expect(entries).toContain("surface/shared.js");
      expect(entries).toContain("icons/icon128.png");
      expect(entries).toContain("vendor/defuddle.js");
      expect(entries).toContain("utils/defuddle-extractor.js");
      expect(entries.some((entry) => entry.startsWith("tests/"))).toBeFalsy();
      expect(entries.some((entry) => entry.startsWith("backend/"))).toBeFalsy();
      expect(entries.some((entry) => entry.startsWith("node_modules/"))).toBeFalsy();
      expect(entries).not.toContain("playwright.config.js");

      const stagedRuntimeConfig = fs.readFileSync(
        path.join(build.stagingDir, "runtime-config.js"),
        "utf8"
      );
      expect(stagedRuntimeConfig).toContain('defaultBackendTranscriptEndpoint: ""');
      expect(stagedRuntimeConfig).toContain("allowBackendTranscriptFallbackByDefault: false");
      expect(stagedRuntimeConfig).toContain("enableDefuddleExperiment: false");
    } finally {
      delete process.env.SCRIPTLENS_DIST_ROOT;
      fs.rmSync(distRoot, { recursive: true, force: true });
    }
  });

  test("buildExtension injects configured backend origin into staged manifest and runtime config", async () => {
    const distRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scriptlens-configured-build-"));
    process.env.SCRIPTLENS_DIST_ROOT = distRoot;
    process.env.SCRIPTLENS_BACKEND_ENDPOINT =
      "https://recovery.scriptlens.test/transcript/resolve";
    process.env.SCRIPTLENS_BACKEND_ORIGIN = "https://recovery.scriptlens.test";
    process.env.SCRIPTLENS_BACKEND_PERMISSION_MODE = "optional";
    process.env.SCRIPTLENS_PUBLIC_SITE_ORIGIN = "https://scriptlens.example";
    process.env.SCRIPTLENS_ENABLE_DEFUDDLE_EXPERIMENT = "true";

    try {
      const { buildExtension } = await import(path.join(rootDir, "scripts", "release-lib.mjs"));
      const build = buildExtension(rootDir);
      const stagedManifest = JSON.parse(
        fs.readFileSync(path.join(build.stagingDir, "manifest.json"), "utf8")
      );
      const stagedRuntimeConfig = fs.readFileSync(
        path.join(build.stagingDir, "runtime-config.js"),
        "utf8"
      );

      expect(build.runtimeConfig.defaultBackendTranscriptEndpoint).toBe(
        "https://recovery.scriptlens.test/transcript/resolve"
      );
      expect(build.runtimeConfig.enableDefuddleExperiment).toBeTruthy();
      expect(stagedManifest.host_permissions).toEqual(["https://www.youtube.com/*"]);
      expect(stagedManifest.optional_host_permissions).toEqual([
        "https://recovery.scriptlens.test/*"
      ]);
      expect(stagedManifest.homepage_url).toBe("https://scriptlens.example/");
      expect(stagedRuntimeConfig).toContain(
        'defaultBackendTranscriptEndpoint: "https://recovery.scriptlens.test/transcript/resolve"'
      );
      expect(stagedRuntimeConfig).toContain("allowBackendTranscriptFallbackByDefault: true");
      expect(stagedRuntimeConfig).toContain('backendPermissionMode: "optional"');
      expect(stagedRuntimeConfig).toContain('publicSiteOrigin: "https://scriptlens.example"');
      expect(stagedRuntimeConfig).toContain("enableDefuddleExperiment: true");
    } finally {
      delete process.env.SCRIPTLENS_DIST_ROOT;
      delete process.env.SCRIPTLENS_BACKEND_ENDPOINT;
      delete process.env.SCRIPTLENS_BACKEND_ORIGIN;
      delete process.env.SCRIPTLENS_BACKEND_PERMISSION_MODE;
      delete process.env.SCRIPTLENS_PUBLIC_SITE_ORIGIN;
      delete process.env.SCRIPTLENS_ENABLE_DEFUDDLE_EXPERIMENT;
      fs.rmSync(distRoot, { recursive: true, force: true });
    }
  });

  test("packageExtension creates a non-empty Chrome Web Store zip", async () => {
    const distRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scriptlens-package-"));
    process.env.SCRIPTLENS_DIST_ROOT = distRoot;

    try {
      const { packageExtension } = await import(path.join(rootDir, "scripts", "release-lib.mjs"));
      const artifact = await packageExtension(rootDir);

      expect(fs.existsSync(artifact.zipPath)).toBeTruthy();
      expect(fs.statSync(artifact.zipPath).size).toBeGreaterThan(0);
    } finally {
      delete process.env.SCRIPTLENS_DIST_ROOT;
      fs.rmSync(distRoot, { recursive: true, force: true });
    }
  });

  test("packageExtension does not replace the active unpacked staging directory", async () => {
    const distRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scriptlens-package-existing-"));
    process.env.SCRIPTLENS_DIST_ROOT = distRoot;

    try {
      const { buildExtension, packageExtension } = await import(
        path.join(rootDir, "scripts", "release-lib.mjs")
      );
      const build = buildExtension(rootDir);
      const markerPath = path.join(build.stagingDir, ".keep-me");
      fs.writeFileSync(markerPath, "persist", "utf8");

      const artifact = await packageExtension(rootDir);

      expect(fs.existsSync(artifact.zipPath)).toBeTruthy();
      expect(fs.existsSync(markerPath)).toBeTruthy();
      expect(listRelativeFiles(build.stagingDir)).toContain(".keep-me");
    } finally {
      delete process.env.SCRIPTLENS_DIST_ROOT;
      fs.rmSync(distRoot, { recursive: true, force: true });
    }
  });
});

function listRelativeFiles(targetDir, prefix = "") {
  return fs.readdirSync(targetDir, { withFileTypes: true }).flatMap((entry) => {
    const nextRelative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const nextPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      return listRelativeFiles(nextPath, nextRelative);
    }
    return [nextRelative];
  });
}

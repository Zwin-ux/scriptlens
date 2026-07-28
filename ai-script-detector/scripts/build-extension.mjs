import { buildExtension } from "./release-lib.mjs";

const build = buildExtension();

console.log(`Built unpacked extension at ${build.stagingDir}`);

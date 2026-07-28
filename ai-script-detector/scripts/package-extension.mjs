import { packageExtension } from "./release-lib.mjs";

const artifact = await packageExtension();

console.log(`Packaged Chrome Web Store zip at ${artifact.zipPath}`);

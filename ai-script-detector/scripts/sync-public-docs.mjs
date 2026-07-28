import path from "node:path";
import { ROOT_DIR, syncPublicDocsMirror } from "./release-lib.mjs";

const result = syncPublicDocsMirror();

console.log(
  `Synced public docs from ${path.relative(process.cwd(), result.sourceDir)} to ${path.relative(
    process.cwd(),
    result.targetDir
  )}`
);

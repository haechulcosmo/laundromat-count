import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\//, "");
const output = join(root, "firebase-public");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const name of ["index.html", "history.html", "cloud.js"]) {
  await cp(join(root, name), join(output, name));
}

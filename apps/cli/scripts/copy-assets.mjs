import { cp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDirectory = join(packageDirectory, "src", "prompts");
const destinationDirectory = join(packageDirectory, "dist", "prompts");

await cp(sourceDirectory, destinationDirectory, { force: true, recursive: true });

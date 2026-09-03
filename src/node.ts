// The Node entry point: everything the root exports, plus reading a plan from disk. The root
// export stays free of node:fs so a browser bundle can import the engine directly.

import { readFileSync } from "node:fs";
import type { Plan } from "./model.js";
import { parsePlanText } from "./parse.js";

export * from "./index.js";

/** Read a plan from a .json, .yaml or .yml file. */
export function loadPlanFile(path: string): Plan {
  return parsePlanText(readFileSync(path, "utf8"), /\.ya?ml$/i.test(path) ? "yaml" : "json");
}

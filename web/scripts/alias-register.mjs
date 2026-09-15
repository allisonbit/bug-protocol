/** Registers the `@/` resolver for plain-Node runs. See alias-hooks.mjs. */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
register("./alias-hooks.mjs", pathToFileURL(process.cwd() + "/scripts/"));

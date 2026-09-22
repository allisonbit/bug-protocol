#!/usr/bin/env node
import { main } from "../src/index.mjs";

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    // A crash is a bug in the CLI, not a verdict about the deployment, and the
    // two must not look the same on a terminal. Say which one this is.
    console.error("swamp: unexpected failure (this is a CLI bug): " + (err && err.message ? err.message : String(err)));
    process.exitCode = 2;
  });

#!/usr/bin/env node
// Experimental celld Python builder protocol: ENTRY OUTPUT_DIRECTORY DURABLE_CLASSES_JSON.
import { resolve } from 'node:path';
if (process.argv.length !== 5) throw new Error('Usage: celld-python-build ENTRY OUTPUT_DIRECTORY DURABLE_CLASSES_JSON');
process.env.PYTHON_PROJECT_FILE = resolve(process.argv[2]);
process.env.PYTHON_BUILD_OUTPUT_DIR = resolve(process.argv[3]);
process.env.PYTHON_DURABLE_CLASSES = process.argv[4];
delete process.env.PYTHON_FIXTURE_ENTRY;
delete process.env.PYTHON_FIXTURE_OUTPUT;
try {
  await import('./fetch-sdk.mjs');
  await import('./build.mjs');
} catch (error) {
  // Uncaught errors in Emscripten print the entire minified loader line before
  // the useful Python traceback. Keep the actual diagnostic visible to dev.
  console.error(error?.message || String(error));
  process.exitCode = 1;
}

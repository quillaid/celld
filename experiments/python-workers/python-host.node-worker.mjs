// Worker thread for python-host.node.test.mjs: the adapter runs here, and the
// main thread acts as the cross-thread signal writer.
import { parentPort, workerData } from 'node:worker_threads';
import { loadPyodide } from 'pyodide';
import { bundledAdapter } from './python-host-helpers.mjs';

const { createPythonHost } = await bundledAdapter();
const signals = new Int32Array(workerData.sab);
const host = createPythonHost({ loadRuntime: () => loadPyodide({ indexURL: workerData.indexURL }), signals });
await host.ready();
await host.execute('spin', 'marker = "kept"\ncount = 0');
// The execution id is allocated synchronously; report it before spinning.
const next = host.runningExecution('spin') || 2;
parentPort.postMessage({ phase: 'spinning', execution: next });
const interrupted = await host.execute('spin', 'while True:\n    count += 1');
const after = await host.execute('spin', '(marker, count > 0)');
parentPort.postMessage({ phase: 'done', interrupted, after, capabilities: host.capabilities() });

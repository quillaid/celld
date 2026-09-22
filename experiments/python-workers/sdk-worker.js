import { createPythonWorker } from './sdk-runtime.js';
import source from './sdk-worker.py';
export default createPythonWorker({ moduleName: 'worker', files: { 'worker.py': source } });

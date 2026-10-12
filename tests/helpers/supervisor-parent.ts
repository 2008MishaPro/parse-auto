import { access, readFile } from 'node:fs/promises';
import { runSupervisor } from '../../src/supervision/supervisor.ts';

const path = process.argv[2];
if (!path) throw new Error('Supervisor fixture options are required');
const { crashFile, ...options } = JSON.parse(await readFile(path, 'utf8'));
if (typeof crashFile === 'string') {
  const timer = setInterval(() => {
    void access(crashFile).then(() => process.exit(29), error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }, 20);
  timer.unref();
}
await runSupervisor(options);

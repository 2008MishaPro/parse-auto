/** IPC is private to the local supervisor; ordinary CLI runs use the same signals. */
export function installChildLifecycle(controller: AbortController, memorySampleMs = 10_000): () => void {
  const stop = (): void => controller.abort();
  const sample = (): void => {
    if (!process.connected || typeof process.send !== 'function') return;
    const memory = process.memoryUsage();
    process.send({ type: 'carradar_memory', rss: memory.rss, heapUsed: memory.heapUsed }, error => {
      if (error) stop();
    });
  };
  const message = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    if ('type' in value && value.type === 'carradar_stop') stop();
    if ('type' in value && value.type === 'carradar_sample') sample();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('message', message);
  process.on('disconnect', stop);
  // A parent can exit before this module installs the listener.
  // Node may remove process.send if EOF arrives before the module loads.
  if ((process.env.CARRADAR_SUPERVISED === '1' || typeof process.send === 'function') && !process.connected) stop();
  const timer = setInterval(sample, memorySampleMs);
  timer.unref();
  sample();
  return () => {
    clearInterval(timer);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    process.off('message', message);
    process.off('disconnect', stop);
  };
}

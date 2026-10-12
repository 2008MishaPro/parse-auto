import { AdapterRegistry } from '../core/registry.ts';
import { AvitoAdapter } from './avito/adapter.ts';

/** Monitor and supervisor preflight share the same source registration. */
export function createAdapterRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(new AvitoAdapter());
  return registry;
}

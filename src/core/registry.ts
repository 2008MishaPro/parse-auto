import type { SourceAdapter } from './contracts.ts';

export class AdapterRegistry {
  private adapters = new Map<string, SourceAdapter>();

  register(adapter: SourceAdapter): this {
    if (!adapter.id || this.adapters.has(adapter.id)) {
      throw new Error(`Адаптер уже зарегистрирован или имеет пустой id: ${adapter.id}`);
    }
    this.adapters.set(adapter.id, adapter);
    return this;
  }

  get(id: string): SourceAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Адаптер не зарегистрирован: ${id}`);
    return adapter;
  }
}

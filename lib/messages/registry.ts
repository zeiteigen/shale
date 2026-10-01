/** Immutable dispatch snapshots keep registration changes out of active delivery. */
export class RegistrationRegistry<T extends { priority: number }> {
  private readonly channels = new Map<string, T[]>();

  add(channel: string, entry: T): () => void {
    const entries = [...this.snapshot(channel), entry];
    entries.sort((a, b) => b.priority - a.priority);
    this.channels.set(channel, entries);
    return () => {
      const remaining = this.snapshot(channel).filter((item) => item !== entry);
      if (remaining.length) this.channels.set(channel, remaining);
      else this.channels.delete(channel);
    };
  }

  snapshot(channel: string): readonly T[] {
    return this.channels.get(channel) ?? [];
  }

  has(channel: string): boolean {
    return this.snapshot(channel).length > 0;
  }

  keys(): IterableIterator<string> {
    return this.channels.keys();
  }

  clear(): void {
    this.channels.clear();
  }
}

export interface TtlCache<K, V> {
  get(key: K, load: () => Promise<V>): Promise<V>;
}

export function ttlCache<K, V>(options: {
  ttlMs: number;
  maxEntries: number;
  now?: () => number;
}): TtlCache<K, V> {
  const now = options.now ?? Date.now;
  const entries = new Map<K, { value: Promise<V>; expiresAt: number }>();
  return {
    get(key, load) {
      const hit = entries.get(key);
      entries.delete(key);
      if (hit && hit.expiresAt > now()) {
        entries.set(key, hit);
        return hit.value;
      }
      const entry = { value: load(), expiresAt: now() + options.ttlMs };
      entries.set(key, entry);
      if (entries.size > options.maxEntries) entries.delete(entries.keys().next().value as K);
      entry.value.catch(() => {
        if (entries.get(key) === entry) entries.delete(key);
      });
      return entry.value;
    },
  };
}

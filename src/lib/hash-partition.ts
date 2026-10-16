export function fnv1a32Shard(value: string, shards = 256): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % shards).toString(16).padStart(2, "0");
}

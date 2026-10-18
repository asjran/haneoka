import type { NativeIntroObjectRecord, NativeIntroObjectResolver } from "./NativeIntroLoader";

/** One exact current-source record set. Serialized-file identity is part of every key. */
export class NativeIntroSourceIndex implements NativeIntroObjectResolver {
  private readonly records = new Map<string, NativeIntroObjectRecord>();
  constructor(records: ReadonlyArray<NativeIntroObjectRecord>, private readonly sourceSignal: AbortSignal,
    private readonly externalPreloads: ReadonlyMap<string, ReadonlySet<string>> = new Map()) {
    sourceSignal.throwIfAborted();
    for (const record of records) {
      if (!record.serializedFile || !/^-?\d+$/u.test(record.pathId) || record.pathId === "0")
        throw new Error("Native intro record must retain its original serialized-file and decimal64 identity");
      const key = `${record.serializedFile}:${record.pathId}`;
      if (this.records.has(key)) throw new Error(`Duplicate native intro source object: ${key}`);
      this.records.set(key, record);
    }
  }
  referenceKey(pointer: unknown, owner: NativeIntroObjectRecord): string {
    this.sourceSignal.throwIfAborted();
    if (!pointer || typeof pointer !== "object" || Array.isArray(pointer)) throw new Error("Native intro PPtr missing");
    const value = pointer as Record<string, unknown>;
    if (!Number.isInteger(value.m_FileID) || (value.m_FileID as number) < 0 ||
        typeof value.m_PathID !== "string" || !/^-?\d+$/u.test(value.m_PathID) || value.m_PathID === "0")
      throw new Error("Native intro requires a non-null normalized decimal64 PPtr");
    if (value.m_FileID === 0) return `${owner.serializedFile}:${value.m_PathID}`;
    const reference = value.reference;
    if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
      const candidates = this.externalPreloads.get(`${owner.serializedFile}:${value.m_PathID}`);
      if (!candidates || candidates.size !== 1) throw new Error("Native intro external serialized-file identity missing or ambiguous");
      return `${candidates.values().next().value}:${value.m_PathID}`;
    }
    const external = reference as Record<string, unknown>;
    if (external.status !== "resolved" || external.pathId !== value.m_PathID || typeof external.serializedFile !== "string")
      throw new Error("Native intro external PPtr differs from its actual source reference");
    return `${external.serializedFile}:${value.m_PathID}`;
  }
  resolve(pointer: unknown, owner: NativeIntroObjectRecord): NativeIntroObjectRecord {
    const key = this.referenceKey(pointer, owner), value = this.records.get(key);
    if (!value) throw new Error(`Original native intro source object unavailable: ${key}`);
    return value;
  }
  async animation(pointer: unknown, owner: NativeIntroObjectRecord, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    const value = this.resolve(pointer, owner);
    if (value.type !== "AnimationClip") throw new Error("Native intro animation PPtr resolved to another object class");
    this.sourceSignal.throwIfAborted();
    return value;
  }
  dispose(): void { this.records.clear(); }
}

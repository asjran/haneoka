import type { TeamBuilderData } from "./data";
import { createEmptyInventory, validateInventory, type InventoryIssue, type InventoryV1 } from "./inventory";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export class InventoryValidationError extends Error {
  constructor(readonly issues: InventoryIssue[]) {
    super("Invalid team inventory");
  }
}
export class CloudInventoryRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Inventory request failed: ${code}`);
  }
}
export interface CloudInventory {
  ownerId: string;
  server: string;
  revision: number;
  inventory: InventoryV1 | null;
}
export interface InventoryStoreState {
  phase:
    | "auth-loading"
    | "loading"
    | "anonymous"
    | "saved"
    | "pending"
    | "saving"
    | "offline"
    | "conflict"
    | "merge-required"
    | "release-mismatch"
    | "error";
  inventory: InventoryV1 | null;
  revision: number;
  ownerId: string | null;
  dirty: boolean;
  remote?: CloudInventory;
  error?: string;
}
const MAX_JSON_BYTES = 1024 * 1024;
const key = (data: TeamBuilderData, owner: string | null) =>
  `haneoka:team-inventory:v1:${owner === null ? "anonymous" : `account:${encodeURIComponent(owner)}`}:${encodeURIComponent(data.identity.server)}:${encodeURIComponent(data.identity.releaseId)}`;
function checked(value: unknown, data: TeamBuilderData, allowDifferentRelease = false): InventoryV1 {
  const result = validateInventory(value, data, { allowDifferentRelease });
  if (!result.valid) throw new InventoryValidationError(result.issues);
  return structuredClone(value as InventoryV1);
}
export function importInventory(text: string, data: TeamBuilderData): InventoryV1 {
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) throw new Error("Inventory JSON is too large");
  return checked(JSON.parse(text), data);
}
export function exportInventory(inventory: InventoryV1): string {
  return JSON.stringify(inventory, null, 2);
}
export function readLocalInventory(
  storage: StorageLike,
  data: TeamBuilderData,
  owner: string | null = null,
): InventoryV1 | null {
  const text = storage.getItem(key(data, owner));
  if (!text) return null;
  return checked(JSON.parse(text).inventory, data);
}
export function writeLocalInventory(
  storage: StorageLike,
  data: TeamBuilderData,
  inventory: InventoryV1,
  owner: string | null = null,
  baseRevision = 0,
): void {
  storage.setItem(key(data, owner), JSON.stringify({ inventory: checked(inventory, data), baseRevision }));
}
export function mergeInventories(cloud: InventoryV1, draft: InventoryV1, mapPriority?: "cloud" | "draft"): InventoryV1 {
  if (cloud.server !== draft.server || cloud.releaseId !== draft.releaseId)
    throw new Error("Cannot merge different inventory identities");
  const merged = structuredClone(cloud);
  const sameEntry = (a: object, b: object) =>
    JSON.stringify(Object.entries(a).sort(([a], [b]) => a.localeCompare(b))) ===
    JSON.stringify(Object.entries(b).sort(([a], [b]) => a.localeCompare(b)));
  const entries = new Map<
    string,
    { kind: "members" | "snapshots"; entry: InventoryV1["members"][number] | InventoryV1["snapshots"][number] }
  >(
    [
      ...cloud.members.map((entry) => ({ kind: "members" as const, entry })),
      ...cloud.snapshots.map((entry) => ({ kind: "snapshots" as const, entry })),
    ].map((value) => [value.entry.instanceId, value]),
  );
  for (const kind of ["members", "snapshots"] as const)
    for (const row of draft[kind]) {
      const previous = entries.get(row.instanceId)?.entry;
      if (previous) {
        if (sameEntry(previous, row)) continue;
        if (!mapPriority) throw new Error(`Inventory merge needs a choice: instance.${row.instanceId}`);
        if (mapPriority === "cloud") continue;
      }
      entries.set(row.instanceId, { kind, entry: { ...row } });
    }
  merged.members = [...entries.values()]
    .filter((value) => value.kind === "members")
    .map((value) => value.entry as InventoryV1["members"][number]);
  merged.snapshots = [...entries.values()]
    .filter((value) => value.kind === "snapshots")
    .map((value) => value.entry as InventoryV1["snapshots"][number]);
  for (const field of ["bandItems", "bandRanks", "characterRanks"] as const)
    for (const [id, level] of Object.entries(draft[field])) {
      if (id in merged[field] && merged[field][id] !== level && !mapPriority)
        throw new Error(`Inventory merge needs a choice: ${field}.${id}`);
      if (!(id in merged[field]) || mapPriority === "draft") merged[field][id] = level;
    }
  return merged;
}

/** Same-origin cookie session, JSON mutation and no-store follow the existing account client. */
export function createCloudInventoryClient(server: string, fetcher: typeof fetch = fetch) {
  const url = `/api/v1/team-inventory/${encodeURIComponent(server)}`;
  async function request(init: RequestInit, ownerId: string): Promise<{ conflict: boolean; value: CloudInventory }> {
    const response = await fetcher(url, {
      credentials: "same-origin",
      cache: "no-store",
      ...init,
      headers: {
        accept: "application/json",
        "x-haneoka-expected-user": ownerId,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });
    const payload = (await response.json()) as CloudInventory & { error?: { code?: string } };
    if (
      (!response.ok && response.status !== 409) ||
      (response.status === 409 && payload.error?.code !== "revision_conflict")
    )
      throw new CloudInventoryRequestError(response.status, payload.error?.code || String(response.status));
    const value = payload;
    if (
      value.ownerId !== ownerId ||
      value.server !== server ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 0
    )
      throw new Error("Inventory response identity mismatch");
    if (
      value.inventory &&
      (value.inventory.server !== server || value.inventory.schema !== "haneoka-team-inventory-v1")
    )
      throw new Error("Inventory document identity mismatch");
    return { conflict: response.status === 409, value };
  }
  return {
    read: (owner: string, signal?: AbortSignal) => request({ signal }, owner),
    save: (owner: string, inventory: InventoryV1, expectedRevision: number, signal?: AbortSignal) => {
      const body = JSON.stringify({ expectedRevision, inventory });
      if (new TextEncoder().encode(body).byteLength > MAX_JSON_BYTES)
        return Promise.reject(new Error("Inventory request exceeds 1 MiB"));
      return request({ method: "PUT", body, signal }, owner);
    },
  };
}

export class InventoryStore {
  state: InventoryStoreState = { phase: "auth-loading", inventory: null, revision: 0, ownerId: null, dirty: false };
  private generation = 0;
  private edits = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private pending?: Promise<void>;
  private anonymousDraft?: InventoryV1;
  private readonly client;
  constructor(
    readonly data: TeamBuilderData,
    private readonly options: {
      storage: StorageLike;
      fetcher?: typeof fetch;
      onChange?: (state: InventoryStoreState) => void;
      debounceMs?: number;
    },
  ) {
    this.client = createCloudInventoryClient(data.identity.server, options.fetcher);
  }
  private emit(): void {
    this.options.onChange?.(structuredClone(this.state));
  }
  async initialize(sessionReady: Promise<{ user?: { id?: string } } | null>): Promise<void> {
    const generation = this.generation;
    let session: { user?: { id?: string } } | null;
    try {
      session = await sessionReady;
    } catch (error) {
      if (generation === this.generation) {
        this.state.phase = "error";
        this.state.error = String(error);
        this.emit();
      }
      return;
    }
    if (generation !== this.generation) return;
    await this.setAccount(session?.user?.id || null);
  }
  async setAccount(ownerId: string | null): Promise<void> {
    this.controller?.abort();
    clearTimeout(this.timer);
    this.pending = undefined;
    this.anonymousDraft = undefined;
    const generation = ++this.generation;
    this.edits++;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.state = { phase: ownerId ? "loading" : "anonymous", inventory: null, ownerId, revision: 0, dirty: false };
    this.emit();
    try {
      if (!ownerId) {
        this.state.inventory =
          readLocalInventory(this.options.storage, this.data) || createEmptyInventory(this.data.identity);
        this.emit();
        return;
      }
      const { value } = await this.client.read(ownerId, signal);
      if (generation !== this.generation) return;
      this.state.revision = value.revision;
      if (value.inventory && value.inventory.releaseId !== this.data.identity.releaseId) {
        this.state = { ...this.state, phase: "release-mismatch", inventory: value.inventory, remote: value };
        this.emit();
        return;
      }
      this.state.inventory = value.inventory
        ? checked(value.inventory, this.data)
        : createEmptyInventory(this.data.identity);
      const localText = this.options.storage.getItem(key(this.data, ownerId));
      if (localText) {
        const local = JSON.parse(localText);
        const draft = checked(local.inventory, this.data);
        if (JSON.stringify(draft) !== JSON.stringify(this.state.inventory)) {
          this.state = { ...this.state, inventory: draft, dirty: true, phase: "conflict", remote: value };
          this.emit();
          return;
        }
      }
      this.anonymousDraft = readLocalInventory(this.options.storage, this.data) || undefined;
      const draft = this.anonymousDraft;
      const hasDraft =
        draft &&
        (draft.members.length ||
          draft.snapshots.length ||
          Object.keys(draft.bandItems).length ||
          Object.keys(draft.characterRanks).length ||
          Object.keys(draft.bandRanks).length);
      this.state.phase = hasDraft ? "merge-required" : "saved";
      this.emit();
    } catch (error) {
      if (generation !== this.generation || signal.aborted) return;
      if (ownerId && error instanceof TypeError) {
        try {
          const text = this.options.storage.getItem(key(this.data, ownerId));
          if (text) {
            const local = JSON.parse(text);
            this.state.inventory = checked(local.inventory, this.data);
            this.state.revision = Number.isSafeInteger(local.baseRevision) ? local.baseRevision : 0;
            this.state.dirty = true;
          }
          this.state.phase = "offline";
        } catch (localError) {
          this.state.phase = "error";
          this.state.error = String(localError);
        }
      } else this.state.phase = "error";
      this.state.error = String(error);
      this.emit();
    }
  }
  edit(inventory: InventoryV1): void {
    if (
      !this.state.inventory ||
      ["loading", "auth-loading", "release-mismatch", "merge-required"].includes(this.state.phase)
    )
      throw new Error("Inventory is not ready for editing");
    this.state.inventory = checked(inventory, this.data);
    this.edits++;
    this.state.dirty = true;
    this.persist();
    if (!this.state.ownerId) {
      this.state.phase = "anonymous";
      this.emit();
      return;
    }
    if (this.state.phase !== "conflict") {
      this.state.phase = "pending";
      this.schedule();
    }
    this.emit();
  }
  private persist(): void {
    if (this.state.inventory)
      writeLocalInventory(
        this.options.storage,
        this.data,
        this.state.inventory,
        this.state.ownerId,
        this.state.revision,
      );
  }
  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.saveNow();
    }, this.options.debounceMs ?? 600);
  }
  saveNow(): Promise<void> {
    clearTimeout(this.timer);
    if (this.pending) return this.pending;
    if (!this.state.ownerId || !this.state.inventory || !this.state.dirty || this.state.phase === "conflict")
      return Promise.resolve();
    const owner = this.state.ownerId,
      generation = this.generation,
      version = this.edits;
    const inventory = structuredClone(this.state.inventory),
      revision = this.state.revision;
    const signal = this.controller!.signal;
    this.state.phase = "saving";
    this.state.error = undefined;
    this.emit();
    const operation = (async () => {
      try {
        const result = await this.client.save(owner, inventory, revision, signal);
        if (generation !== this.generation) return;
        if (result.conflict) {
          this.state.phase = "conflict";
          this.state.remote = result.value;
          this.emit();
          return;
        }
        this.state.revision = result.value.revision;
        this.state.dirty = version !== this.edits;
        this.state.phase = this.state.dirty ? "pending" : "saved";
        this.persist();
        this.emit();
      } catch (error) {
        if (generation !== this.generation || signal.aborted) return;
        this.state.phase = error instanceof CloudInventoryRequestError ? "error" : "offline";
        this.state.error = String(error);
        this.persist();
        this.emit();
      } finally {
        if (generation === this.generation) {
          this.pending = undefined;
          if (this.state.dirty && this.state.phase === "pending") this.schedule();
        }
      }
    })();
    this.pending = operation;
    return operation;
  }
  resolveAnonymous(strategy: "cloud" | "draft" | "merge", mapPriority?: "cloud" | "draft"): void {
    if (this.state.phase !== "merge-required" || !this.anonymousDraft || !this.state.inventory)
      throw new Error("No anonymous merge is pending");
    const cloud = this.state.inventory;
    const next =
      strategy === "cloud"
        ? cloud
        : strategy === "draft"
          ? this.anonymousDraft
          : mergeInventories(cloud, this.anonymousDraft, mapPriority);
    this.state.phase = "saved";
    this.anonymousDraft = undefined;
    if (strategy !== "cloud") this.edit(next);
    this.options.storage.removeItem(key(this.data, null));
    this.emit();
  }
  resolveConflict(strategy: "remote" | "local" | "merge", mapPriority?: "cloud" | "draft"): void {
    const remote = this.state.remote;
    if (this.state.phase !== "conflict" || !remote || !this.state.inventory)
      throw new Error("No cloud conflict is pending");
    const cloud = remote.inventory ? checked(remote.inventory, this.data) : createEmptyInventory(this.data.identity);
    const next =
      strategy === "remote"
        ? cloud
        : strategy === "local"
          ? this.state.inventory
          : mergeInventories(cloud, this.state.inventory, mapPriority);
    this.state = {
      ...this.state,
      inventory: next,
      revision: remote.revision,
      phase: "saved",
      dirty: false,
      remote: undefined,
    };
    if (strategy !== "remote") this.edit(next);
    else this.persist();
    this.emit();
  }
  resolveRelease(inventory: InventoryV1): void {
    if (this.state.phase !== "release-mismatch") throw new Error("No release change is pending");
    const next = checked(inventory, this.data);
    this.state.phase = "saved";
    this.state.inventory = next;
    this.edit(next);
  }
  dispose(): void {
    this.generation++;
    this.controller?.abort();
    clearTimeout(this.timer);
    this.pending = undefined;
    this.anonymousDraft = undefined;
    this.state = { phase: "auth-loading", inventory: null, ownerId: null, revision: 0, dirty: false };
  }
}

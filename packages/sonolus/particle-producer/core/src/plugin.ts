import { ChartSession, type SessionOptions } from "./core/session.js";
import type { ChartDocument } from "./core/types.js";

export interface CassiopeiaService<T> {
  readonly id: string;
  readonly apiVersion: 1;
  readonly valueType?: T;
}
export function defineCassiopeiaService<T>(id: string): CassiopeiaService<T> {
  if (!/^[a-z][a-z0-9.-]+\.v[1-9][0-9]*$/u.test(id)) throw new TypeError(`Invalid service ID: ${id}`);
  return Object.freeze({ id, apiVersion: 1 });
}
export interface CassiopeiaPluginManifest {
  readonly id: string;
  readonly version: string;
  readonly apiVersion: 1;
  readonly requires?: readonly string[];
  readonly provides: readonly string[];
}
export interface CassiopeiaPluginContext {
  provide<T>(key: CassiopeiaService<T>, value: T): void;
  require<T>(key: CassiopeiaService<T>): T;
  /** Release subscriptions and host resources when installation rolls back or the runtime is disposed. */
  defer(cleanup: () => void): void;
}
export interface CassiopeiaPlugin {
  readonly manifest: CassiopeiaPluginManifest;
  setup(context: CassiopeiaPluginContext): void;
}
export function defineCassiopeiaPlugin(plugin: CassiopeiaPlugin): CassiopeiaPlugin {
  return Object.freeze({
    ...plugin,
    manifest: Object.freeze({
      ...plugin.manifest,
      requires: Object.freeze([...(plugin.manifest.requires ?? [])]),
      provides: Object.freeze([...plugin.manifest.provides]),
    }),
  });
}

/** One explicitly composed runtime; no process-global services or automatic plugin discovery. */
export class CassiopeiaRuntime {
  private readonly services = new Map<string, unknown>();
  private readonly cleanups: Array<() => void> = [];
  private readonly installed = new Set<string>();
  private disposed = false;

  constructor(plugins: readonly CassiopeiaPlugin[]) {
    const pending = new Map<string, CassiopeiaPlugin>();
    for (const plugin of plugins) {
      if (plugin.manifest.apiVersion !== 1) throw new Error(`Unsupported plugin API: ${plugin.manifest.id}`);
      if (pending.has(plugin.manifest.id)) throw new Error(`Duplicate plugin: ${plugin.manifest.id}`);
      pending.set(plugin.manifest.id, plugin);
    }
    try {
      while (pending.size) {
        const next = [...pending.values()].find((p) =>
          (p.manifest.requires ?? []).every((id) => this.installed.has(id)),
        );
        if (!next) throw new Error(`Missing or cyclic plugin dependencies: ${[...pending.keys()].join(", ")}`);
        const declared = new Set(next.manifest.provides);
        const provided = new Set<string>();
        next.setup({
          require: (key) => this.require(key),
          provide: (key, value) => {
            if (key.apiVersion !== 1 || !declared.has(key.id)) throw new Error(`Undeclared service: ${key.id}`);
            if (this.services.has(key.id)) throw new Error(`Duplicate service: ${key.id}`);
            this.services.set(key.id, value);
            provided.add(key.id);
          },
          defer: (cleanup) => {
            this.cleanups.push(cleanup);
          },
        });
        for (const id of declared) if (!provided.has(id)) throw new Error(`Plugin did not provide service: ${id}`);
        this.installed.add(next.manifest.id);
        pending.delete(next.manifest.id);
      }
    } catch (error) {
      try {
        this.dispose();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Plugin setup failed");
      }
      throw error;
    }
  }

  require<T>(key: CassiopeiaService<T>): T {
    if (this.disposed) throw new Error("Cassiopeia runtime is disposed");
    if (key.apiVersion !== 1 || !this.services.has(key.id)) throw new Error(`Missing service: ${key.id}`);
    return this.services.get(key.id) as T;
  }

  has<T>(key: CassiopeiaService<T>): boolean {
    return !this.disposed && this.services.has(key.id);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const failures: unknown[] = [];
    for (const cleanup of this.cleanups.reverse())
      try {
        cleanup();
      } catch (error) {
        failures.push(error);
      }
    this.cleanups.length = 0;
    this.services.clear();
    this.installed.clear();
    if (failures.length) throw new AggregateError(failures, "Plugin cleanup failed");
  }
}

export type CassiopeiaSessionPort = Pick<ChartSession, keyof ChartSession> & { dispose?(): void; getWatchHistory?(): readonly import("./core/types.js").JudgementEvent[] };

export const CASSIOPEIA_SESSION = defineCassiopeiaService<{
  create(chart: ChartDocument, options?: SessionOptions): CassiopeiaSessionPort;
}>("cassiopeia.session.v1");

export function createKernelPlugin(
  options: {
    createSession?: (chart: ChartDocument, options?: SessionOptions) => CassiopeiaSessionPort;
  } = {},
): CassiopeiaPlugin {
  return defineCassiopeiaPlugin({
    manifest: { id: "cassiopeia.kernel", version: "0.1.0", apiVersion: 1, provides: [CASSIOPEIA_SESSION.id] },
    setup(context) {
      context.provide(CASSIOPEIA_SESSION, {
        create: options.createSession ?? ((chart, sessionOptions) => new ChartSession(chart, sessionOptions)),
      });
    },
  });
}

import type { NativeIntroObjectRecord } from "./NativeIntroLoader";
import type { NativeIntroSignal } from "./NativeIntroTimeline";

export interface NativeIntroVoiceSignal {
  signalKey: string;
  targetKey: string;
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native intro SignalReceiver data");
  return value as Record<string, unknown>;
};

/** Parse the authored voice route as data; persistent method names never become executable calls. */
export function readNativeIntroVoiceSignals(
  receiver: NativeIntroObjectRecord,
  resolveKey: (pointer: unknown, owner: NativeIntroObjectRecord) => string,
): ReadonlyArray<NativeIntroVoiceSignal> {
  const events = object(receiver.data.m_Events);
  const signals = events.m_Signals, handlers = events.m_Events;
  if (!Array.isArray(signals) || !Array.isArray(handlers) || signals.length !== handlers.length)
    throw new Error("Native intro SignalReceiver signal/event identity mismatch");
  const result: NativeIntroVoiceSignal[] = [];
  for (let index = 0; index < signals.length; index++) {
    const handler = object(handlers[index]);
    const persistent = object(handler.m_PersistentCalls);
    if (!Array.isArray(persistent.m_Calls)) throw new Error("Native intro SignalReceiver persistent calls missing");
    for (const raw of persistent.m_Calls) {
      const call = object(raw);
      if (call.m_CallState === 0) continue;
      // Only the actual parameter-free intro voice notification is supported.
      // Unrecognized original methods remain data and are rejected at load time.
      if (call.m_MethodName !== "NotifyPlayVoice" || call.m_Mode !== 1 ||
          call.m_TargetAssemblyTypeName !== "Live.LivePlayableTimeline, SiriusAsset")
        throw new Error("Unsupported native intro signal action");
      result.push({ signalKey: resolveKey(signals[index], receiver), targetKey: resolveKey(call.m_Target, receiver) });
    }
  }
  return result;
}

/** Pre-music marker traversal. A bypassed intro emits no past voice or sound events. */
export class NativeIntroSignalPlayer {
  private previousSeconds = -1;
  private readonly emitted = new Set<number>();
  private disposed = false;
  constructor(
    private readonly signals: ReadonlyArray<NativeIntroSignal>,
    private readonly routes: ReadonlyArray<NativeIntroVoiceSignal>,
    private readonly signalKey: (signal: NativeIntroSignal) => string,
    private readonly notifyVoice: (targetKey: string) => void,
  ) {}

  advance(introSeconds: number): void {
    if (this.disposed) return;
    if (!Number.isFinite(introSeconds) || introSeconds < 0) throw new Error("Invalid native intro signal playback time");
    if (introSeconds < this.previousSeconds) throw new Error("Native intro signal playback requires an explicit restart");
    for (let index = 0; index < this.signals.length; index++) {
      const signal = this.signals[index]!;
      if (signal.time > introSeconds || (signal.emitOnce && this.emitted.has(index))) continue;
      const crossed = signal.time > this.previousSeconds;
      const retroactive = this.previousSeconds < 0 && signal.retroactive;
      if (!crossed && !retroactive) continue;
      const key = this.signalKey(signal);
      for (const route of this.routes) if (route.signalKey === key) this.notifyVoice(route.targetKey);
      this.emitted.add(index);
    }
    this.previousSeconds = introSeconds;
  }

  restart(): void { this.previousSeconds = -1; this.emitted.clear(); }
  bypass(introSeconds: number): void {
    if (!Number.isFinite(introSeconds) || introSeconds < 0) throw new Error("Invalid native intro signal bypass time");
    this.previousSeconds = introSeconds;
    for (let index = 0; index < this.signals.length; index++) if (this.signals[index]!.time <= introSeconds) this.emitted.add(index);
  }
  dispose(): void { this.disposed = true; this.emitted.clear(); }
}

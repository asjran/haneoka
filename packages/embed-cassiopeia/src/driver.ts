import type { ChartPlaybackOptions } from "./types.js";
export interface PlayerDriver {
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): void;
  setOptions(options: ChartPlaybackOptions): Promise<void>;
  dispose(): void;
}
export type PlayerEvent = (name: string, ...args: unknown[]) => void;

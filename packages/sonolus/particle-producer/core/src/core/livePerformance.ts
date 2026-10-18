export enum ScreenMode {
  RichLive2D = 0,
  SimpleLive2D = 1,
  MV = 2,
  Lightweight = 3,
}

export const DEFAULT_SCREEN_MODE = ScreenMode.Lightweight;

export enum CameraProfile {
  Low = 0,
  Mid = 1,
  High = 2,
}

export interface ScreenResources {
  live2dStage: boolean;
  mainMusicVideo: boolean;
  bandVideoJockey: boolean;
}

export interface PerformanceTransportSnapshot {
  timeMicros: bigint;
  rateMillionths: number;
  playing: boolean;
  revision: bigint;
}

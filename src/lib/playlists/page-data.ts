import type { SerializedSongLibrary } from "./library";
export interface PlaylistPageData {
  schema: "haneoka-playlist-page-v1";
  variants: Record<string, SerializedSongLibrary>;
  gamePlaylists: Record<string, unknown>[];
  gameError: string;
}

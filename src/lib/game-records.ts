export type GameRecordsRegion = "jp" | "tw" | "en" | "kr";

export interface GameProfileCardDto {
  name: string | null;
  slot: number | null;
  thumbnailUrls: string[];
}

export interface SongRankingCardDto {
  slot: number;
  memberCardId: number | null;
  memberExp: number | null;
  memberAwakeCount: number | null;
  memberRank: number | null;
  supportCardId: number | null;
  supportExp: number | null;
  supportRank: number | null;
}

export interface SongRankingRowDto {
  rank: number;
  tied: boolean;
  playerId: string | null;
  profileId: string | null;
  name: string;
  rankExp: number | null;
  favoriteMemberCardId: number | null;
  score: number | null;
  deckId: number | null;
  deckName: string | null;
  totalPower: number | null;
  profileCard: GameProfileCardDto | null;
  cards: SongRankingCardDto[];
}

export interface SongRankingDto {
  region: GameRecordsRegion;
  musicId: number;
  fetchedAtMs: number | null;
  serverTimeMs: number | null;
  stale: boolean;
  rows: SongRankingRowDto[];
}

export interface PlayerProfileDto {
  region: GameRecordsRegion;
  profileId: string;
  fetchedAtMs: number | null;
  serverTimeMs: number | null;
  stale: boolean;
  profile: {
    name: string | null;
    level: number | null;
    rankExp: number | null;
    totalFavorite: number | null;
    favoriteMemberCard: {
      cardId: number | null;
      awakeCount: number | null;
      cardRank: number | null;
      liveSkillLevel: number | null;
      performanceSkillLevel: number | null;
    } | null;
    profileCard: GameProfileCardDto | null;
    lastUpdatedAtMs: number | null;
  };
}

export interface GameRecordsErrorDto {
  error: {
    kind: string;
    retryAfter: number | null;
  };
}

export interface RankingCardArtwork {
  server: "jp" | "intl";
  name: unknown;
  image: string;
  rarity: number;
  avatar: string;
  attributeIcon: string;
  rarityIcon: string;
  rankGroup: number;
  levelGroup: number;
}

export interface RankingCardCatalog {
  member: Record<string, RankingCardArtwork>;
  support: Record<string, RankingCardArtwork>;
  playerLevels: Array<{ level: number; exp: number }>;
  memberLimits: Record<string, number>;
  supportLimits: Record<string, number>;
  levels: {
    member: Record<string, Array<{ level: number; exp: number }>>;
    support: Record<string, Array<{ level: number; exp: number }>>;
  };
}

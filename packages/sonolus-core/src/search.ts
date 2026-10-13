import { sonolusDifficultyTitle } from "./projection.js";
import { parseChartQuery } from "./repository.js";
import type { ChartDescriptor, ChartFilterValue, JsonObject } from "./types.js";

const DIFFICULTY_ORDER = ["easy", "normal", "hard", "expert", "special", "master"];

function filterValues(values: readonly ChartFilterValue[]): ChartFilterValue[] {
  return [...new Map(values.map((value) => [value.name, value])).values()];
}

function multiOption(
  query: string,
  name: string,
  values: readonly ChartFilterValue[],
  selected: readonly string[],
): JsonObject {
  const selection = new Set(selected.map((value) => value.toLowerCase()));
  return {
    query,
    name,
    required: false,
    type: "multi",
    def: values.map((value) => selection.has(value.name.toLowerCase())),
    values: values.map(({ name, title }) => ({ name, title })),
  };
}

export function projectChartSearch(
  charts: readonly ChartDescriptor[],
  parameters: URLSearchParams = new URLSearchParams(),
  quickSearchValues?: string,
): JsonObject {
  const query = parseChartQuery(parameters);
  const difficulties = [...new Set(charts.map((chart) => chart.difficulty))].sort(
    (left, right) => DIFFICULTY_ORDER.indexOf(left) - DIFFICULTY_ORDER.indexOf(right),
  );
  const maxRating = charts.reduce((maximum, chart) => Math.max(maximum, Math.ceil(chart.rating)), 1);
  const ratingOption = (key: "minRating" | "maxRating", name: string, fallback: number): JsonObject => ({
    query: key,
    name,
    required: false,
    type: "slider",
    def: query[key] ?? fallback,
    min: 0,
    max: maxRating,
    step: 1,
  });
  const source = new URLSearchParams(quickSearchValues).get("source");
  return {
    type: source === "bestdori" ? "bestdori" : "advanced",
    title: "#ADVANCED",
    icon: "search",
    requireConfirmation: false,
    options: [
      {
        query: "keywords",
        name: "#KEYWORDS",
        required: false,
        type: "text",
        def: query.search ?? "",
        placeholder: "#KEYWORDS_PLACEHOLDER",
        limit: 100,
        shortcuts: [],
      },
      multiOption(
        "artists",
        "#ARTISTS",
        filterValues(charts.flatMap((chart) => chart.artistFilters ?? [])),
        query.artists ?? [],
      ),
      multiOption(
        "category",
        "#CATEGORY",
        filterValues(charts.flatMap((chart) => chart.categories ?? [])),
        query.categories ?? [],
      ),
      multiOption(
        "difficulty",
        "#DIFFICULTY",
        difficulties.map((name) => ({ name, title: sonolusDifficultyTitle(name) })),
        query.difficulties ?? [],
      ),
      ratingOption("minRating", "#RATING_MINIMUM", 0),
      ratingOption("maxRating", "#RATING_MAXIMUM", maxRating),
    ],
  };
}

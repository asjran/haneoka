import source from "./chart-ui-profile.json";

export interface OurNotesChartUiProfile {
  readonly guidelineCounts: readonly number[];
  readonly guidelineCountDefault: number;
}

export const OUR_NOTES_CHART_UI_PROFILE: OurNotesChartUiProfile = Object.freeze({
  guidelineCounts: Object.freeze(source.guidelineCounts),
  guidelineCountDefault: source.guidelineCountDefault,
});

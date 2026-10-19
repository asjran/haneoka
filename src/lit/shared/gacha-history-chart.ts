// L3 — GEB
// Input: 抽卡统计类别、数值序列及当前主题。
// Output: 可访问的 ECharts SVG 图表。
// Pos: [Map](../L2-2.md)；抽卡历史展示与资料边界。
// Effects/Dependencies: 按需加载 ECharts，连接时监听尺寸／主题，断开时释放观察器和图表。
import { LitElement, html, type PropertyValues } from "lit";
import type { EChartsType } from "echarts/core";

export interface GachaChartData {
  label: string;
  categories: string[];
  series: Array<{ name: string; values: number[] }>;
  details?: string[];
  horizontal?: boolean;
  grouped?: boolean;
}
export class GachaHistoryChart extends LitElement {
  static properties = { data: { attribute: false } };
  declare data: GachaChartData;
  private chart?: EChartsType;
  private resize?: ResizeObserver;
  private theme?: MutationObserver;
  private loading = false;
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    this.resize = new ResizeObserver(() => this.chart?.resize());
    this.theme = new MutationObserver(() => this.paint());
    this.theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "style"],
    });
  }
  disconnectedCallback() {
    this.resize?.disconnect();
    this.theme?.disconnect();
    this.chart?.dispose();
    this.chart = undefined;
    super.disconnectedCallback();
  }
  protected updated(_changed: PropertyValues) {
    void this.mount();
  }
  private async mount() {
    if (this.chart) return this.paint();
    if (this.loading) return;
    this.loading = true;
    const [core, charts, components, renderers] = await Promise.all([
      import("echarts/core"),
      import("echarts/charts"),
      import("echarts/components"),
      import("echarts/renderers"),
    ]);
    if (!this.isConnected) {
      this.loading = false;
      return;
    }
    core.use([
      charts.BarChart,
      components.GridComponent,
      components.LegendComponent,
      components.TooltipComponent,
      components.AriaComponent,
      components.DataZoomComponent,
      renderers.SVGRenderer,
    ]);
    const surface = this.querySelector<HTMLElement>(".gacha-history__plot")!;
    this.chart = core.init(surface, undefined, { renderer: "svg" });
    this.resize?.observe(surface);
    this.loading = false;
    this.paint();
  }
  private paint() {
    if (!this.chart || !this.data) return;
    const styles = getComputedStyle(this);
    const color = (key: string) => styles.getPropertyValue(`--md-sys-color-${key}`).trim();
    const horizontal = !!this.data.horizontal;
    const category = {
      type: "category",
      data: this.data.categories,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: color("on-surface-variant"),
        width: horizontal ? 110 : 64,
        overflow: "truncate",
        hideOverlap: true,
      },
    };
    const value = {
      type: "value",
      minInterval: 1,
      axisLabel: { color: color("on-surface-variant") },
      splitLine: { lineStyle: { color: color("outline-variant") } },
    };
    this.chart.setOption(
      {
        animation: !matchMedia("(prefers-reduced-motion: reduce)").matches,
        aria: {
          enabled: true,
          label: {
            description: `${this.data.label}. ${this.data.categories.map((category, index) => `${category}: ${this.data.series.map((series) => `${series.name} ${series.values[index]}`).join(", ")}`).join("; ")}`,
          },
          decal: { show: false },
        },
        color: [color("primary"), color("tertiary"), color("outline"), color("secondary")],
        textStyle: { fontFamily: styles.getPropertyValue("--app-font") },
        legend: { type: "scroll", bottom: 0, textStyle: { color: color("on-surface") } },
        tooltip: {
          trigger: "axis",
          confine: true,
          renderMode: "richText",
          formatter: this.data.details?.length
            ? (items: Array<{ axisValueLabel: string; dataIndex: number; seriesName: string; value: number }>) =>
                [
                  items[0]?.axisValueLabel,
                  ...items.map((item) => `${item.seriesName}  ${item.value}`),
                  this.data.details?.[items[0]?.dataIndex ?? 0],
                ]
                  .filter(Boolean)
                  .join("\n")
            : undefined,
          backgroundColor: color("surface-container-high"),
          borderColor: color("outline-variant"),
          textStyle: { color: color("on-surface") },
        },
        grid: { left: horizontal ? 118 : 8, right: 24, top: 20, bottom: 54, containLabel: !horizontal },
        xAxis: horizontal ? value : category,
        yAxis: horizontal ? category : value,
        dataZoom:
          this.data.categories.length > (horizontal ? 8 : 30)
            ? [
                {
                  type: "slider",
                  ...(horizontal
                    ? { yAxisIndex: 0, right: 0, startValue: 0, endValue: 7 }
                    : {
                        xAxisIndex: 0,
                        bottom: 26,
                        startValue: Math.max(0, this.data.categories.length - 30),
                        endValue: this.data.categories.length - 1,
                      }),
                },
              ]
            : [],
        series: this.data.series.map((series) => ({
          name: series.name,
          type: "bar",
          stack: this.data.grouped ? undefined : "total",
          data: series.values,
          barMaxWidth: 32,
          labelLayout: { hideOverlap: true },
          emphasis: { focus: "series" },
          label: {
            show: true,
            position: this.data.grouped ? "right" : "inside",
            color: this.data.grouped ? color("on-surface") : undefined,
            formatter: (value: { value: number }) => (value.value ? String(value.value) : ""),
          },
        })),
      },
      true,
    );
  }
  render() {
    return html`
      <div class="gacha-history__plot" role="img" aria-label=${this.data?.label ?? ""}></div>
    `;
  }
}
if (!customElements.get("gacha-history-chart")) customElements.define("gacha-history-chart", GachaHistoryChart);

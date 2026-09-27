import { Component, computed, input } from '@angular/core';
import type { EChartsCoreOption } from 'echarts/core';
import { NgxEchartsDirective, provideEchartsCore } from 'ngx-echarts';

/** One line: `[time in ms, value]` points, oldest first. */
export type Series = { name: string; points: [number, number][] };

/**
 * A time-series line chart (ngx-echarts), in the dashboard's colours: its `--chart-*`, text and border tokens,
 * read each time the series change, so it follows the light/dark theme.
 */
@Component({
  selector: 'app-time-series',
  imports: [NgxEchartsDirective],
  providers: [provideEchartsCore({ echarts: () => import('./echarts') })],
  template: `<div echarts [options]="options()" class="h-48"></div>`,
})
export class TimeSeries {
  readonly series = input.required<Series[]>();
  /** Formats a value for the axis and tooltip, e.g. as a percent. */
  readonly format = input<(value: number) => string>(String);
  /** The axis's top, e.g. 1 for a share; else fitted to the data. */
  readonly max = input<number>();

  protected readonly options = computed((): EChartsCoreOption => {
    const css = getComputedStyle(document.documentElement);
    const token = (name: string) => css.getPropertyValue(name).trim() || undefined;
    const text = token('--muted-foreground');
    const line = token('--border');
    const palette = [1, 2, 3, 4, 5].flatMap((i) => token(`--chart-${i}`) ?? []);
    const format = this.format();
    const series = this.series();
    return {
      ...(palette.length && { color: palette }),
      animation: false,
      grid: { left: 56, right: 8, top: series.length > 1 ? 32 : 12, bottom: 24 },
      legend: { show: series.length > 1, textStyle: { color: text } },
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v: unknown) => format(Number(v)),
        backgroundColor: token('--popover'),
        borderColor: line,
        textStyle: { color: token('--popover-foreground') },
      },
      xAxis: { type: 'time', axisLabel: { color: text }, axisLine: { lineStyle: { color: line } } },
      yAxis: { type: 'value', min: 0, max: this.max(), axisLabel: { color: text, formatter: format }, splitLine: { lineStyle: { color: line } } },
      // Colours are the tokens as given (oklch), so nothing derives shades from them.
      series: series.map((s) => ({ type: 'line', name: s.name, data: s.points, showSymbol: false, emphasis: { disabled: true } })),
    };
  });
}

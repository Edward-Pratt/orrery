// Only what the graphs use, loaded lazily with the first chart (`chart.ts`); SVG, which follows CSS colours.
import { LineChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { use } from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';

use([LineChart, GridComponent, LegendComponent, TooltipComponent, SVGRenderer]);

export { init } from 'echarts/core';

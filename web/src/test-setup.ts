// jsdom has no canvas (ECharts measures text with one) and no ResizeObserver (ngx-echarts needs one).
HTMLCanvasElement.prototype.getContext = () => null;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

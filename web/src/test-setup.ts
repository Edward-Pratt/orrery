// jsdom has no canvas (ECharts measures text with one) and no ResizeObserver (ngx-echarts needs one).
HTMLCanvasElement.prototype.getContext = () => null;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
// ...nor matchMedia (the toaster reads the colour scheme; the theme tests stub it themselves).
window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;

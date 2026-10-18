// Feature switches for release builds. Disabled features keep their code;
// enable one by building with its env var, e.g. VITE_ENABLE_WATERMARK=true.
export const FEATURES = {
  watermark: import.meta.env.VITE_ENABLE_WATERMARK === 'true',
};

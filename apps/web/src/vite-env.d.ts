/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** URL of an ingested chart archive (charts.pmtiles). Optional. */
  readonly VITE_CHART_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

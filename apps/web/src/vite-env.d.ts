/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** URL of an ingested chart archive (charts.pmtiles). Optional. */
  readonly VITE_CHART_URL?: string;
  /** Override the OpenStreetMap raster tile endpoint, e.g. your own server. */
  readonly VITE_BASEMAP_TILE_URL?: string;
  /** Override the OpenSeaMap seamark overlay endpoint. */
  readonly VITE_SEAMARK_TILE_URL?: string;
  /** Override the AIS stream endpoint - a relay of your own, or a test double. */
  readonly VITE_AIS_STREAM_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

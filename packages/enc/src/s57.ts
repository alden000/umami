/**
 * S-57 object and attribute vocabulary.
 *
 * Only the acronyms are modelled, not the full IHO Object Catalogue: the
 * catalogue is large, the simulation needs a fraction of it, and the fraction
 * it needs is exactly what an ECDIS draws and what a USV must not run into.
 * Everything else passes through the ingest pipeline as unstyled features
 * rather than being discarded, so adding a class later is a presentation
 * change and not a re-ingest.
 */

/** S-57 object class acronyms this system understands. */
export const S57_OBJECT_CLASSES = {
  // Land and coastline.
  LNDARE: 'Land area',
  COALNE: 'Coastline',
  SLCONS: 'Shoreline construction',
  LNDMRK: 'Landmark',
  BUAARE: 'Built-up area',
  // Depth and seabed.
  DEPARE: 'Depth area',
  DRGARE: 'Dredged area',
  DEPCNT: 'Depth contour',
  SOUNDG: 'Sounding',
  UNSARE: 'Unsurveyed area',
  OBSTRN: 'Obstruction',
  WRECKS: 'Wreck',
  UWTROC: 'Underwater rock',
  // Aids to navigation.
  BOYLAT: 'Lateral buoy',
  BOYCAR: 'Cardinal buoy',
  BOYISD: 'Isolated danger buoy',
  BOYSAW: 'Safe water buoy',
  BOYSPP: 'Special purpose buoy',
  BCNLAT: 'Lateral beacon',
  BCNCAR: 'Cardinal beacon',
  BCNISD: 'Isolated danger beacon',
  BCNSAW: 'Safe water beacon',
  BCNSPP: 'Special purpose beacon',
  LIGHTS: 'Light',
  DAYMAR: 'Daymark',
  // Traffic and regulation.
  TSSLPT: 'Traffic separation scheme lane part',
  TSEZNE: 'Traffic separation zone',
  TSSBND: 'Traffic separation scheme boundary',
  TSELNE: 'Traffic separation line',
  DWRTPT: 'Deep water route part',
  FAIRWY: 'Fairway',
  ACHARE: 'Anchorage area',
  RESARE: 'Restricted area',
  CTNARE: 'Caution area',
  PRCARE: 'Precautionary area',
  MIPARE: 'Military practice area',
  // Infrastructure.
  BRIDGE: 'Bridge',
  CBLOHD: 'Overhead cable',
  PIPSOL: 'Submarine pipeline',
  CBLSUB: 'Submarine cable',
  PILPNT: 'Pile',
  MORFAC: 'Mooring facility',
  PONTON: 'Pontoon',
  HULKES: 'Hulk',
  FLODOC: 'Floating dock',
  // Meta.
  M_COVR: 'Coverage',
  M_NSYS: 'Navigational system of marks',
  M_QUAL: 'Quality of data',
} as const;

export type S57ObjectClass = keyof typeof S57_OBJECT_CLASSES;

export function isKnownObjectClass(acronym: string): acronym is S57ObjectClass {
  return acronym in S57_OBJECT_CLASSES;
}

/**
 * Object classes that constitute a hazard to navigation.
 *
 * Used to build the obstruction layer a USV's route checker consults. Kept as
 * a deliberate, reviewable list rather than inferred from geometry, because
 * "what counts as an obstruction" is a safety decision and should be visible.
 */
export const HAZARD_CLASSES: readonly S57ObjectClass[] = [
  'LNDARE',
  'OBSTRN',
  'WRECKS',
  'UWTROC',
  'PILPNT',
  'PONTON',
  'HULKES',
  'FLODOC',
  'SLCONS',
  'MORFAC',
];

/** S-57 attribute acronyms that affect presentation or navigation. */
export type S57Attribute =
  | 'DRVAL1'
  | 'DRVAL2'
  | 'VALSOU'
  | 'QUASOU'
  | 'WATLEV'
  | 'CATLAM'
  | 'CATCAM'
  | 'CATSPM'
  | 'COLOUR'
  | 'COLPAT'
  | 'LITCHR'
  | 'SIGPER'
  | 'SIGGRP'
  | 'VALNMR'
  | 'SECTR1'
  | 'SECTR2'
  | 'HEIGHT'
  | 'VERCLR'
  | 'ORIENT'
  | 'CATTSS'
  | 'RESTRN'
  | 'OBJNAM'
  | 'NATSUR'
  | 'CATOBS'
  | 'CATWRK'
  | 'BOYSHP'
  | 'BCNSHP'
  | 'TOPSHP'
  | 'SCAMIN'
  | 'SCAMAX';

/** WATLEV, S-57 attribute 187: water level effect. */
export enum WaterLevelEffect {
  PartlySubmergedAtHighWater = 1,
  AlwaysDry = 2,
  AlwaysUnderWater = 3,
  CoversAndUncovers = 4,
  AwashAtLowWater = 5,
  Floating = 7,
}

/** CATLAM, lateral mark category. */
export enum LateralMarkCategory {
  Port = 1,
  Starboard = 2,
  PreferredChannelToStarboard = 3,
  PreferredChannelToPort = 4,
}

/** CATCAM, cardinal mark category. */
export enum CardinalMarkCategory {
  North = 1,
  East = 2,
  South = 3,
  West = 4,
}

/**
 * M_NSYS / buoyage direction: IALA region A or B.
 *
 * Determines whether a port-hand lateral mark is red or green, so it must
 * come from the chart data and never be assumed. Getting it backwards puts a
 * vessel on the wrong side of every channel mark.
 */
export enum BuoyageSystem {
  IalaA = 1,
  IalaB = 2,
  Other = 9,
}

/** Geometry primitive an S-57 feature carries. */
export type S57Primitive = 'point' | 'line' | 'area';

/** A chart feature, normalised for rendering and for spatial queries. */
export interface ChartFeature {
  readonly id: string;
  readonly objectClass: string;
  readonly primitive: S57Primitive;
  /** GeoJSON geometry in WGS84. */
  readonly geometry: GeoJsonGeometry;
  readonly attributes: Readonly<Record<string, string | number | undefined>>;
  /** Smallest scale at which this feature should be drawn (SCAMIN). */
  readonly minScale?: number;
  /** Source cell this feature came from, for provenance and updates. */
  readonly cellId: string;
}

export type GeoJsonGeometry =
  | { readonly type: 'Point'; readonly coordinates: readonly [number, number] }
  | { readonly type: 'LineString'; readonly coordinates: readonly (readonly [number, number])[] }
  | {
      readonly type: 'Polygon';
      readonly coordinates: readonly (readonly (readonly [number, number])[])[];
    }
  | {
      readonly type: 'MultiPolygon';
      readonly coordinates: readonly (readonly (readonly (readonly [number, number])[])[])[];
    }
  | {
      readonly type: 'MultiLineString';
      readonly coordinates: readonly (readonly (readonly [number, number])[])[];
    };

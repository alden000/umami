/**
 * S-52 colour tables.
 *
 * IMPORTANT - PROVENANCE. The values below are an approximation of the IHO
 * S-52 Presentation Library colour tables, not the tables themselves. They are
 * close enough that the display reads correctly to a mariner and the intended
 * contrasts hold, and they are here so the system is usable out of the box.
 * They are NOT suitable for a type-approved ECDIS.
 *
 * This is why colours are loaded through `ColourTableSource` rather than
 * compiled in. An operator holding the official Presentation Library drops it
 * in, the bundled approximation is replaced wholesale, and nothing else
 * changes: every symbol, line and fill in the system resolves its colour by
 * token, never by literal. Grep for a hex value anywhere outside this file and
 * it is a bug.
 *
 * The three tables are not decorative. Bridge lighting at night is a safety
 * matter: a display at day brightness destroys night vision and takes twenty
 * minutes to recover from, which is why NIGHT exists and why it is dark
 * overall with the few critical marks still legible.
 */

export type ColourToken =
  // Background and land.
  | 'NODTA'
  | 'LANDA'
  | 'LANDF'
  | 'CSTLN'
  // Depth shades, shallowest to deepest.
  | 'DEPIT'
  | 'DEPVS'
  | 'DEPMS'
  | 'DEPMD'
  | 'DEPDW'
  | 'DEPCN'
  | 'DEPSC'
  // Chart line and text.
  | 'CHBLK'
  | 'CHWHT'
  | 'CHGRD'
  | 'CHGRF'
  | 'CHRED'
  | 'CHGRN'
  | 'CHYLW'
  | 'CHMGD'
  | 'CHMGF'
  | 'CHBRN'
  | 'CHCOR'
  // Lights.
  | 'LITRD'
  | 'LITGN'
  | 'LITYW'
  // Dangers and traffic.
  | 'ISDNG'
  | 'DNGHL'
  | 'TRFCD'
  | 'TRFCF'
  // Own ship, targets and vectors.
  | 'SHIPS'
  | 'PSTRK'
  | 'SYTRK'
  | 'PLRTE'
  | 'APLRT'
  | 'ARPAT'
  | 'ADINF'
  | 'NINFO'
  | 'RESBL'
  // User interface chrome.
  | 'UIBCK'
  | 'UINFF'
  | 'UINFD'
  | 'UINFB'
  | 'UINFM'
  | 'UIBDR'
  | 'OUTLW';

export type ColourScheme = 'DAY_BRIGHT' | 'DUSK' | 'NIGHT';

export type ColourTable = Readonly<Record<ColourToken, string>>;

const DAY_BRIGHT: ColourTable = {
  NODTA: '#a3b4b7',
  LANDA: '#c9b97a',
  LANDF: '#84663f',
  CSTLN: '#433f39',

  DEPIT: '#869e7f',
  DEPVS: '#b9dcdc',
  DEPMS: '#d1eaea',
  DEPMD: '#e8f4f4',
  DEPDW: '#ffffff',
  DEPCN: '#90a3b1',
  DEPSC: '#51637a',

  CHBLK: '#000000',
  CHWHT: '#ffffff',
  CHGRD: '#6d7c80',
  CHGRF: '#9aa8ac',
  CHRED: '#d4003c',
  CHGRN: '#1c8c3c',
  CHYLW: '#f0c419',
  CHMGD: '#b02c8c',
  CHMGF: '#e0a8d0',
  CHBRN: '#8c6239',
  CHCOR: '#ff8000',

  LITRD: '#ff0000',
  LITGN: '#00c000',
  LITYW: '#ffff00',

  ISDNG: '#d4003c',
  DNGHL: '#ff0000',
  TRFCD: '#b02c8c',
  TRFCF: '#e0a8d0',

  SHIPS: '#000000',
  PSTRK: '#000000',
  SYTRK: '#5a5a5a',
  PLRTE: '#b02c8c',
  APLRT: '#f0c419',
  ARPAT: '#1c8c3c',
  ADINF: '#4a4a4a',
  NINFO: '#e08000',
  RESBL: '#0050a0',

  UIBCK: '#f0f0f0',
  UINFF: '#000000',
  UINFD: '#2a2a2a',
  UINFB: '#0050a0',
  UINFM: '#b02c8c',
  UIBDR: '#8c8c8c',
  OUTLW: '#000000',
};

const DUSK: ColourTable = {
  NODTA: '#4a5558',
  LANDA: '#6b6144',
  LANDF: '#4a3a24',
  CSTLN: '#8a8580',

  DEPIT: '#47543f',
  DEPVS: '#2d4a4a',
  DEPMS: '#25403f',
  DEPMD: '#1d3534',
  DEPDW: '#14282a',
  DEPCN: '#5a6d78',
  DEPSC: '#7a8ca0',

  CHBLK: '#c8c8c8',
  CHWHT: '#e0e0e0',
  CHGRD: '#8a9498',
  CHGRF: '#5a6468',
  CHRED: '#c0203c',
  CHGRN: '#1c7834',
  CHYLW: '#c0a018',
  CHMGD: '#8c2470',
  CHMGF: '#5a3a52',
  CHBRN: '#6b4a2c',
  CHCOR: '#cc6600',

  LITRD: '#e00000',
  LITGN: '#00a000',
  LITYW: '#d0d000',

  ISDNG: '#e0003c',
  DNGHL: '#ff2020',
  TRFCD: '#8c2470',
  TRFCF: '#5a3a52',

  SHIPS: '#e0e0e0',
  PSTRK: '#d0d0d0',
  SYTRK: '#909090',
  PLRTE: '#a03c88',
  APLRT: '#c0a018',
  ARPAT: '#1c7834',
  ADINF: '#a0a0a0',
  NINFO: '#c07000',
  RESBL: '#3a70b0',

  UIBCK: '#1a1f22',
  UINFF: '#d0d0d0',
  UINFD: '#a8a8a8',
  UINFB: '#3a70b0',
  UINFM: '#8c2470',
  UIBDR: '#4a5458',
  OUTLW: '#000000',
};

const NIGHT: ColourTable = {
  NODTA: '#1a1f20',
  LANDA: '#2a2618',
  LANDF: '#1c160e',
  CSTLN: '#5a5650',

  DEPIT: '#1c2418',
  DEPVS: '#10201f',
  DEPMS: '#0d1a19',
  DEPMD: '#0a1514',
  DEPDW: '#050d0e',
  DEPCN: '#38454c',
  DEPSC: '#50606e',

  CHBLK: '#808080',
  CHWHT: '#a0a0a0',
  CHGRD: '#5a6468',
  CHGRF: '#3a4448',
  CHRED: '#901830',
  CHGRN: '#145824',
  CHYLW: '#907810',
  CHMGD: '#681a54',
  CHMGF: '#3a2636',
  CHBRN: '#4a331e',
  CHCOR: '#994d00',

  LITRD: '#b00000',
  LITGN: '#008000',
  LITYW: '#a0a000',

  ISDNG: '#b00030',
  DNGHL: '#d01010',
  TRFCD: '#681a54',
  TRFCF: '#3a2636',

  SHIPS: '#a0a0a0',
  PSTRK: '#909090',
  SYTRK: '#606060',
  PLRTE: '#782864',
  APLRT: '#907810',
  ARPAT: '#145824',
  ADINF: '#707070',
  NINFO: '#8a5000',
  RESBL: '#2a5080',

  UIBCK: '#0a0d0e',
  UINFF: '#909090',
  UINFD: '#707070',
  UINFB: '#2a5080',
  UINFM: '#681a54',
  UIBDR: '#2a3438',
  OUTLW: '#000000',
};

export const BUNDLED_COLOUR_TABLES: Readonly<Record<ColourScheme, ColourTable>> = {
  DAY_BRIGHT,
  DUSK,
  NIGHT,
};

export interface ColourTableSource {
  /** Where these tables came from, shown in the about screen. */
  readonly provenance: 'approximation' | 'official-preslib' | 'custom';
  readonly tables: Readonly<Record<ColourScheme, ColourTable>>;
}

export const BUNDLED_COLOURS: ColourTableSource = {
  provenance: 'approximation',
  tables: BUNDLED_COLOUR_TABLES,
};

/**
 * Resolves colour tokens for the active scheme.
 *
 * Every drawing decision in the system goes through this. Swapping the source
 * to the official Presentation Library, or to a customer's own tables, is a
 * one-line change here and affects everything consistently.
 */
export class Palette {
  constructor(
    private source: ColourTableSource = BUNDLED_COLOURS,
    private scheme: ColourScheme = 'DAY_BRIGHT',
  ) {}

  get provenance(): ColourTableSource['provenance'] {
    return this.source.provenance;
  }

  get activeScheme(): ColourScheme {
    return this.scheme;
  }

  setScheme(scheme: ColourScheme): void {
    this.scheme = scheme;
  }

  setSource(source: ColourTableSource): void {
    this.source = source;
  }

  get(token: ColourToken): string {
    return this.source.tables[this.scheme][token];
  }

  /** The whole active table, for handing to a style generator in one go. */
  table(): ColourTable {
    return this.source.tables[this.scheme];
  }
}

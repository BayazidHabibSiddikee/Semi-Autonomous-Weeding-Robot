import { CropFieldId } from './types';

export interface CropFieldSpec {
  id: CropFieldId;
  index: number;
  name: string;
  shortName: string;
  modelClass: string;
  dominantWeeds: string[];
  description: string;
  rowSpacingCm: number;
  canopyHeightCm: number;
  soilTintHex: number;
  ridgeTintHex: number;
  meadowTintHex: number;
  skyTintHex: number;
  cropLeafHex: number;
  cropAccentHex: number;
  cropLeafCss: string;
  cropAccentCss: string;
  soilCss: string;
}

export const CROP_FIELDS: CropFieldSpec[] = [
  {
    id: 'tomato',
    index: 1,
    name: 'Tomato Field',
    shortName: 'Tomato',
    modelClass: 'crop_tomato',
    dominantWeeds: ['weed_dandelion', 'weed_grass', 'weed_purslane'],
    description: 'Young cherry-tomato rows on raised loam beds with inter-row broadleaf weeds.',
    rowSpacingCm: 60,
    canopyHeightCm: 14,
    soilTintHex: 0xc29e7d,
    ridgeTintHex: 0xb08a68,
    meadowTintHex: 0x6c8a47,
    skyTintHex: 0xcbe0ec,
    cropLeafHex: 0x1e6b30,
    cropAccentHex: 0xdc2626,
    cropLeafCss: '#1e6b30',
    cropAccentCss: '#dc2626',
    soilCss: '#7c5c40',
  },
  {
    id: 'chili',
    index: 2,
    name: 'Chili Pepper Field',
    shortName: 'Chili',
    modelClass: 'crop_chili',
    dominantWeeds: ['weed_grass', 'weed_amaranth', 'weed_purslane'],
    description: 'Compact spicy chili bushes on warm sandy-loam ridges with creeping furrow grass.',
    rowSpacingCm: 60,
    canopyHeightCm: 15,
    soilTintHex: 0xd2a87b,
    ridgeTintHex: 0xbe9062,
    meadowTintHex: 0x7c9049,
    skyTintHex: 0xd8e5ea,
    cropLeafHex: 0x257437,
    cropAccentHex: 0xef4444,
    cropLeafCss: '#257437',
    cropAccentCss: '#ef4444',
    soilCss: '#8f6944',
  },
  {
    id: 'flower',
    index: 3,
    name: 'Marigold Flower Field',
    shortName: 'Marigold',
    modelClass: 'crop_flower',
    dominantWeeds: ['weed_dandelion', 'weed_grass', 'weed_amaranth'],
    description: 'Ornamental golden-orange marigold nursery rows requiring careful blossom protection.',
    rowSpacingCm: 60,
    canopyHeightCm: 13,
    soilTintHex: 0xa48063,
    ridgeTintHex: 0x8f6b4e,
    meadowTintHex: 0x5d8443,
    skyTintHex: 0xcfe4f0,
    cropLeafHex: 0x22682f,
    cropAccentHex: 0xf59e0b,
    cropLeafCss: '#22682f',
    cropAccentCss: '#f59e0b',
    soilCss: '#684c37',
  },
  {
    id: 'eggplant',
    index: 4,
    name: 'Eggplant / Brinjal Field',
    shortName: 'Eggplant',
    modelClass: 'crop_eggplant',
    dominantWeeds: ['weed_amaranth', 'weed_purslane', 'weed_grass'],
    description: 'Broad-leaved brinjal rows with glossy purple fruit clusters on dark alluvial ridges.',
    rowSpacingCm: 60,
    canopyHeightCm: 16,
    soilTintHex: 0x997960,
    ridgeTintHex: 0x82624a,
    meadowTintHex: 0x5f7d41,
    skyTintHex: 0xc8dde8,
    cropLeafHex: 0x2b6a3b,
    cropAccentHex: 0x6b21a8,
    cropLeafCss: '#2b6a3b',
    cropAccentCss: '#7e22ce',
    soilCss: '#5e4736',
  },
  {
    id: 'cabbage',
    index: 5,
    name: 'Cabbage Field',
    shortName: 'Cabbage',
    modelClass: 'crop_cabbage',
    dominantWeeds: ['weed_purslane', 'weed_dandelion', 'weed_grass'],
    description: 'Dense blue-green cabbage rosettes on moist clay-loam beds with low furrow weeds.',
    rowSpacingCm: 60,
    canopyHeightCm: 11,
    soilTintHex: 0x9b826d,
    ridgeTintHex: 0x876e5a,
    meadowTintHex: 0x5d8252,
    skyTintHex: 0xc6dde6,
    cropLeafHex: 0x3b8b5b,
    cropAccentHex: 0x86efac,
    cropLeafCss: '#3b8b5b',
    cropAccentCss: '#86efac',
    soilCss: '#625042',
  },
  {
    id: 'corn',
    index: 6,
    name: 'Sweet Corn Field',
    shortName: 'Corn',
    modelClass: 'crop_corn',
    dominantWeeds: ['weed_grass', 'weed_amaranth', 'weed_dandelion'],
    description: 'Early-stage upright maize seedlings on golden dry-loam rows testing grass-vs-corn vision.',
    rowSpacingCm: 60,
    canopyHeightCm: 18,
    soilTintHex: 0xd9b88c,
    ridgeTintHex: 0xc49f71,
    meadowTintHex: 0x85924a,
    skyTintHex: 0xdce8ee,
    cropLeafHex: 0x4d8b31,
    cropAccentHex: 0xfacc15,
    cropLeafCss: '#4d8b31',
    cropAccentCss: '#eab308',
    soilCss: '#93744e',
  },
  {
    id: 'strawberry',
    index: 7,
    name: 'Strawberry Patch',
    shortName: 'Strawberry',
    modelClass: 'crop_strawberry',
    dominantWeeds: ['weed_purslane', 'weed_dandelion', 'weed_grass'],
    description: 'Low-canopy strawberry crowns on dark-mulch raised beds with high thermal sensitivity.',
    rowSpacingCm: 60,
    canopyHeightCm: 10,
    soilTintHex: 0x8b6e57,
    ridgeTintHex: 0x3d3835,
    meadowTintHex: 0x628546,
    skyTintHex: 0xd0e3ef,
    cropLeafHex: 0x1d7536,
    cropAccentHex: 0xe11d48,
    cropLeafCss: '#1d7536',
    cropAccentCss: '#e11d48',
    soilCss: '#534033',
  },
  {
    id: 'lettuce',
    index: 8,
    name: 'Crisp Lettuce Field',
    shortName: 'Lettuce',
    modelClass: 'crop_lettuce',
    dominantWeeds: ['weed_dandelion', 'weed_purslane', 'weed_amaranth'],
    description: 'Bright ruffled crisphead lettuce beds requiring precision DINOv2 weed-vs-leaf separation.',
    rowSpacingCm: 60,
    canopyHeightCm: 11,
    soilTintHex: 0xb69578,
    ridgeTintHex: 0x9e7d62,
    meadowTintHex: 0x688c4b,
    skyTintHex: 0xd2e6ef,
    cropLeafHex: 0x65a30d,
    cropAccentHex: 0xbef264,
    cropLeafCss: '#65a30d',
    cropAccentCss: '#bef264',
    soilCss: '#735a44',
  },
];

export const CROP_FIELD_BY_ID: Record<CropFieldId, CropFieldSpec> = Object.fromEntries(
  CROP_FIELDS.map((f) => [f.id, f])
) as Record<CropFieldId, CropFieldSpec>;

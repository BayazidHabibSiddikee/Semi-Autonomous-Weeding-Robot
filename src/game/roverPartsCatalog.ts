import { PartId, RoverPartSpec } from './types';

export const ROVER_PARTS: RoverPartSpec[] = [
  {
    id: 'chassis_deck',
    step: 1,
    name: 'Laser-Cut Walnut-Plywood Top Deck',
    shortName: 'Top Deck',
    category: 'Structure',
    specLine: '256 × 155 × 3.5 mm · Z = 125 mm · Mortise & star cutouts',
    description:
      'Stained laser-cut hardwood upper deck with mortise slots for the side bridge arches and center fuel canister pass-through.',
    requires: [],
    requiredForDrive: true,
    explodeOffset: [0, 0.1, 0],
    dropOffset: [0, 0.4, 0],
    focusOffset: [0, 0.13, 0],
  },
  {
    id: 'arch_legs',
    step: 2,
    name: 'High-Clearance Straddle Arch Legs',
    shortName: 'Arch Legs',
    category: 'Structure',
    specLine: '4× 45° wooden bridge plates · 3 center bridge slots · M3 bolts',
    description:
      'Dual-wall dark-stained wooden straddle arches clamped with M3 cross-bolts to clear uneven farm furrows.',
    requires: ['chassis_deck'],
    requiredForDrive: true,
    explodeOffset: [0, -0.05, 0],
    dropOffset: [0, -0.22, 0],
    focusOffset: [0, 0.08, 0],
  },
  {
    id: 'tt_motors',
    step: 3,
    name: '4× Yellow TT Geared Motors & Encoders',
    shortName: '4× TT Motors',
    category: 'Drivetrain',
    specLine: '1:48 dual-shaft gearboxes · Clamped at 45° · Quadrature encoders',
    description:
      'Four yellow TT DC gear motors locked inside the outer motor windows along the sloped legs with optical encoder discs.',
    requires: ['arch_legs'],
    requiredForDrive: true,
    explodeOffset: [0, -0.02, 0],
    dropOffset: [0, 0.2, 0],
    focusOffset: [0, 0.04, 0],
  },
  {
    id: 'rover_wheels',
    step: 4,
    name: '4× Yellow 5-Spoke Lugged Wheels',
    shortName: '4× Wheels',
    category: 'Drivetrain',
    specLine: 'Ø 70 mm · 26 mm rubber tread · 174 mm wheel track',
    description:
      'Signature bright yellow 5-spoke rims with deep-tread black rubber tires for farm-soil differential traction.',
    requires: ['tt_motors'],
    requiredForDrive: true,
    explodeOffset: [0, 0, 0],
    dropOffset: [0, 0.14, 0],
    focusOffset: [0, 0.035, 0],
  },
  {
    id: 'power_driver',
    step: 5,
    name: 'Power Bank, Relay & L298N Deck',
    shortName: 'Power + Relay',
    category: 'Electronics',
    specLine: 'Rear high-capacity power pack · 5V/12V rail · Relay & H-bridge',
    description:
      'Slate-metallic rear power bank mounted flat over the perfboard, blue opto-isolated relay module, and dual H-bridge driver.',
    requires: ['chassis_deck'],
    requiredForDrive: true,
    explodeOffset: [-0.1, 0.16, 0],
    dropOffset: [0, 0.42, 0],
    focusOffset: [-0.07, 0.16, 0],
  },
  {
    id: 'esp32_mcu',
    step: 6,
    name: 'ESP32 Controller, IMU & Loom',
    shortName: 'ESP32 + IMU',
    category: 'Electronics',
    specLine: '115200 baud UART · BNO055 9-DOF · 250 ms serial watchdog',
    description:
      'Real-time motor PID microcontroller with BNO055 heading sensor, ToF obstacle sensor, and neatly routed braided harness.',
    requires: ['power_driver'],
    requiredForDrive: true,
    explodeOffset: [-0.08, 0.22, 0.06],
    dropOffset: [0, 0.44, 0],
    focusOffset: [-0.05, 0.15, 0.04],
  },
  {
    id: 'raspberry_pi',
    step: 7,
    name: 'Vented Raspberry Pi 4 Compute Case',
    shortName: 'Pi 4 Case',
    category: 'Electronics',
    specLine: 'Perforated matte-black enclosure · USB-C power · AI Weed Vision',
    description:
      'Signature perforated black Raspberry Pi 4 compute box stacked cleanly atop the rear power bank running autonomous navigation.',
    requires: ['power_driver'],
    requiredForDrive: true,
    explodeOffset: [-0.12, 0.28, 0],
    dropOffset: [0, 0.48, 0],
    focusOffset: [-0.07, 0.2, 0],
  },
  {
    id: 'camera_gantry',
    step: 8,
    name: 'Forward L-Cantilever Vision Gantry',
    shortName: 'Camera Gantry',
    category: 'Perception',
    specLine: 'Engineered white L-frame · Downward AI camera · Front ToF',
    description:
      'Refined white forward-cantilevered twin-wall gantry holding the black oval downward-looking weed detection camera above the nozzle.',
    requires: ['chassis_deck', 'raspberry_pi'],
    requiredForDrive: false,
    explodeOffset: [0.14, 0.22, 0],
    dropOffset: [0.12, 0.46, 0],
    focusOffset: [0.13, 0.26, 0],
  },
  {
    id: 'fuel_valve_turret',
    step: 9,
    name: 'Inverted Butane Tank & Geared Valve',
    shortName: 'Fuel + Gears',
    category: 'Thermal Tool',
    specLine: 'Inverted butane cylinder · White geared turret · Servo spur gear',
    description:
      'Vertical inverted butane canister seated in a 3D-printed white spur-gear collar driven by a side servo with meshing graphite spur gear.',
    requires: ['chassis_deck', 'esp32_mcu'],
    requiredForDrive: false,
    explodeOffset: [0.04, 0.3, 0],
    dropOffset: [0.02, 0.52, 0],
    focusOffset: [0.04, 0.22, 0],
  },
  {
    id: 'igniter_torch',
    step: 10,
    name: 'HV Arc Igniter & Front Flame Barrel',
    shortName: 'Igniter + Torch',
    category: 'Thermal Tool',
    specLine: 'HV spark generator · Stainless front barrel · GPIO 13 E-Stop',
    description:
      'Side-mounted black high-voltage arc igniter wired to the low forward-pointing stainless flame nozzle between the front wheels.',
    requires: ['fuel_valve_turret', 'arch_legs'],
    requiredForDrive: false,
    explodeOffset: [0.16, -0.06, 0],
    dropOffset: [0.24, 0.22, 0],
    focusOffset: [0.14, 0.06, 0],
  },
];

export const PART_BY_ID: Record<PartId, RoverPartSpec> = Object.fromEntries(
  ROVER_PARTS.map((p) => [p.id, p])
) as Record<PartId, RoverPartSpec>;

export const CORE_DRIVE_PARTS: PartId[] = ROVER_PARTS.filter((p) => p.requiredForDrive).map(
  (p) => p.id
);

export function canInstallPart(partId: PartId, installed: Set<PartId>): boolean {
  if (installed.has(partId)) return false;
  const spec = PART_BY_ID[partId];
  return spec.requires.every((req) => installed.has(req));
}

export function getNextInstallablePart(installed: Set<PartId>): RoverPartSpec | null {
  for (const part of ROVER_PARTS) {
    if (!installed.has(part.id) && canInstallPart(part.id, installed)) {
      return part;
    }
  }
  return null;
}

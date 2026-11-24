export interface NavAuditEntry {
  id: string;
  priority: 'P0' | 'P1' | 'P2';
  sector: 'Navigation' | 'Firmware / HW';
  title: string;
  legacyDefect: string;
  resolvedImplementation: string;
  targetFiles: string[];
  verifiedBy: string;
}

export const NAV_AUDIT_MATRIX: NavAuditEntry[] = [
  {
    id: 'NAV-01',
    priority: 'P0',
    sector: 'Navigation',
    title: 'Open-Loop Movement Replaced with Encoder Closed-Loop',
    legacyDefect: 'move_forward(cm) converted distance to time via blind 10 cm/s constant; soil drag caused 20-40% error.',
    resolvedImplementation: 'RoverMotors.move_distance() commands ESP32 closed-loop VEL targets and closes distance on quadrature encoder odometry.',
    targetFiles: ['Navigation/src/rover_motors.py', 'Navigation/esp32_firmware/rover_firmware.py'],
    verifiedBy: 'test_nav01_nav02_closed_loop_encoder_and_imu_turn',
  },
  {
    id: 'NAV-02',
    priority: 'P0',
    sector: 'Navigation',
    title: 'Blind Timed Rotation Replaced with IMU Heading Loop',
    legacyDefect: 'rotate(deg) spun motors for deg * 5 ms with zero yaw feedback, ruining 90° and 180° headland turns.',
    resolvedImplementation: 'RoverMotors.rotate_to_heading() uses fused IMU + encoder yaw from FieldLocalizer with deadband tolerance and deceleration.',
    targetFiles: ['Navigation/src/rover_motors.py', 'Navigation/src/localizer.py'],
    verifiedBy: 'test_nav01_nav02_closed_loop_encoder_and_imu_turn',
  },
  {
    id: 'NAV-03',
    priority: 'P0',
    sector: 'Navigation',
    title: 'Continuous Pose Fusion + Slip Residual Detection',
    legacyDefect: 'Pure dead reckoning drifted unboundedly across multi-row runs without any landmark correction.',
    resolvedImplementation: 'FieldLocalizer fuses wheel ticks, BNO055 IMU yaw/gyro, and ArUco/landmark fixes while flagging wheel slip > 12 cm.',
    targetFiles: ['Navigation/src/localizer.py'],
    verifiedBy: 'test_nav03_nav10_slip_fault_and_explicit_relocalization',
  },
  {
    id: 'NAV-04',
    priority: 'P0',
    sector: 'Navigation',
    title: 'Production State Machine Wired to RowNavigator',
    legacyDefect: 'rover_main.py never instantiated RowNavigator; state_machine.py ran a stub _do_rotate() loop.',
    resolvedImplementation: 'build_navigation_stack() wires RowNavigator directly into RoverStateMachine for full serpentine row & headland traversal.',
    targetFiles: ['Navigation/src/rover_main.py', 'Navigation/src/state_machine.py'],
    verifiedBy: 'test_nav04_nav07_nav11_nav12_full_serpentine_coverage_and_checkpoint',
  },
  {
    id: 'NAV-05',
    priority: 'P0',
    sector: 'Navigation',
    title: 'Fail-Safe Obstacle Sensor Handling (-1 -> FAULT)',
    legacyDefect: 'Invalid ultrasonic read (-1) bypassed dist > 0 check and let the rover keep driving blind.',
    resolvedImplementation: 'UltrasonicSensor classifies -1 / out-of-range as SENSOR_FAULT; state machine immediately stops motors and enters FAULT.',
    targetFiles: ['Navigation/src/ultrasonic.py', 'Navigation/src/state_machine.py'],
    verifiedBy: 'test_nav05_invalid_sensor_reading_enters_fault_and_stops',
  },
  {
    id: 'NAV-06',
    priority: 'P0',
    sector: 'Navigation',
    title: 'Single Shared ESP32 Serial Bridge (No Dual Port Lock)',
    legacyDefect: 'rover_main.py opened /dev/ttyUSB0 separately in ESP32Bridge and RoverMotors, causing serial port contention.',
    resolvedImplementation: 'Single thread-safe ESP32Bridge instance shared across RoverMotors, UltrasonicSensor, and telemetry polling.',
    targetFiles: ['Navigation/src/esp32_bridge.py', 'Navigation/src/rover_main.py'],
    verifiedBy: 'test_nav06_single_shared_esp32_bridge',
  },
  {
    id: 'NAV-07',
    priority: 'P1',
    sector: 'Navigation',
    title: 'Fused Row-End Detection & Lateral Row Alignment',
    legacyDefect: 'Single forward ToF reading > 1000 mm triggered false row ends over soil gaps with zero lateral alignment.',
    resolvedImplementation: 'RowNavigator checks fused pose against row bounds + headland margin and corrects lateral drift before advancing.',
    targetFiles: ['Navigation/src/row_navigator.py'],
    verifiedBy: 'test_nav04_nav07_nav11_nav12_full_serpentine_coverage_and_checkpoint',
  },
  {
    id: 'NAV-08',
    priority: 'P1',
    sector: 'Navigation',
    title: 'Field Boundary Polygon Guard with Footprint Margin',
    legacyDefect: 'No geofence or polygon boundary enforcement prevented the rover from driving outside the field.',
    resolvedImplementation: 'FieldBoundaryGuard enforces inset polygon containment + pre-move path projection before every forward step or turn.',
    targetFiles: ['Navigation/src/field_boundary.py', 'Navigation/src/row_navigator.py'],
    verifiedBy: 'test_nav08_field_boundary_guard_blocks_exit',
  },
  {
    id: 'NAV-09',
    priority: 'P1',
    sector: 'Navigation',
    title: 'Safe Obstacle Hold (Zero Blind Auto-Dodging)',
    legacyDefect: 'Simulator auto-dodged obstacles laterally without checking crops or boundaries; production lacked hold state.',
    resolvedImplementation: 'Unknown obstacles trigger OBSTACLE_HOLD with motors stopped until clear or operator-authorized recovery.',
    targetFiles: ['Navigation/src/state_machine.py', 'Navigation/sim/run_field_sim.py'],
    verifiedBy: 'test_nav09_unknown_obstacle_safe_hold_no_autododge',
  },
  {
    id: 'NAV-10',
    priority: 'P1',
    sector: 'Navigation',
    title: 'Explicit Fault Recovery & Landmark Re-Localization',
    legacyDefect: 'Faults had no structured recovery gate; resuming after wheel slip continued with corrupted pose.',
    resolvedImplementation: 'FAULT state blocks plain resume() and requires explicit recover(relocalize_pose=...) after sensor/pose validation.',
    targetFiles: ['Navigation/src/state_machine.py', 'Navigation/src/localizer.py'],
    verifiedBy: 'test_nav03_nav10_slip_fault_and_explicit_relocalization',
  },
  {
    id: 'NAV-11',
    priority: 'P2',
    sector: 'Navigation',
    title: 'Verified Per-Row Coverage & Skipped Segment Accounting',
    legacyDefect: 'Mission completion reported DONE without measuring actual traversed row distance or skipped zones.',
    resolvedImplementation: 'MissionTracker records covered row intervals, completed/unfinished row sets, and skipped segments (99.9% verified in sim).',
    targetFiles: ['Navigation/src/mission_checkpoint.py'],
    verifiedBy: 'test_nav04_nav07_nav11_nav12_full_serpentine_coverage_and_checkpoint',
  },
  {
    id: 'NAV-12',
    priority: 'P2',
    sector: 'Navigation',
    title: 'Atomic Mission Checkpointing & Operator Pause/Resume',
    legacyDefect: 'Interrupted field missions restarted from Row 0 with no persistent state or safe pause semantics.',
    resolvedImplementation: 'MissionTracker writes atomic JSON checkpoints on row milestones and pause(), supporting --resume CLI continuation.',
    targetFiles: ['Navigation/src/mission_checkpoint.py', 'Navigation/src/rover_main.py'],
    verifiedBy: 'test_nav04_nav07_nav11_nav12_full_serpentine_coverage_and_checkpoint',
  },
  {
    id: 'HW-01 / HW-04 / HW-05',
    priority: 'P0',
    sector: 'Firmware / HW',
    title: 'GPIO Pin Collision & Portable PWM Servo Fix',
    legacyDefect: 'GPIO 25 & 22 conflicted between config and firmware; rover_firmware.py imported non-portable machine.Servo.',
    resolvedImplementation: 'Single authoritative rover_config.yaml pinout; standard machine.PWM duty_u16 gimbal control; laser detached from nav.',
    targetFiles: ['Navigation/rover_config.yaml', 'Navigation/esp32_firmware/rover_firmware.py'],
    verifiedBy: 'test_hw06_hw07_firmware_validation_and_watchdog',
  },
  {
    id: 'HW-02 / HW-06..09',
    priority: 'P0',
    sector: 'Firmware / HW',
    title: 'Non-Blocking 50 Hz PID, Watchdog, E-Stop & VL53L0X',
    legacyDefect: 'Blocking time.sleep_ms() froze serial E-stop; VL53L0X was stubbed; malformed commands were unchecked.',
    resolvedImplementation: 'Non-blocking 50 Hz PID loop, 64 CPR encoder ISRs, 250 ms serial watchdog, GPIO 13 E-stop sense, and strict parser.',
    targetFiles: ['Navigation/esp32_firmware/rover_firmware.py', 'Navigation/src/ultrasonic.py'],
    verifiedBy: 'test_hw06_hw07_firmware_validation_and_watchdog',
  },
  {
    id: 'AUD-26-1A',
    priority: 'P0',
    sector: 'Navigation',
    title: 'Eliminated Virtual Map Pose Stepping in Pi Server',
    legacyDefect: 'pi_server.py incremented rover_nx/rover_ny mathematically along waypoints with zero wheel encoder or IMU feedback.',
    resolvedImplementation: 'HardenedNavigationController derives pose exclusively from FieldLocalizer (encoder ticks + BNO055 IMU); frozen encoders produce zero map progress.',
    targetFiles: ['Navigation/src/pi_server.py', 'Navigation/src/localizer.py'],
    verifiedBy: 'test_audit26_1a_no_virtual_pose_without_physical_encoders',
  },
  {
    id: 'AUD-26-1B',
    priority: 'P0',
    sector: 'Navigation',
    title: 'Real 3-Stage Closed-Loop Headland Row Crossing',
    legacyDefect: 'Horizontal row transition only sent pivot command (90/270 deg) while faking lateral progress on the map.',
    resolvedImplementation: 'Wired pi_server.py directly to RowNavigator 3-stage closed-loop turn -> encoder-measured cross-furrow drive -> opposite-row alignment.',
    targetFiles: ['Navigation/src/pi_server.py', 'Navigation/src/row_navigator.py'],
    verifiedBy: 'test_nav04_nav07_nav11_nav12_full_serpentine_coverage_and_checkpoint',
  },
  {
    id: 'AUD-26-1C',
    priority: 'P0',
    sector: 'Navigation',
    title: 'Fail-Closed Camera Loss Guard (Zero Blind Drive)',
    legacyDefect: 'Missing or failed camera read() substituted synthetic wall_distance_mm and lateral_offset_mm=0.0 while keeping motors moving.',
    resolvedImplementation: 'CameraHealthMonitor halts motors immediately (STOP -> FAULT CAMERA_LOSS) on camera detach, read() failures, or frames stale > 500 ms.',
    targetFiles: ['Navigation/src/pi_server.py'],
    verifiedBy: 'test_audit26_1c_camera_failure_causes_immediate_stop_no_blind_move',
  },
  {
    id: 'AUD-26-1D / 3C / 3D',
    priority: 'P0',
    sector: 'Navigation',
    title: 'One-Shot Target Lifecycle, Crop Rejection & Homography Gate',
    legacyDefect: 'Visible weeds could trigger relays repeatedly every tick; crop classes were unfiltered; pixel-to-mm used uncalibrated scaling.',
    resolvedImplementation: 'TargetExecutionManager enforces DETECTED->VALIDATED->POSITIONED->ACTUATED_ONCE->VERIFIED->CONSUMED, rejects crop_* classes, deduplicates within 45 mm, and requires calibrated 3x3 H.',
    targetFiles: ['Navigation/src/target_lifecycle.py', 'Navigation/src/pi_server.py'],
    verifiedBy: 'test_audit26_1d_3c_3d_one_shot_target_lifecycle_and_crop_rejection',
  },
  {
    id: 'AUD-26-1E',
    priority: 'P0',
    sector: 'Firmware / HW',
    title: 'Verified E-Stop ACK (HTTP 503 on Failure) & Non-Clearing Latch',
    legacyDefect: '/stop returned HTTP 200 even on SIM/NO_ACK/UART_ERR; ESP32 watchdog/E-stop latch cleared on any incoming serial command.',
    resolvedImplementation: 'ESP32 firmware maintains strict estop_latched & watchdog_tripped latches cleared only by CLEAR_LATCH; /stop verifies OK:ESTOP_LATCHED and returns HTTP 503 on unverified UART.',
    targetFiles: ['Navigation/esp32_firmware/rover_firmware.py', 'Navigation/src/esp32_bridge.py', 'Navigation/src/pi_server.py'],
    verifiedBy: 'test_audit26_1e_estop_latch_and_unverified_ack_returns_503',
  },
  {
    id: 'AUD-26-2B / 2C / 3A',
    priority: 'P0',
    sector: 'Navigation',
    title: '6-Point Launch Interlocks & Sample-Image Live Block',
    legacyDefect: '/start_mission lacked hardware readiness interlocks and allowed demo /media/field_render.png to launch physical missions.',
    resolvedImplementation: 'evaluate_launch_interlocks() returns HTTP 412 unless ESP32, live camera, E-stop, sensors, calibration/model (when weeding), and non-sample live capture are verified.',
    targetFiles: ['Navigation/src/pi_server.py'],
    verifiedBy: 'test_audit26_2b_2c_3a_launch_interlocks_and_sample_image_guard',
  },
];

export interface HardwareAuditItem {
  subsystem: string;
  currentState: string;
  defectFound: string;
  fixedDesign: string;
  severity: 'Critical' | 'High' | 'Resolved';
}

export const HARDWARE_AUDIT_ITEMS: HardwareAuditItem[] = [
  {
    subsystem: 'Drivetrain Kinematics (URDF vs ESP32)',
    currentState: 'URDF models 4 driven wheels (libgazebo_ros_diff_drive); ESP32 drives 2 L298N channels (Left/Right).',
    defectFound: 'Drive model mismatch between 4-wheel URDF and 2-channel L298N prevents valid ros2_control commissioning.',
    fixedDesign: 'Coupled 4WD paired-channel DiffDriveController in ros2_control (FL+RL -> Ch A, FR+RR -> Ch B, skid multiplier 1.18).',
    severity: 'Critical',
  },
  {
    subsystem: 'Motor Control Loop & Blocking Firmware',
    currentState: 'Open-loop MOVE F 500 200 with blocking time.sleep_ms(duration) on ESP32; blind rotation (deg * 5 ms).',
    defectFound: 'Zero encoder feedback; soil slip ruins turns; blocking sleep prevents serial E-stop commands during motion.',
    fixedDesign: 'Non-blocking 50 Hz ESP32 closed-loop velocity PID (VEL l r), 64 CPR quadrature encoder ISRs, and 250 ms serial watchdog.',
    severity: 'Critical',
  },
  {
    subsystem: 'ESP32 GPIO Pin Collisions & Dual Serial Open',
    currentState: 'rover_config.yaml conflicted on GPIO 25 & 22; rover_main.py opened /dev/ttyUSB0 twice.',
    defectFound: 'Pin overlap caused hardware contention; dual serial port handles failed on real Raspberry Pi Linux.',
    fixedDesign: 'Zero-conflict pin map synced in rover_config.yaml + firmware, plus single shared thread-safe ESP32Bridge bus.',
    severity: 'Critical',
  },
  {
    subsystem: 'Row-End, Boundary & Obstacle Fail-Safe',
    currentState: 'Single forward ultrasonic checked dist > 1000 mm and ignored -1 error reads; no field boundary guard.',
    defectFound: 'Sensor disconnect (-1) allowed blind forward drive; soil gaps caused false row-end triggers.',
    fixedDesign: 'Fail-safe SENSOR_FAULT halt on -1 reads, OBSTACLE_HOLD without blind dodging, FieldBoundaryGuard polygon, and ExG+Otsu cam.',
    severity: 'High',
  },
  {
    subsystem: 'Localization & Recovery Gate',
    currentState: 'Time-based dead reckoning (10 cm/s estimate) with no slip detection or landmark re-localization.',
    defectFound: 'Unbounded heading/position drift on soft soil; resumed missions kept corrupted pose.',
    fixedDesign: 'FieldLocalizer + ROS 2 dual-EKF (Encoders + BNO055 IMU + RTK-GNSS/ArUco) with slip fault & explicit recover() gate.',
    severity: 'High',
  },
  {
    subsystem: 'Treatment Decoupling & Hardware E-Stop',
    currentState: 'Legacy navigation directly imported laser controller; no hardware E-stop sense on ESP32.',
    defectFound: 'Navigation could not run standalone; legacy laser is retired in favor of future modular Flame/Grinder units.',
    fixedDesign: 'Zero laser runtime dependency in Navigation/; optional abstract treatment_hook + hardware E-stop relay on GPIO 13.',
    severity: 'Critical',
  },
];

export interface PinMapEntry {
  signal: string;
  legacyConfig: string;
  legacyFirmware: string;
  resolvedGpio: string;
  notes: string;
}

export const GPIO_PIN_MAP: PinMapEntry[] = [
  { signal: 'Left Motor FWD / BWD', legacyConfig: 'GPIO 26 / 27', legacyFirmware: 'GPIO 26 / 27', resolvedGpio: 'GPIO 26 / 27', notes: 'L298N IN1 / IN2 (Paired FL+RL)' },
  { signal: 'Left Motor PWM (ENA)', legacyConfig: 'Unlisted', legacyFirmware: 'GPIO 25', resolvedGpio: 'GPIO 25', notes: 'Dedicated 2 kHz PWM channel' },
  { signal: 'Right Motor FWD / BWD', legacyConfig: 'GPIO 14 / 12', legacyFirmware: 'GPIO 14 / 12', resolvedGpio: 'GPIO 14 / 12', notes: 'L298N IN3 / IN4 (Paired FR+RR)' },
  { signal: 'Right Motor PWM (ENB)', legacyConfig: 'Unlisted', legacyFirmware: 'GPIO 33', resolvedGpio: 'GPIO 33', notes: 'Dedicated 2 kHz PWM channel' },
  { signal: 'Left Quadrature Encoder A/B', legacyConfig: 'Missing', legacyFirmware: 'Missing', resolvedGpio: 'GPIO 34 / 35', notes: 'Input-only ISR pins (17,280 ticks/rev)' },
  { signal: 'Right Quadrature Encoder A/B', legacyConfig: 'Missing', legacyFirmware: 'Missing', resolvedGpio: 'GPIO 36 / 39', notes: 'Input-only ISR pins (17,280 ticks/rev)' },
  { signal: 'I2C Bus (BNO055 / VL53L0X)', legacyConfig: 'GPIO 22 (CONFLICT)', legacyFirmware: 'GPIO 21 / 22', resolvedGpio: 'GPIO 21 / 22', notes: 'SDA / SCL (400 kHz Fast Mode)' },
  { signal: 'HC-SR04 Ultrasonic Trig / Echo', legacyConfig: 'GPIO 23 / 22 (CONFLICT)', legacyFirmware: 'Missing', resolvedGpio: 'GPIO 5 / 17', notes: 'Moved off I2C SCL; backup to VL53L0X' },
  { signal: 'Hardware E-Stop Sense', legacyConfig: 'RPi GPIO only', legacyFirmware: 'Missing', resolvedGpio: 'GPIO 13', notes: 'Active-HIGH closed-loop E-stop input' },
  { signal: 'Pan / Tilt Gimbal Servos', legacyConfig: 'GPIO 18 / 19', legacyFirmware: 'machine.Servo (Broken)', resolvedGpio: 'GPIO 18 / 19', notes: 'Portable machine.PWM duty_u16 @ 50 Hz' },
  { signal: 'Modular Treatment Aux Interlock', legacyConfig: 'GPIO 25 (CONFLICT)', legacyFirmware: 'GPIO 4 (Legacy Laser)', resolvedGpio: 'GPIO 4 (Detached)', notes: 'Reserved for future Flame/Grinder module' },
];

export interface SensorUpgradeItem {
  id: string;
  component: string;
  model: string;
  priority: 'Essential' | 'Strongly Recommended' | 'Recommended';
  rosTopic: string;
  role: string;
  defaultInstalled: boolean;
}

export const SENSOR_UPGRADE_BOM: SensorUpgradeItem[] = [
  {
    id: 'encoders',
    component: 'Wheel Quadrature Encoders',
    model: 'CQRobot 270:1 Metal DC Motor (64 CPR)',
    priority: 'Essential',
    rosTopic: '/wheel/odometry',
    role: 'Closed-loop velocity PID and accurate wheel odometry for turns and row transitions (NAV-01).',
    defaultInstalled: true,
  },
  {
    id: 'imu',
    component: '9-DOF Absolute Orientation IMU',
    model: 'Adafruit BNO055 (I2C)',
    priority: 'Essential',
    rosTopic: '/imu/data',
    role: 'Heading and angular rate fusion in FieldLocalizer & EKF; slip detection & tilt safety (NAV-02/03).',
    defaultInstalled: true,
  },
  {
    id: 'rtk',
    component: 'RTK-GNSS Receiver / ArUco Landmarks',
    model: 'Holybro H-RTK ZED-F9P Rover (or Field ArUco Markers)',
    priority: 'Strongly Recommended',
    rosTopic: '/gps/fix -> /odometry/gps',
    role: 'Bounded global field coordinates, FieldBoundaryGuard polygon enforcement, and landmark re-localization.',
    defaultInstalled: true,
  },
  {
    id: 'lidar',
    component: '2D 360-deg Laser Scanner / VL53L0X ToF',
    model: 'RPLiDAR A1M8-R6 + VL53L0X Fail-Safe Front Sensor',
    priority: 'Recommended',
    rosTopic: '/scan',
    role: 'Nav2 Collision Monitor + fail-safe SENSOR_FAULT detection (-1 read halts rover immediately).',
    defaultInstalled: true,
  },
  {
    id: 'nav_cam',
    component: 'Forward Navigation Camera',
    model: 'Svpro 2MP AR0234 Global Shutter (120 deg)',
    priority: 'Recommended',
    rosTopic: '/nav_camera/image_raw',
    role: 'Dedicated forward crop-row visual servoing (ExG + Otsu) independent of downward detection camera.',
    defaultInstalled: true,
  },
  {
    id: 'estop',
    component: 'Hardware E-Stop Relay Rail',
    model: 'Dual-channel Mushroom Relay (ESP32 GPIO 13 Sense)',
    priority: 'Essential',
    rosTopic: '/safety/hardware_estop_ok',
    role: 'Physically cuts motor rail independent of RPi 5, ROS 2, or AI layer; enforced in ESP32 50 Hz loop.',
    defaultInstalled: true,
  },
];

export interface CommissioningStage {
  stage: number;
  title: string;
  deliverable: string;
  packages: string[];
  validationCriteria: string;
  status: 'Implemented' | 'Ready for Field Test';
}

export const COMMISSIONING_STAGES: CommissioningStage[] = [
  {
    stage: 1,
    title: 'Honest Navigation Simulation & Audit Suite',
    deliverable: 'Production build_navigation_stack() exercised in run_field_sim.py + 8 unit tests (NAV-01..12)',
    packages: ['Navigation/src', 'Navigation/tests', 'Navigation/sim'],
    validationCriteria: '8/8 audit tests pass; serpentine field sim achieves 99.9% coverage with 0 faults and 0 boundary exits.',
    status: 'Implemented',
  },
  {
    stage: 2,
    title: 'ESP32 Closed-Loop Firmware & Single Serial Bus',
    deliverable: 'Non-blocking 50 Hz PID firmware, quadrature ISRs, 250 ms watchdog, GPIO 13 E-stop, shared ESP32Bridge',
    packages: ['Navigation/esp32_firmware', 'rover_hardware/esp32_bridge'],
    validationCriteria: '1.0 m straight run error < 2 cm on bench; instant halt on serial drop, -1 sensor fault, or E-stop open.',
    status: 'Implemented',
  },
  {
    stage: 3,
    title: 'Encoder + IMU + Landmark / RTK Localization',
    deliverable: 'FieldLocalizer + ROS 2 robot_localization dual-EKF + slip residual fault detection',
    packages: ['Navigation/src/localizer.py', 'rover_localization'],
    validationCriteria: '90-deg turn heading error < 1.5 deg on soil; slip > 12 cm triggers FAULT until explicit re-localization.',
    status: 'Implemented',
  },
  {
    stage: 4,
    title: 'Navigation-Only Crop-Row Following (Milestone 1)',
    deliverable: 'ExG + Otsu detector, Stanley controller, RowNavigator & FieldBoundaryGuard (Treatment Detached)',
    packages: ['crop_row_navigation', 'Navigation/src/row_navigator.py'],
    validationCriteria: 'Rover follows crop rows centered within +/- 4 cm, enforces boundary margin, and checkpoints per-row coverage.',
    status: 'Ready for Field Test',
  },
  {
    stage: 5,
    title: 'Nav2 Headland Turns & Safe Obstacle Hold',
    deliverable: 'RegulatedPurePursuit + SmacPlanner2D + Collision Monitor + OBSTACLE_HOLD (no blind auto-dodge)',
    packages: ['rover_navigation', 'Navigation/src/state_machine.py'],
    validationCriteria: 'Smooth headland U-turn into Row N+1; unknown obstacle enters OBSTACLE_HOLD without deviating into crops.',
    status: 'Implemented',
  },
  {
    stage: 6,
    title: 'Modular Treatment Hook Integration (Future Flame / Grinder)',
    deliverable: 'Abstract stationary treatment_hook callback in RoverStateMachine (legacy laser retired)',
    packages: ['Navigation/src/state_machine.py', 'robot_safety'],
    validationCriteria: 'Treatment callback fires strictly when wheel velocity == 0 and navigation remains 100% runnable without it.',
    status: 'Implemented',
  },
  {
    stage: 7,
    title: 'AI Tool-Calling Mission Commander',
    deliverable: 'Validated ROS 2 Action/Service dispatcher (9 bounded tools, zero PWM / E-stop access)',
    packages: ['rover_navigation/mission_actions.py'],
    validationCriteria: 'Mission Supervisor rejects unsafe speeds/PWM calls and streams structured Action progress.',
    status: 'Implemented',
  },
];

export interface Ros2ToolDef {
  name: string;
  ros2Interface: string;
  category: 'Nav2 Standard' | 'Custom Action' | 'Custom Service' | 'Forbidden Test';
  description: string;
  defaultParams: Record<string, unknown>;
}

export const ROS2_TOOLS: Ros2ToolDef[] = [
  {
    name: 'start_navigation_mission',
    ros2Interface: 'ExecuteNavigationMission (Action)',
    category: 'Custom Action',
    description: 'Start a supervised multi-row navigation mission with FieldBoundaryGuard, sensor health gate, and checkpointing.',
    defaultParams: { field_id: 'field_01', start_row: 1, end_row: 4, speed_limit_mps: 0.15, enable_treatment_hook: false },
  },
  {
    name: 'follow_crop_row',
    ros2Interface: 'FollowCropRow (Action)',
    category: 'Custom Action',
    description: 'Follow a single crop row using forward visual servoing (ExG + Otsu + Stanley) until row end.',
    defaultParams: { row_id: 1, speed_limit_mps: 0.15 },
  },
  {
    name: 'navigate_to_pose',
    ros2Interface: 'nav2_msgs/action/NavigateToPose',
    category: 'Nav2 Standard',
    description: 'Drive autonomously to a single target pose inside the field boundary polygon via Nav2.',
    defaultParams: { x_m: 1.5, y_m: 0.9, yaw_deg: 0 },
  },
  {
    name: 'follow_waypoints',
    ros2Interface: 'nav2_msgs/action/FollowWaypoints',
    category: 'Nav2 Standard',
    description: 'Visit an ordered list of local map poses sequentially.',
    defaultParams: { waypoints: [[0.5, 0.3, 0], [4.0, 0.3, 0], [4.0, 0.9, 180]] },
  },
  {
    name: 'follow_gps_waypoints',
    ros2Interface: 'nav2_msgs/action/FollowGPSWaypoints',
    category: 'Nav2 Standard',
    description: 'Follow RTK-GNSS global coordinates for field entry, geofencing, and return-to-home.',
    defaultParams: { gps_waypoints: [[23.81031, 90.41252], [23.81042, 90.41252]] },
  },
  {
    name: 'navigate_through_poses',
    ros2Interface: 'nav2_msgs/action/NavigateThroughPoses',
    category: 'Nav2 Standard',
    description: 'Execute a continuous headland U-turn trajectory into the adjacent crop row.',
    defaultParams: { poses: [[8.85, 0.3, 90], [8.85, 0.9, 180], [7.85, 0.9, 180]] },
  },
  {
    name: 'pause_and_checkpoint',
    ros2Interface: 'PauseMission (Service)',
    category: 'Custom Service',
    description: 'Cancel active Nav2/RowNavigator goals, command zero velocity, and flush atomic JSON mission checkpoint (NAV-12).',
    defaultParams: { save_checkpoint: true },
  },
  {
    name: 'recover_from_fault',
    ros2Interface: 'RecoverNavigation (Service)',
    category: 'Custom Service',
    description: 'Explicitly clear FAULT state after validating obstacle sensor health and landmark re-localization pose (NAV-10).',
    defaultParams: { relocalize_x_cm: 120.0, relocalize_y_cm: 90.0, relocalize_yaw_deg: 0.0 },
  },
  {
    name: 'get_robot_status',
    ros2Interface: 'GetRobotStatus (Service)',
    category: 'Custom Service',
    description: 'Query fused pose, slip residual, obstacle sensor health, E-stop state, and verified row coverage %.',
    defaultParams: {},
  },
  {
    name: 'motor_pwm_override',
    ros2Interface: 'BLOCKED BY SUPERVISOR',
    category: 'Forbidden Test',
    description: 'Safety boundary test: verify Mission Supervisor rejects direct motor PWM or E-stop bypass calls.',
    defaultParams: { left_duty: 220, right_duty: 220, bypass_estop: true },
  },
];

export const WORKSPACE_SNIPPETS: Record<string, { path: string; summary: string; code: string }> = {
  state_machine: {
    path: 'Navigation/src/state_machine.py',
    summary: 'Fail-safe navigation state machine: SENSOR_FAULT halt (-1), OBSTACLE_HOLD, explicit recover(), and decoupled treatment_hook.',
    code: `# Fail-safe obstacle check (NAV-05 & NAV-09)
obs = self.obstacle_sensor.read_status()
if obs.status == ObstacleState.SENSOR_FAULT:
    self._enter_fault(f"OBSTACLE_SENSOR_FAULT: {obs.reason}")
    return self.state
if obs.status == ObstacleState.OBSTACLE:
    self.rover.stop()
    self.state = RoverState.OBSTACLE_HOLD  # Safe hold — never blind auto-dodge
    return self.state

def recover(self, relocalize_pose=None) -> bool:
    """Explicit recovery gate required to leave FAULT (NAV-10)."""
    if relocalize_pose is not None:
        self.rover.localizer.apply_landmark_correction(*relocalize_pose)
    if self.obstacle_sensor.read_status().status == ObstacleState.SENSOR_FAULT:
        return False
    self.fault_reason = None
    self.state = RoverState.NAVIGATING
    return True`,
  },
  localizer: {
    path: 'Navigation/src/localizer.py',
    summary: 'Fuses quadrature wheel ticks + BNO055 IMU yaw + ArUco/landmark pose corrections with slip fault detection (NAV-01..03).',
    code: `# Fuse encoder displacement with IMU absolute heading
d_center = 0.5 * (d_left_cm + d_right_cm)
d_theta_enc = (d_right_cm - d_left_cm) / (self.wheel_sep_cm * self.skid_mult)
if imu_yaw_deg is not None:
    d_theta_imu = wrap_angle_deg(imu_yaw_deg - self.heading_deg)
    # Detect excessive wheel slip between encoder yaw and IMU yaw
    slip_err_cm = abs(math.radians(d_theta_imu - d_theta_enc)) * (self.wheel_sep_cm * 0.5)
    self.slip_residual_cm = 0.7 * self.slip_residual_cm + slip_err_cm
    self.heading_deg = imu_yaw_deg`,
  },
  esp32: {
    path: 'Navigation/esp32_firmware/rover_firmware.py',
    summary: 'Non-blocking 50 Hz closed-loop velocity PID, quadrature encoder ISRs, 250 ms watchdog, GPIO 13 E-stop & portable PWM.',
    code: `# Non-blocking 50 Hz control loop (HW-06, HW-07, HW-08)
if not self.estop_ok() or (now_ms - self.last_cmd_ms) > WATCHDOG_MS:
    self.force_stop()
    return
meas_l = ((self.left_ticks - self.prev_l) * RAD_PER_TICK) / dt_s
meas_r = ((self.right_ticks - self.prev_r) * RAD_PER_TICK) / dt_s
duty_l = self.pid_l.compute(self.target_l, meas_l, dt_s)
duty_r = self.pid_r.compute(self.target_r, meas_r, dt_s)
self._apply_motor_pwm(duty_l, duty_r)`,
  },
  boundary: {
    path: 'Navigation/src/field_boundary.py',
    summary: 'Polygon geofence with robot footprint margin + pre-move projection gate (NAV-08).',
    code: `def is_move_safe(self, x_cm: float, y_cm: float, heading_deg: float, step_cm: float) -> bool:
    rad = math.radians(heading_deg)
    nx = x_cm + step_cm * math.cos(rad)
    ny = y_cm + step_cm * math.sin(rad)
    return self.is_inside(nx, ny, apply_margin=True)`,
  },
  urdf: {
    path: 'ros2_ws/src/rover_description/urdf/weed_laser_robot.urdf.xacro',
    summary: 'Reconciles 4 physical wheels with paired 2-channel ros2_control + IMU, LiDAR, forward nav cam & RTK-GNSS.',
    code: `<ros2_control name="WeedRoverSystem" type="system">
  <hardware>
    <plugin>rover_hardware/Esp32DiffDriveHardware</plugin>
    <param name="serial_port">/dev/ttyUSB0</param>
    <param name="enc_ticks_per_rev">17280</param>
    <param name="watchdog_timeout_ms">250</param>
  </hardware>
  <!-- diff_drive_controller couples FL+RL and FR+RR -->
  <joint name="front_left_wheel_joint">  <command_interface name="velocity"/> </joint>
  <joint name="rear_left_wheel_joint">   <command_interface name="velocity"/> </joint>
  <joint name="front_right_wheel_joint"> <command_interface name="velocity"/> </joint>
  <joint name="rear_right_wheel_joint">  <command_interface name="velocity"/> </joint>
</ros2_control>`,
  },
  nav2: {
    path: 'ros2_ws/src/rover_navigation/nav2_params.yaml',
    summary: 'RegulatedPurePursuit + SmacPlanner2D + LiDAR Costmaps + Collision Monitor stop/slowdown polygons.',
    code: `collision_monitor:
  ros__parameters:
    cmd_vel_in_topic: "/cmd_vel_nav"
    cmd_vel_out_topic: "/cmd_vel_safe"
    polygons: ["PolygonStop", "PolygonSlow"]
    PolygonStop:
      type: "polygon"
      points: "[[0.30, 0.14], [0.30, -0.14], [-0.18, -0.14], [-0.18, 0.14]]"
      action_type: "stop"`,
  },
};

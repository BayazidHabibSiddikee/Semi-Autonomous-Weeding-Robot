# Navigation & Hardware Audit Test Cases (`docs/TEST_CASES.md`)

This document specifies the **22 core automated navigation, firmware, safety, and Pi API test cases** implemented in `Navigation/tests/test_navigation_audit.py`, detailing their exact assertions, **expected physical outcomes** on the Raspberry Pi 4 + ESP32 rover, **failure conditions**, and how each test maps to **`HardwareAuditView`** validation gates.

```bash
# Execute the full navigation audit test suite (zero physical hardware required)
python3 -m unittest Navigation/tests/test_navigation_audit.py -v
```

---

## Quick Index — 22 Core Navigation & Safety Test Cases

| ID | Test Function (`test_navigation_audit.py`) | Audit Ref | Subsystem | `HardwareAuditView` Validation Signal |
|----|-------------------------------------------|-----------|-----------|---------------------------------------|
| TC-01 | `test_nav01_nav02_closed_loop_encoder_and_imu_turn` | NAV-01, NAV-02 | `FieldLocalizer`, `RoverController` | Encoder + IMU closed-loop readiness |
| TC-02 | `test_nav03_nav10_slip_fault_and_explicit_relocalization` | NAV-03, NAV-10 | `FieldLocalizer` | Localization slip fault lock & recovery gate |
| TC-03 | `test_nav05_invalid_sensor_reading_enters_fault_and_stops` | NAV-05 | `ObstacleSensor`, `RoverStateMachine` | Fail-closed `-1` sensor fault halt |
| TC-04 | `test_nav06_single_shared_esp32_bridge` | NAV-06 | `ESP32Bridge` | Single USB serial port (`/dev/ttyUSB0`) |
| TC-05 | `test_nav08_field_boundary_guard_blocks_exit` | NAV-08 | `FieldBoundaryGuard` | Perimeter containment interlock |
| TC-06 | `test_nav09_unknown_obstacle_safe_hold_no_autododge` | NAV-09 | `RoverStateMachine` | Safe `OBSTACLE_HOLD` (no crop-damaging dodge) |
| TC-07 | `test_nav04_nav07_nav11_nav12_full_serpentine_coverage_and_checkpoint` | NAV-04/07/11/12 | `RowNavigator`, `MissionTracker` | Serpentine coverage & checkpoint persistence |
| TC-08 | `test_hw06_hw07_firmware_validation_and_watchdog` | HW-06, HW-07 | `RoverFirmwareController` | ESP32 command validation & 250 ms watchdog |
| TC-09 | `test_audit26_1a_no_virtual_pose_without_physical_encoders` | AUD-26 1A | `HardenedNavigationController` | Zero virtual pose advancement check |
| TC-10 | `test_audit26_1c_camera_failure_causes_immediate_stop_no_blind_move` | AUD-26 1C | `CameraHealthMonitor` | Camera Readiness Audit (`CAMERA_LOSS` stop) |
| TC-11 | `test_audit26_1d_3c_3d_one_shot_target_lifecycle_and_crop_rejection` | AUD-26 1D/3C/3D | `TargetExecutionManager` | One-shot weed lifecycle & crop rejection |
| TC-12 | `test_audit26_1e_estop_latch_and_unverified_ack_returns_503` | AUD-26 1E | `pi_server.py`, `ESP32Bridge` | Verified E-stop ACK (`503` Fail-Closed badge) |
| TC-13 | `test_audit26_2b_2c_3a_launch_interlocks_and_sample_image_guard` | AUD-26 2B/2C/3A | `HardenedNavigationController` | Pre-flight `412 Gate` & live-source guard |
| TC-14 | `test_audit_c_cold_boot_standby_and_explicit_watchdog_recovery` | AUD-C | Firmware & Pi `/recover` | Cold-boot standby & manual recovery lock |
| TC-15 | `test_audit_b_camera_ingestion_visual_row_end_and_background_worker` | AUD-B | `BackgroundControlWorker` | Pi Cam Monitor frame counter & row-end trigger |
| TC-16 | `test_audit_d_imu_heading_wired_into_navigation_stack` | AUD-D | `bno055_imu.py`, `rover_main.py` | BNO055 IMU wired into navigation stack |
| TC-17 | `test_audit_e_ros2_colcon_workspace_manifests_and_collision_monitor_wiring` | AUD-E | `ros2_ws/` | ROS 2 package & Collision Monitor integrity |
| TC-18 | `test_audit_f_detections_remain_fail_closed_until_calibrated_and_loaded` | AUD-F | `pi_server.py`, `TargetExecutionManager` | Detection `412` gate (model + homography) |
| TC-19 | `test_startup_handshake_read_only_never_clears_latch_automatically` | Safety Gate | `StartupHandshakeService`, `/handshake` | `SAFE SCAN (READ-ONLY)` + `Confirm Hardware Recovery` |
| TC-20 | `test_startup_handshake_unlocks_dispatch_when_camera_healthy` | Safety Gate | `StartupHandshakeService`, `/handshake` | `NAV DISPATCH LOCKED` → `NAV DISPATCH UNLOCKED` |
| TC-21 | `test_async_control_loop_worker_drives_mission_continuously` | Backend Loop | `AsyncControlLoopWorker` | Lifespan worker running continuously |
| TC-22 | `test_global_app_boot_survives_unplugged_usb_esp32_fail_closed` | Boot Safety | Global FastAPI `app` | Unplugged USB fail-closed (`ESP32_NOT_CONNECTED`) |

---

## Group A — Closed-Loop Motion, Localization & Field Containment

### TC-01: `test_nav01_nav02_closed_loop_encoder_and_imu_turn`
- **Test Stimulus**: Commands a `25.0 cm` straight displacement at `0.0°` heading followed by a closed-loop in-place rotation to `90.0°` via `RoverController.move_distance()` and `rotate_to_heading()`.
- **Expected Physical Outcome**:
  - Rover drives straight along the furrow by `25.0 cm ± 1.5 cm` with lateral drift bounded within `±1.5 cm`, stopping cleanly via encoder tick feedback.
  - Rover rotates to `90.0° ± 3.0°` using fused IMU/encoder heading feedback and zeroes motor velocities upon convergence.
- **HardwareAuditView Validation**: Confirms NAV-01/NAV-02 closed-loop encoder displacement and IMU turn tracking are active.
- **Failure Conditions**:
  - Displacement error exceeds `±1.5 cm` or lateral drift exceeds `±1.5 cm`.
  - Final heading deviates by more than `±3.0°` from `90.0°`, or motion returns `ok=False`.

### TC-02: `test_nav03_nav10_slip_fault_and_explicit_relocalization`
- **Test Stimulus**: Drives `FieldLocalizer(max_slip_residual_cm=5.0)` straight on encoders (`dl == dr`) while injecting a sudden `50°` IMU yaw discrepancy, then calls `apply_landmark_correction(x=38.0, y=30.0, heading=0.0, gain=1.0)`.
- **Expected Physical Outcome**:
  - On wet mud or loose soil where wheel encoders disagree with IMU yaw beyond `5.0 cm` residual, localization flips to `localized=False`, halting autonomous row driving rather than drifting into crop rows.
  - Only an explicit landmark/ArUco pose correction restores `localized=True` at the verified coordinates (`±0.1 cm`).
- **HardwareAuditView Validation**: Slip fault triggers a locked fault condition requiring explicit operator validation/re-localization before resuming.
- **Failure Conditions**:
  - `pose.localized` remains `True` after a `50°` encoder-vs-IMU yaw divergence.
  - Landmark correction fails to restore `localized=True` or drifts beyond `±0.1 cm` of the observed pose.

### TC-03: `test_nav05_invalid_sensor_reading_enters_fault_and_stops`
- **Test Stimulus**: During active `NAVIGATING_ROW`, injects an invalid ultrasonic/ToF distance reading (`distance = -1`), ticks `RoverStateMachine`, attempts plain `resume()`, then restores `distance = 900` and invokes `recover()`.
- **Expected Physical Outcome**:
  - Motor PWM drops immediately to zero on the first `-1` reading; rover does not advance by a single tick and latches into `RoverState.FAULT` (`OBSTACLE_SENSOR_FAULT`).
  - Pressing plain Resume while faulted is rejected (`ok=False`).
  - Once sensor returns valid readings (`900 mm`), validated `recover()` transitions strictly to `PAUSED` (never auto-driving).
- **HardwareAuditView Validation**: Displays `OBSTACLE_SENSOR_FAULT` blocker and locks navigation dispatch until sensor telemetry is valid and recovered.
- **Failure Conditions**:
  - Rover moves forward on a `-1` sensor reading (treating `-1` as "no obstacle").
  - State fails to enter `FAULT`, plain `resume()` succeeds from `FAULT`, or `recover()` auto-starts motion instead of holding in `PAUSED`.

### TC-04: `test_nav06_single_shared_esp32_bridge`
- **Test Stimulus**: Builds the full navigation stack via `build_navigation_stack()` and verifies object identity (`sm.rover.bridge is esp32`).
- **Expected Physical Outcome**:
  - Motor velocity commands, E-stop halts, encoder reads, and distance queries share a single synchronized USB serial port (`/dev/ttyUSB0`), preventing corrupted UART frames or `Resource busy` lockups on the Raspberry Pi 4.
- **HardwareAuditView Validation**: USB Auto-Detect displays a single active ESP32 serial handle with clean `PING`/`TELEM?` exchanges.
- **Failure Conditions**:
  - Multiple competing `ESP32Bridge` instances open the same USB port (`sm.rover.bridge is not esp32`).

### TC-05: `test_nav08_field_boundary_guard_blocks_exit`
- **Test Stimulus**: Constructs a `300 cm × 200 cm` `FieldBoundaryGuard` with `15.0 cm` safety margin; checks interior pose `(50, 50)`, margin-violating pose `(10, 50)`, and a forward `15.0 cm` step from `(280, 50)` toward the boundary.
- **Expected Physical Outcome**:
  - Rover is permitted to operate inside the buffered field polygon and is hard-blocked from driving within `15.0 cm` of any perimeter edge or exiting the field during headland turns.
- **HardwareAuditView Validation**: NAV-08 boundary guard status marked enforced; boundary violations raise a fault lock.
- **Failure Conditions**:
  - Out-of-margin pose `(10, 50)` or boundary-crossing step `(280 + 15 = 295 > 285)` returns `inside=True`.

### TC-06: `test_nav09_unknown_obstacle_safe_hold_no_autododge`
- **Test Stimulus**: During `NAVIGATING_ROW`, injects an obstacle at `220 mm` (`< 350 mm` stop threshold), ticks the state machine, then clears the obstacle to `900 mm` and ticks again.
- **Expected Physical Outcome**:
  - Rover brakes immediately to zero velocity in `OBSTACLE_HOLD` without steering laterally out of the furrow (protecting adjacent crop rows from blind auto-dodging).
  - Once the obstacle clears (`900 mm`), rover cleanly resumes `NAVIGATING_ROW`.
- **HardwareAuditView Validation**: Reflects `OBSTACLE_HOLD` safely without triggering uncommanded lateral steering.
- **Failure Conditions**:
  - Rover position or heading changes while obstacle is at `220 mm`, fails to enter `OBSTACLE_HOLD`, or fails to resume once cleared to `900 mm`.

### TC-07: `test_nav04_nav07_nav11_nav12_full_serpentine_coverage_and_checkpoint`
- **Test Stimulus**: Starts a serpentine multi-row mission, pauses after 15 ticks, verifies JSON checkpoint file creation and non-zero coverage load (`MissionTracker.load_checkpoint()`), resumes, and runs to completion (`max_ticks=400`).
- **Expected Physical Outcome**:
  - Pausing saves exact row/progress state atomically to disk so power/operator interruptions do not restart from Row 1.
  - Resuming completes all rows (`unfinished_rows == []`), executes `num_rows - 1` closed-loop three-stage headland transitions, reaches `RoverState.DONE`, and achieves `>= 95.0%` total field coverage.
- **HardwareAuditView Validation**: Validates end-to-end serpentine mission coverage (`99.9%` in field sim) and checkpoint recovery readiness.
- **Failure Conditions**:
  - Checkpoint file missing or empty after pause, `resume()` fails from `PAUSED`, rows remain unfinished, row transitions do not match `num_rows - 1`, or coverage falls below `95.0%`.

---

## Group B — Firmware Safety, Physical Pose Integrity & Sensor Fail-Safes

### TC-08: `test_hw06_hw07_firmware_validation_and_watchdog`
- **Test Stimulus**: Sends valid (`VEL 1.5 1.5`), out-of-range (`VEL 99.0 0.0`), malformed (`VEL bad args`), and unknown (`INVALID_CMD`) commands to `RoverFirmwareController`; then advances silence by `400 ms` (`> 250 ms` watchdog) and tests `VEL` before and after `CLEAR_LATCH`.
- **Expected Physical Outcome**:
  - ESP32 rejects unsafe velocity magnitudes (`ERR:RANGE`), parse errors (`ERR:PARSE`), and unknown commands (`ERR:UNKNOWN`) without glitching PWM.
  - After `> 250 ms` of host silence, ESP32 zeroes motor targets (`0.0, 0.0`), trips `watchdog_tripped=True`, and rejects `VEL` with `ERR:WATCHDOG_LATCHED` until an explicit `CLEAR_LATCH` returns `OK:LATCH_CLEARED`.
- **HardwareAuditView Validation**: Safety Latch tile displays `LOCKED (AUTH REQ)` whenever `watchdog_ok=0` and refuses motion commands until manually cleared.
- **Failure Conditions**:
  - Out-of-range/malformed command accepted, watchdog fails to trip after `400 ms`, motor targets remain non-zero, or `VEL`/`PING` silently clears a tripped watchdog latch.

### TC-09: `test_audit26_1a_no_virtual_pose_without_physical_encoders`
- **Test Stimulus**: Sets physical wheel slip factor to `0.0` (frozen wheels / disconnected encoders), commands `send_velocity(4.0, 4.0)` for `0.5 s`, updates `FieldLocalizer` from ESP32 telemetry, and compares `pose_measured` before vs. after.
- **Expected Physical Outcome**:
  - If the rover's wheels are jammed, stalled, or lifted without encoder rotation, the reported field map position `(x_cm, y_cm)` does **not** advance (`delta <= 0.01 cm`). Zero "virtual" dead-reckoning progress is fabricated from motor commands.
- **HardwareAuditView Validation**: Guarantees `PI LIVE` pose telemetry is strictly hardware-measured.
- **Failure Conditions**:
  - `pose_measured.x_cm` or `y_cm` shifts by `> 0.01 cm` when wheel encoder ticks remain unchanged.

### TC-10: `test_audit26_1c_camera_failure_causes_immediate_stop_no_blind_move`
- **Test Stimulus**: Starts a valid `nav_only=True` mission with fresh camera frames, then records 2 consecutive camera read failures and runs `step_control_loop()`.
- **Expected Physical Outcome**:
  - Rover immediately sends `STOP` to the ESP32, sets `mission_active=False`, latches `RoverState.FAULT` with `CAMERA_LOSS`, and advances zero distance blindly.
- **HardwareAuditView Validation**: Camera Readiness Audit transitions to `CAMERA ACTION NEEDED` / unhealthy, and `NAV DISPATCH LOCKED` engages.
- **Failure Conditions**:
  - Rover continues moving after camera failure, `mission_active` stays `True`, or state fails to enter `FAULT` with `CAMERA_LOSS`.

### TC-11: `test_audit26_1d_3c_3d_one_shot_target_lifecycle_and_crop_rejection`
- **Test Stimulus**: Tests `TargetExecutionManager` without homography, then with a calibrated 3×3 homography (`dedup_radius_mm=45.0`): submits `crop_tomato`, a valid `weed_dandelion`, a near-duplicate pixel detection, attempts execution while moving (`12.0 cm/s`), executes while stationary (`0.0 cm/s`), and re-submits the same weed on the next frame.
- **Expected Physical Outcome**:
  - Uncalibrated targeting is hard-blocked (`REJECTED_UNCALIBRATED_HOMOGRAPHY`).
  - Protected crop classes (`crop_*`) are hard-rejected (`REJECTED_PROTECTED_CROP`) and never enter the actuator queue.
  - Physical treatment actuator refuses to fire while the rover is moving (`ROVER_NOT_STATIONARY`), fires **at most once** while stationary, transitions target to `CONSUMED`, and deduplicates subsequent camera frames of the same weed (`DEDUPLICATED_EXISTING_TARGET`).
- **HardwareAuditView Validation**: Confirms one-shot target lifecycle and crop-protection interlocks before any treatment hardware can be enabled.
- **Failure Conditions**:
  - Any crop class accepted, uncalibrated pixel-to-mm guess allowed, actuator fires while `rover_speed_cms > 0`, or the same weed is actuated/counted more than once.

### TC-12: `test_audit26_1e_estop_latch_and_unverified_ack_returns_503`
- **Test Stimulus**: Verifies firmware `ESTOP` → `OK:ESTOP_LATCHED` rejects subsequent `VEL` until `CLEAR_LATCH`; then tests Pi `handle_stop()` with ESP32 disconnected (`connected=False`) vs. connected (`connected=True`).
- **Expected Physical Outcome**:
  - When the ESP32 USB link is intact, `POST /stop` halts motors, latches hardware E-stop, and returns **HTTP `200`** with `ack_verified=True`, `estop_latched=True`.
  - If USB disconnects or UART ACK fails, `POST /stop` **never fakes success** — it returns **HTTP `503`** (`stopped=False`, `ack_verified=False`) instructing the operator to engage the physical power cutoff immediately.
- **HardwareAuditView Validation**: Safety Interlocks readout displays `FAIL-CLOSED (503 Unverified E-Stop · 412 Gate)`.
- **Failure Conditions**:
  - `POST /stop` returns HTTP `200` when ESP32 is disconnected or unacknowledged, or `VEL` succeeds while E-stop is latched.

### TC-13: `test_audit26_2b_2c_3a_launch_interlocks_and_sample_image_guard`
- **Test Stimulus**: Calls `handle_start_mission(nav_only=False)` with missing camera/model/homography; then switches `simulate=False` (live hardware) and attempts `handle_start_mission(source_type="sample", image_url="/media/field_render.png")`.
- **Expected Physical Outcome**:
  - Mission launch fails closed with **HTTP `412`** listing exact blockers (`CAMERA_UNHEALTHY`, `WEED_MODEL_NOT_LOADED`, `HOMOGRAPHY_NOT_CALIBRATED`).
  - Sample/demo images are permanently blocked on live hardware (`SAMPLE_IMAGE_FORBIDDEN_ON_LIVE_HARDWARE`), preventing demo UI imagery from ever driving real rover motors.
- **HardwareAuditView Validation**: `NAV DISPATCH LOCKED` badge lists active pre-flight blockers.
- **Failure Conditions**:
  - Mission starts (HTTP `200`) despite missing camera/model/homography, or a sample/demo image source is accepted when `simulate=False`.

---

## Group C — Cold-Boot Watchdog, Camera Ingestion, IMU Fusion, ROS 2 & Targeting Gates

### TC-14: `test_audit_c_cold_boot_standby_and_explicit_watchdog_recovery`
- **Test Stimulus**: Simulates ESP32 powering on `2000 ms` before the Pi connects (cold boot), sends initial `PING`, then simulates `400 ms` silence after sync, and tests Pi `handle_recover(operator_confirmed=False)` vs. `handle_recover(operator_confirmed=True)`.
- **Expected Physical Outcome**:
  - During cold boot before the Pi boots, the ESP32 holds motors safely at `0.0` without tripping a phantom watchdog fault; initial `PING` returns `PONG 1 1` and syncs host monitoring.
  - Once synced, `> 250 ms` host silence latches the watchdog (`PONG 1 0`, `ERR:WATCHDOG_LATCHED`).
  - Pi `/recover` rejects unconfirmed requests (**HTTP `400`**) and requires `operator_confirmed=True` to clear the latch and land strictly in `RoverState.PAUSED`.
- **HardwareAuditView Validation**: Prevents false watchdog lockouts on clean power-up while enforcing explicit operator recovery after real mid-run link drops.
- **Failure Conditions**:
  - Cold boot produces phantom watchdog trip or non-zero motor output; post-sync silence fails to latch; or `/recover` succeeds when `operator_confirmed=False`.

### TC-15: `test_audit_b_camera_ingestion_visual_row_end_and_background_worker`
- **Test Stimulus**: Confirms `camera_healthy=False` initially, ingests a live JPEG frame with `visual_row_end_conf=0.92`, starts a `nav_only` mission, steps the loop, and runs `BackgroundControlWorker(hz=25.0)` for `180 ms`.
- **Expected Physical Outcome**:
  - Live frame ingestion transitions `CameraHealthMonitor` to healthy and routes high visual row-end confidence (`0.92`) directly into `RoverStateMachine`, triggering `HEADLAND_TURN` at the end of a crop row.
  - Background worker thread executes continuous closed-loop ticks autonomously (`worker_ticks` increments).
- **HardwareAuditView Validation**: `Pi Cam Monitor` transitions from `AWAITING FRAMES` to `HEALTHY` with live `frames_ingested` count.
- **Failure Conditions**:
  - `camera_healthy` stays `False` after valid frame ingestion, `visual_row_end_conf=0.92` fails to trigger `HEADLAND_TURN`, or worker thread fails to increment `worker_ticks`.

### TC-16: `test_audit_d_imu_heading_wired_into_navigation_stack`
- **Test Stimulus**: Builds the stack and verifies `imu_heading_fn` and `imu_sensor` are wired; drives `8 cm`, injects a `60°` yaw offset on the IMU sensor, drives another `8 cm`, and reads `pose.slip_residual_cm`.
- **Expected Physical Outcome**:
  - The BNO055 IMU heading feed is actively fused inside the navigation stack and immediately flags skid-steer slippage (`slip_residual_cm > 5.0 cm`) on real dirt.
- **HardwareAuditView Validation**: Confirms `imu_connected: true` in Pi hardware telemetry.
- **Failure Conditions**:
  - `imu_heading_fn` or `imu_sensor` is `None`, or a `60°` yaw divergence fails to raise `slip_residual_cm > 5.0 cm`.

### TC-17: `test_audit_e_ros2_colcon_workspace_manifests_and_collision_monitor_wiring`
- **Test Stimulus**: Parses XML manifests (`package.xml`), `setup.py`, `setup.cfg`, and ament resource markers across all 8 packages in `ros2_ws/src/`, and inspects `rover_bringup.launch.py` for `nav2_collision_monitor`, `/cmd_vel_nav`, and `/cmd_vel_safe`.
- **Expected Physical Outcome**:
  - All 8 ROS 2 packages (`crop_row_navigation`, `robot_bringup`, `robot_safety`, `rover_description`, `rover_hardware`, `rover_localization`, `rover_navigation`, `weeding_controller`) are colcon-buildable and route navigation velocity commands through `nav2_collision_monitor` before reaching motors.
- **HardwareAuditView Validation**: Ensures ROS 2 bringup safety chain matches the dashboard safety model.
- **Failure Conditions**:
  - Any package manifest/setup/resource file is missing or malformed, or `rover_bringup.launch.py` bypasses `nav2_collision_monitor` (`/cmd_vel_nav` → `/cmd_vel_safe`).

### TC-18: `test_audit_f_detections_remain_fail_closed_until_calibrated_and_loaded`
- **Test Stimulus**: Submits detections to `handle_detection()` with `model_loaded=False` (expects `412`), then `model_loaded=True` without homography (expects `412`), then loads a calibrated 3×3 homography and tests `crop_tomato` (rejected) vs. `weed_dandelion` (accepted).
- **Expected Physical Outcome**:
  - Zero weed targets can be queued before both verified detector weights AND 3×3 camera-to-ground homography calibration exist; once calibrated, protected crops are still strictly rejected while valid weeds are projected to ground millimeters.
- **HardwareAuditView Validation**: Confirms `model_loaded` and `homography_calibrated` flags stay fail-closed until explicitly verified.
- **Failure Conditions**:
  - Detections accepted before model load or homography calibration, or `crop_tomato` accepted into the target queue.

---

## Group D — Startup Handshake, Operator Recovery, Async Worker & Fail-Closed Boot

### TC-19: `test_startup_handshake_read_only_never_clears_latch_automatically`
- **Test Stimulus**: Places controller in latched watchdog (`watchdog_ok=False`) and `RoverState.FAULT`. Runs:
  1. Default read-only `handle_startup_handshake()` (`allow_clear_latch=False`)
  2. Unconfirmed `handle_startup_handshake(allow_clear_latch=True, operator_confirmed=False)`
  3. Confirmed `handle_startup_handshake(allow_clear_latch=True, operator_confirmed=True)`
- **Expected Physical Outcome**:
  - Opening or refreshing the Web App executes strictly `PING` + `TELEM?` (`inspection_only=True`, `clear_latch_attempted=False`) and **never clears** a tripped E-stop or watchdog latch (`latch_locked=True`, state stays `FAULT`).
  - Attempting `CLEAR_LATCH` without `operator_confirmed=True` returns **HTTP `400`** and leaves the latch locked.
  - Only explicit operator confirmation (`allow_clear_latch=True, operator_confirmed=True`) dispatches `CLEAR_LATCH`, validates `TELEM?`, clears the latch, and leaves the rover strictly **`PAUSED`** (`mission_active=False`).
- **HardwareAuditView Validation**:
  - Boot mount shows `SAFE SCAN (READ-ONLY)` badge and `Safety Latch: LOCKED (AUTH REQ)`.
  - **Confirm Hardware Recovery** button stays disabled until the operator checks the physical perimeter + GPIO 13 safety box; clicking it dispatches recovery and leaves the rover `PAUSED`.
- **Failure Conditions**:
  - `CLEAR_LATCH` appears in default startup steps, latch clears automatically on boot, unconfirmed clear returns HTTP `200`, or `mission_active` becomes `True` immediately after recovery.

### TC-20: `test_startup_handshake_unlocks_dispatch_when_camera_healthy`
- **Test Stimulus**: Ingests a valid camera frame, verifies unconfirmed clear is denied (`400`), then executes operator-confirmed recovery (`allow_clear_latch=True, operator_confirmed=True`).
- **Expected Physical Outcome**:
  - Navigation dispatch gate unlocks (`navigation_dispatch_unlocked=True`) **only** when BOTH the ESP32 watchdog/E-stop ready-state AND live camera health are simultaneously verified, while keeping `mission_active=False` until the operator clicks Start Mission.
- **HardwareAuditView Validation**: Top status pill transitions from `NAV DISPATCH LOCKED` (amber) to `NAV DISPATCH UNLOCKED` (emerald) only when ESP32 ready-state and Camera Readiness Audit both pass.
- **Failure Conditions**:
  - Dispatch unlocks while camera is unhealthy or while latch is still locked, or rover begins driving without an explicit Start Mission command.

### TC-21: `test_async_control_loop_worker_drives_mission_continuously`
- **Test Stimulus**: Ingests fresh camera frames, starts a `nav_only=True` mission, launches `AsyncControlLoopWorker(ctrl, hz=25.0)` inside `asyncio.run()`, keeps frames fresh for ~240 ms, then gracefully stops the worker.
- **Expected Physical Outcome**:
  - Under `uvicorn Navigation.src.pi_server:app`, the FastAPI lifespan asyncio task continuously advances closed-loop navigation ticks (`worker_ticks > 2`), updates measured encoder pose (`end_x > start_x`), and cancels cleanly on server shutdown without hanging.
- **HardwareAuditView Validation**: `/api/robot/status` reports `workerRunning: true` and continuously incrementing `worker_ticks`.
- **Failure Conditions**:
  - Worker task fails to start or cancel cleanly, `worker_ticks <= 2`, or measured rover pose fails to progress during an active mission with healthy encoders/camera.

### TC-22: `test_global_app_boot_survives_unplugged_usb_esp32_fail_closed`
- **Test Stimulus**: Configures `esp32_port = "/dev/nonexistent_esp32_port_xyz"`, instantiates `HardenedNavigationController(cfg, simulate=False)`, and calls `handle_start_mission(nav_only=True, operator_confirmed=True)`.
- **Expected Physical Outcome**:
  - Raspberry Pi FastAPI server boots cleanly without crashing even if the ESP32 USB cable is unplugged at startup (`esp32.connected == False`).
  - Attempting to launch a mission remains strictly fail-closed (**HTTP `412`** with `ESP32_NOT_CONNECTED`) until the physical USB cable is plugged in and verified.
- **HardwareAuditView Validation**: Boot scan stays reachable and reports `USB DISCONNECTED` / `NAV DISPATCH LOCKED` instead of crashing the Pi API server.
- **Failure Conditions**:
  - Module import or startup raises an unhandled `RuntimeError`/`SerialException` on unplugged USB, or `handle_start_mission()` succeeds when `esp32.connected` is `False`.

---

## Supplemental Hardening & Field-Video Tests (7 Additional Automated Tests → 29 / 29 PASS)

Beyond the 22 core navigation tests above, the suite includes 7 additional automated tests verifying recent hardening fixes and real outdoor footage:

| ID | Test Function | File | Scope |
|----|---------------|------|-------|
| TC-23 | `test_crop_row_vision_computes_row_end_and_lateral_error` | `test_navigation_audit.py` | Excess-Green (`ExG`) row-end & lateral error extraction from PNG frames |
| TC-24 | `test_multipart_image_upload_extraction_for_android_client` | `test_navigation_audit.py` | Android `multipart/form-data` `/image` upload parsing & BEV response fields |
| TC-25 | `test_load_weed_model_path_confinement_and_verification` | `test_navigation_audit.py` | `POST /model/load` directory confinement (`403` on traversal), extension allowlist & file verification |
| TC-26 | `test_execute_next_treatment_target_enforces_interlocks_and_stationary_stop` | `test_navigation_audit.py` | `POST /treatment/execute_next` HTTP `412` blocking by default + stationary stop before one-shot actuation |
| TC-27 | `test_bearer_token_authentication_verification` | `test_navigation_audit.py` | Constant-time `Authorization: Bearer <PI_API_TOKEN>` enforcement |
| TC-28 | `test_ros2_row_follow_action_server_structure` | `test_navigation_audit.py` | Real `rclpy.action.ActionServer` (`/follow_crop_row`) & `MultiThreadedExecutor` verification |
| TC-29 | `test_real_outdoor_field_video_exg_pipeline` | `test_field_video_vision.py` | 46-frame real outdoor soil/weed MP4 test (46/46 decoded, 371 weed clusters, white paper trash rejected) |

---

## `HardwareAuditView` Pre-Field Validation Sign-Off Criteria

Before moving the rover from a **wheels-off-ground stand** to live ground testing:

1. **Automated Suite**: `29 / 29 PASS` across `test_navigation_audit.py` and `test_field_video_vision.py`.
2. **Safe Boot Scan**: Opening `HardwareAuditView` logs `PING` + `TELEM? (READ-ONLY)` with zero automatic `CLEAR_LATCH` packets.
3. **Physical E-Stop Loop**: Opening GPIO 13 forces `Confirm Hardware Recovery` to fail; closing GPIO 13 + checking the safety box + clicking **Confirm Hardware Recovery** clears the latch and leaves the rover `PAUSED`.
4. **Verified Stop ACK**: Clicking **Emergency Stop** returns HTTP `200` with `ack_verified: true` from the physical ESP32 (and never silently succeeds if USB is unplugged).
5. **Camera Readiness**: `MaixSenseLatencyPulseIndicator` glows green (`< 100 ms` RTT), `/ws/camera` or Pi `/camera/frame` shows live ingested frames, and unplugging the camera halts a bench test within `0.5 s`.
6. **Nav-Only Default**: Keep **Nav-Only (Decoupled)** active until encoder ticks, IMU yaw, and headland turns are proven on flat ground.

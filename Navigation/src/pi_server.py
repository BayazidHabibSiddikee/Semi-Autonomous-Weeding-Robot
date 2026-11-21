"""
Hardened Closed-Loop Navigation Pi Server (Port 8000).

Resolves every Navigation, Firmware, Contract, and Safety finding:
  - 1A: ZERO virtual pose stepping. Rover pose (x, y, yaw) updates strictly from
        measured wheel encoder ticks + BNO055 IMU heading via FieldLocalizer.
  - 1B: Real 3-stage closed-loop headland crossing via RowNavigator (turn ->
        encoder-measured furrow translation -> opposite-row alignment).
  - 1C: CameraHealthMonitor fail-closed guard + real frame ingestion endpoints
        (POST /camera/frame and Android-compatible POST /image). Missing or stale
        (> 500 ms) frames immediately command STOP and transition to FAULT.
  - 1D: One-shot weed TargetExecutionManager with class whitelist, calibrated 3x3
        homography gate, spatial deduplication, bounded dwell, and cooldown.
  - 1E: POST /stop validates physical ESP32 ACK (OK:ESTOP_LATCHED / OK:STOPPED).
        Returns HTTP 503 if UART fails, times out, or returns unverified ACK.
  - 2B/3A: POST /start_mission enforces all 6 hardware launch interlocks AND keeps
        nav_only=True as safe default until real YOLO weights + homography are loaded.
  - Background worker thread runs step_control_loop() + ESP32 keepalive telemetry
        when mounted via FastAPI lifespan/startup, and exports a ready-made module
        `app` object so `uvicorn Navigation.src.pi_server:app --port 8000` works.
  - Explicit operator-authorized recovery endpoint (POST /recover) clears latched
        ESP32 watchdog/E-stop faults ONLY when `operator_confirmed=True` and physical
        GPIO 13 E-stop loop is closed.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass
from email.parser import BytesParser
from email.policy import default as email_default_policy
import hmac
import math
import os
import sys
import threading
import time
from typing import Any

sys.path.insert(0, os.path.dirname(__file__))

from config_loader import load_yaml_config
from crop_row_vision import analyze_crop_row_frame
from esp32_bridge import ESP32Bridge, ESP32Simulator, StopAckResult
from rover_main import build_navigation_stack
from state_machine import RoverState
from target_lifecycle import TargetExecutionManager
from ultrasonic import ObstacleStatus


SAMPLE_IMAGE_MARKERS = (
    "/media/field_render.png",
    "field_render.png",
    "field_render_live.png",
    "sample_field",
)

MAX_INGEST_FRAME_BYTES = 5 * 1024 * 1024  # 5 MB upper bound on uploaded JPEG/PNG frames
ALLOWED_MODEL_EXTENSIONS = (".pt", ".onnx", ".engine", ".tflite")


def extract_multipart_image(raw_body: bytes, content_type: str) -> tuple[bytes | None, str]:
    """
    Extract uploaded image bytes and MIME type from a multipart/form-data request
    using Python stdlib email.parser (no external python-multipart dependency required).
    """
    if not raw_body or "multipart/form-data" not in content_type.lower():
        return None, "image/jpeg"
    header_block = f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8")
    try:
        msg = BytesParser(policy=email_default_policy).parsebytes(header_block + raw_body)
    except Exception:
        return None, "image/jpeg"
    if not msg.is_multipart():
        return None, "image/jpeg"
    for part in msg.iter_parts():
        part_ct = (part.get_content_type() or "").lower()
        part_name = (part.get_param("name", header="content-disposition") or "").lower()
        filename = part.get_filename()
        if part_ct.startswith("image/") or filename or part_name in ("file", "image", "frame"):
            payload = part.get_payload(decode=True)
            if payload:
                mime = "image/png" if "png" in part_ct or (filename or "").lower().endswith(".png") else "image/jpeg"
                return payload, mime
    return None, "image/jpeg"


def verify_bearer_token(auth_header: str | None, expected_token: str | None) -> bool:
    """Constant-time verification of `Authorization: Bearer <token>` when PI_API_TOKEN is configured."""
    if not expected_token:
        return True
    if not auth_header:
        return False
    parts = auth_header.strip().split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return False
    supplied = parts[1].strip()
    if not supplied:
        return False
    return hmac.compare_digest(supplied, expected_token)


@dataclass
class CameraHealthStatus:
    attached: bool
    healthy: bool
    frame_age_s: float
    consecutive_read_failures: int
    reason: str


class CameraHealthMonitor:
    """Fail-closed navigation camera liveness monitor (Audit 1C)."""

    def __init__(self, max_frame_age_s: float = 0.5, max_read_failures: int = 2):
        self.max_frame_age_s = max_frame_age_s
        self.max_read_failures = max_read_failures
        self.attached = False
        self.last_valid_frame_ts = 0.0
        self.consecutive_read_failures = 0

    def record_frame_ok(self, now: float | None = None):
        self.attached = True
        self.consecutive_read_failures = 0
        self.last_valid_frame_ts = time.monotonic() if now is None else now

    def record_read_failure(self):
        self.consecutive_read_failures += 1

    def detach(self):
        self.attached = False
        self.consecutive_read_failures = self.max_read_failures

    def evaluate(self, now: float | None = None) -> CameraHealthStatus:
        ts = time.monotonic() if now is None else now
        if not self.attached:
            return CameraHealthStatus(
                attached=False,
                healthy=False,
                frame_age_s=float("inf"),
                consecutive_read_failures=self.consecutive_read_failures,
                reason="CAMERA_NOT_ATTACHED",
            )
        if self.consecutive_read_failures >= self.max_read_failures:
            return CameraHealthStatus(
                attached=True,
                healthy=False,
                frame_age_s=max(0.0, ts - self.last_valid_frame_ts),
                consecutive_read_failures=self.consecutive_read_failures,
                reason=f"CAMERA_READ_FAILURE({self.consecutive_read_failures})",
            )
        age = max(0.0, ts - self.last_valid_frame_ts) if self.last_valid_frame_ts > 0 else float("inf")
        if age > self.max_frame_age_s:
            return CameraHealthStatus(
                attached=True,
                healthy=False,
                frame_age_s=age,
                consecutive_read_failures=self.consecutive_read_failures,
                reason=f"CAMERA_FRAME_STALE({age:.2f}s)",
            )
        return CameraHealthStatus(
            attached=True,
            healthy=True,
            frame_age_s=age,
            consecutive_read_failures=0,
            reason="OK",
        )


class HardenedNavigationController:
    """
    Authoritative closed-loop controller backing the Pi FastAPI endpoints.
    Thread-safe so the background control worker and HTTP handlers never race on
    the shared ESP32 serial bus or state machine.
    """

    def __init__(
        self,
        config: dict,
        simulate: bool = False,
        model_loaded: bool = False,
        homography_matrix: list[list[float]] | None = None,
        imu_heading_fn=None,
    ):
        self.config = config
        self.simulate = simulate
        self.model_loaded = model_loaded
        self.model_path: str | None = None
        self._lock = threading.RLock()

        self._latest_visual_row_end_conf: float = 0.0
        self._latest_visual_lateral_error_m: float = 0.0
        self._latest_visual_heading_error_rad: float = 0.0
        self._latest_vision_analysis: dict[str, Any] | None = None
        self._latest_frame_bytes: bytes | None = None
        self._latest_frame_mime: str = "image/jpeg"
        self._frames_ingested: int = 0
        self._row_width_m: float = float(
            config.get("rover", {}).get("navigation", {}).get("row_width_cm", 60.0)
        ) / 100.0

        self.esp32, self.sm = build_navigation_stack(
            config,
            simulate=simulate,
            imu_heading_fn=imu_heading_fn,
            visual_row_end_fn=self._get_visual_row_end_conf,
            allow_disconnected_esp32=True,
        )
        self.camera_monitor = CameraHealthMonitor(max_frame_age_s=0.5, max_read_failures=2)
        self.target_mgr = TargetExecutionManager(homography_matrix=homography_matrix)
        self.mission_active = False
        self.nav_only_mode = True
        self.last_stop_ack: StopAckResult | None = None
        self.worker_ticks: int = 0
        self.last_mission_request: dict[str, Any] = {}

    def _get_visual_row_end_conf(self) -> float:
        return self._latest_visual_row_end_conf

    @staticmethod
    def is_sample_image(source_type: str | None, image_url: str | None) -> bool:
        if source_type and source_type.strip().lower() in ("sample", "demo", "synthetic"):
            return True
        if image_url:
            low = image_url.strip().lower()
            return any(marker in low for marker in SAMPLE_IMAGE_MARKERS)
        return False

    def ingest_camera_frame(
        self,
        frame_bytes: bytes | None = None,
        *,
        mime_type: str = "image/jpeg",
        visual_row_end_conf: float | None = None,
        lateral_error_m: float | None = None,
        now: float | None = None,
    ) -> tuple[int, dict[str, Any]]:
        """
        Ingest a live camera frame (from MaixSense bridge, USB cam, or Android POST /image),
        run live Excess-Green crop-row analysis when decodable image bytes are provided,
        and refresh CameraHealthMonitor + visual row-end confidence for RoverStateMachine.
        """
        with self._lock:
            vision_dict: dict[str, Any] | None = None
            if frame_bytes is not None:
                if len(frame_bytes) == 0:
                    self.camera_monitor.record_read_failure()
                    return 400, {"ok": False, "error": "EMPTY_FRAME_PAYLOAD"}
                if len(frame_bytes) > MAX_INGEST_FRAME_BYTES:
                    return 413, {"ok": False, "error": "FRAME_TOO_LARGE"}
                self._latest_frame_bytes = frame_bytes
                self._latest_frame_mime = mime_type if mime_type in ("image/jpeg", "image/png") else "image/jpeg"

                vision_res = analyze_crop_row_frame(frame_bytes, row_width_m=self._row_width_m)
                vision_dict = vision_res.to_dict()
                self._latest_vision_analysis = vision_dict
                if vision_res.decoded:
                    if visual_row_end_conf is None:
                        self._latest_visual_row_end_conf = vision_res.visual_row_end_conf
                    if lateral_error_m is None:
                        self._latest_visual_lateral_error_m = vision_res.lateral_error_m
                    self._latest_visual_heading_error_rad = vision_res.heading_error_rad

            if visual_row_end_conf is not None and math.isfinite(visual_row_end_conf):
                self._latest_visual_row_end_conf = max(0.0, min(1.0, float(visual_row_end_conf)))
            if lateral_error_m is not None and math.isfinite(lateral_error_m):
                self._latest_visual_lateral_error_m = max(-1.0, min(1.0, float(lateral_error_m)))

            self._frames_ingested += 1
            self.camera_monitor.record_frame_ok(now=now)
            cam = self.camera_monitor.evaluate(now=now)
            decoded = bool(vision_dict and vision_dict.get("decoded"))
            return 200, {
                "ok": True,
                "frames_ingested": self._frames_ingested,
                "camera_healthy": cam.healthy,
                "visual_row_end_conf": round(self._latest_visual_row_end_conf, 3),
                "lateral_error_m": round(self._latest_visual_lateral_error_m, 4),
                "heading_error_rad": round(self._latest_visual_heading_error_rad, 4),
                # Android PiLiveClient BEV compatibility fields
                "bev_ready": self._latest_frame_bytes is not None,
                "bev_url": "/bev_image",
                "vision_decoded": decoded,
                "analysis_source": vision_dict.get("analysis_source") if vision_dict else "metadata_only",
                "confidence": vision_dict.get("confidence", 0.0) if decoded and vision_dict else round(self._latest_visual_row_end_conf, 3),
                "row_end_detected": self._latest_visual_row_end_conf >= 0.75,
                "green_ratio_near": vision_dict.get("green_ratio_near", 0.0) if vision_dict else 0.0,
                "green_ratio_far": vision_dict.get("green_ratio_far", 0.0) if vision_dict else 0.0,
                "image_width": vision_dict.get("image_width", 0) if vision_dict else 0,
                "image_height": vision_dict.get("image_height", 0) if vision_dict else 0,
                "furrows": vision_dict.get("furrows", []) if decoded and vision_dict else [],
            }

    def load_weed_model(self, model_path: Any) -> tuple[int, dict[str, Any]]:
        """
        Verify and register a real trained weed-vs-crop detector weights file on disk.
        Strictly path-confined inside WEED_MODEL_DIR (or repo root) and never fakes model_loaded=True.
        """
        if not isinstance(model_path, str) or not model_path.strip():
            return 400, {"ok": False, "model_loaded": False, "error": "MODEL_PATH_REQUIRED"}

        repo_root = os.path.realpath(os.path.join(os.path.dirname(__file__), "..", ".."))
        allowed_base = os.path.realpath(os.environ.get("WEED_MODEL_DIR", repo_root))
        raw_path = model_path.strip()
        candidate = raw_path if os.path.isabs(raw_path) else os.path.join(allowed_base, raw_path)
        resolved = os.path.realpath(candidate)

        if not (resolved == allowed_base or resolved.startswith(allowed_base + os.sep)):
            return 403, {"ok": False, "model_loaded": False, "error": "MODEL_PATH_OUTSIDE_ALLOWED_DIR"}

        if not resolved.lower().endswith(ALLOWED_MODEL_EXTENSIONS):
            return 400, {
                "ok": False,
                "model_loaded": False,
                "error": f"UNSUPPORTED_MODEL_EXTENSION (allowed: {', '.join(ALLOWED_MODEL_EXTENSIONS)})",
            }

        if not os.path.isfile(resolved):
            return 404, {"ok": False, "model_loaded": False, "error": "MODEL_FILE_NOT_FOUND"}

        with self._lock:
            self.model_loaded = True
            self.model_path = resolved
            return 200, {
                "ok": True,
                "model_loaded": True,
                "model_file": os.path.basename(resolved),
                "size_bytes": os.path.getsize(resolved),
            }

    def execute_next_treatment_target(
        self,
        actuator_fn=None,
        verify_fn=None,
        now: float | None = None,
    ) -> tuple[int, dict[str, Any]]:
        """
        Stationary, interlock-gated execution of the next queued weed target via TargetExecutionManager.
        Strictly blocked (HTTP 412) in nav_only_mode or whenever model/homography/camera/ESP32/actuator
        interlocks fail. Never fakes treatment actuation when no actuator hook is attached.
        """
        with self._lock:
            blockers: list[str] = []
            if self.nav_only_mode:
                blockers.append("NAV_ONLY_MODE_ACTIVE")
            if not self.model_loaded:
                blockers.append("WEED_MODEL_NOT_LOADED")
            if not self.target_mgr.is_calibrated:
                blockers.append("HOMOGRAPHY_NOT_CALIBRATED")
            if not self.esp32.connected:
                blockers.append("ESP32_NOT_CONNECTED")
            else:
                telem = self.esp32.read_telemetry()
                if not (telem and telem.valid and telem.estop_ok and telem.watchdog_ok):
                    blockers.append("ESTOP_OR_WATCHDOG_NOT_READY")
            cam = self.camera_monitor.evaluate(now=now)
            if not cam.healthy:
                blockers.append(f"CAMERA_UNHEALTHY:{cam.reason}")
            if actuator_fn is None:
                blockers.append("TREATMENT_ACTUATOR_NOT_ATTACHED")

            if blockers:
                return 412, {
                    "executed": False,
                    "reason": "TREATMENT_INTERLOCK_BLOCKED",
                    "blockers": blockers,
                }

            # Enforce stationary rover stop before actuating any modular treatment attachment
            self.esp32.send_stop()
            verifier = verify_fn if verify_fn is not None else (lambda _target: True)
            executed, reason = self.target_mgr.execute_next_target(
                rover_speed_cms=0.0,
                estop_ok=True,
                interlock_ok=True,
                actuate_fn=actuator_fn,
                verify_fn=verifier,
                now=now,
            )
            return 200, {
                "executed": executed,
                "reason": reason,
                "weeds_eliminated": self.target_mgr.weeds_eliminated,
            }

    def set_homography_matrix(self, matrix: Any) -> tuple[int, dict[str, Any]]:
        """Validate and load a calibrated 3x3 pixel-to-ground homography matrix."""
        if not isinstance(matrix, list) or len(matrix) != 3:
            return 400, {"ok": False, "error": "HOMOGRAPHY_MUST_BE_3X3_MATRIX"}
        parsed: list[list[float]] = []
        for row in matrix:
            if not isinstance(row, list) or len(row) != 3:
                return 400, {"ok": False, "error": "HOMOGRAPHY_MUST_BE_3X3_MATRIX"}
            prow: list[float] = []
            for v in row:
                try:
                    fv = float(v)
                except (TypeError, ValueError):
                    return 400, {"ok": False, "error": "HOMOGRAPHY_NON_NUMERIC"}
                if not math.isfinite(fv):
                    return 400, {"ok": False, "error": "HOMOGRAPHY_NON_FINITE"}
                prow.append(fv)
            parsed.append(prow)

        with self._lock:
            self.target_mgr.homography = parsed
            return 200, {"ok": True, "homography_calibrated": self.target_mgr.is_calibrated}

    def handle_detection(
        self,
        *,
        class_name: str,
        confidence: float,
        u_px: float,
        v_px: float,
    ) -> tuple[int, dict[str, Any]]:
        """
        Gate incoming weed detections through model_loaded + calibrated homography +
        TargetExecutionManager class whitelist & spatial deduplication.
        """
        with self._lock:
            if not self.model_loaded:
                return 412, {
                    "accepted": False,
                    "reason": "WEED_MODEL_NOT_LOADED",
                    "detail": "Trained weed-vs-crop detector weights are not loaded.",
                }
            if not self.target_mgr.is_calibrated:
                return 412, {
                    "accepted": False,
                    "reason": "HOMOGRAPHY_NOT_CALIBRATED",
                    "detail": "Camera-to-ground 3x3 homography calibration is required before targeting.",
                }
            try:
                conf_f = float(confidence)
                u_f = float(u_px)
                v_f = float(v_px)
            except (TypeError, ValueError):
                return 400, {"accepted": False, "reason": "INVALID_DETECTION_NUMBERS"}
            if not (math.isfinite(conf_f) and math.isfinite(u_f) and math.isfinite(v_f)):
                return 400, {"accepted": False, "reason": "NON_FINITE_DETECTION_NUMBERS"}

            target, reason = self.target_mgr.ingest_detection(class_name, conf_f, u_f, v_f)
            if target is None:
                return 200, {"accepted": False, "reason": reason}
            return 200, {
                "accepted": True,
                "reason": reason,
                "target": {
                    "target_id": target.target_id,
                    "class_name": target.class_name,
                    "confidence": target.confidence,
                    "x_lat_mm": round(target.x_lat_mm, 2),
                    "y_fwd_mm": round(target.y_fwd_mm, 2),
                    "state": target.state.value,
                },
            }

    def evaluate_launch_interlocks(
        self,
        *,
        source_type: str = "live_capture",
        image_url: str | None = None,
        nav_only: bool = True,
        operator_confirmed: bool = True,
        now: float | None = None,
    ) -> tuple[bool, list[str], dict[str, Any]]:
        """Strict hardware & safety pre-flight checklist (Audit 2B, 2C, 3A)."""
        with self._lock:
            blockers: list[str] = []

            # 1. Sample-image-to-live-robot guard (Audit 2C)
            if not self.simulate and self.is_sample_image(source_type, image_url):
                blockers.append("SAMPLE_IMAGE_FORBIDDEN_ON_LIVE_HARDWARE")

            if not self.simulate and not operator_confirmed:
                blockers.append("OPERATOR_CONFIRMATION_REQUIRED")

            # 2. ESP32 serial connection check
            esp32_ok = bool(self.esp32.connected)
            if not esp32_ok:
                blockers.append("ESP32_NOT_CONNECTED")

            # 3. Hardware E-stop & watchdog telemetry validity check
            telem = self.esp32.read_telemetry() if esp32_ok else None
            estop_ok = bool(telem and telem.valid and telem.estop_ok)
            watchdog_ok = bool(telem and telem.valid and telem.watchdog_ok)
            estop_ready = estop_ok and watchdog_ok
            if not estop_ready:
                blockers.append("ESTOP_OR_WATCHDOG_NOT_READY")

            # 4. Live camera health check (Audit 1C)
            cam_status = self.camera_monitor.evaluate(now=now)
            if not cam_status.healthy:
                blockers.append(f"CAMERA_UNHEALTHY:{cam_status.reason}")

            # 5. Obstacle sensor health check
            obs = self.sm.obstacle_sensor.evaluate()
            sensor_ok = obs.status != ObstacleStatus.SENSOR_FAULT
            if not sensor_ok:
                blockers.append(f"OBSTACLE_SENSOR_FAULT:{obs.reason}")

            # 6. Weed detection model & calibration check when actuators/weeding enabled (Audit 3A/3D)
            if not nav_only:
                if not self.model_loaded:
                    blockers.append("WEED_MODEL_NOT_LOADED")
                if not self.target_mgr.is_calibrated:
                    blockers.append("HOMOGRAPHY_NOT_CALIBRATED")

            status_dict = {
                "esp32_connected": esp32_ok,
                "estop_ok": estop_ok,
                "watchdog_ok": watchdog_ok,
                "estop_ready": estop_ready,
                "camera_healthy": cam_status.healthy,
                "camera_reason": cam_status.reason,
                "sensors_healthy": sensor_ok,
                "imu_connected": bool(getattr(self.sm.rover, "imu_heading_fn", None) is not None),
                "model_loaded": self.model_loaded,
                "homography_calibrated": self.target_mgr.is_calibrated,
                "simulation_mode": self.simulate,
                "nav_only": nav_only,
            }
            return len(blockers) == 0, blockers, status_dict

    def handle_start_mission(
        self,
        *,
        source_type: str = "live_capture",
        image_url: str | None = None,
        nav_only: bool = True,
        operator_confirmed: bool = True,
        now: float | None = None,
        mission_meta: dict[str, Any] | None = None,
    ) -> tuple[int, dict[str, Any]]:
        """Handler for POST /start_mission with fail-closed launch interlocks."""
        with self._lock:
            ok, blockers, interlocks = self.evaluate_launch_interlocks(
                source_type=source_type,
                image_url=image_url,
                nav_only=nav_only,
                operator_confirmed=operator_confirmed,
                now=now,
            )
            if not ok:
                return 412, {
                    "started": False,
                    "reason": "LAUNCH_INTERLOCK_BLOCKED",
                    "blockers": blockers,
                    "interlocks": interlocks,
                }

            self.nav_only_mode = nav_only
            self.mission_active = True
            self.last_mission_request = mission_meta or {}
            self.sm.running = True
            if self.sm.state in (RoverState.IDLE, RoverState.PAUSED):
                self.sm.state = RoverState.NAVIGATING_ROW

            return 200, {
                "started": True,
                "state": self.sm.state,
                "nav_only": nav_only,
                "interlocks": interlocks,
            }

    def handle_pause(self) -> tuple[int, dict[str, Any]]:
        """Safe operator pause with atomic checkpoint save."""
        with self._lock:
            self.mission_active = False
            self.sm.pause()
            return 200, {
                "paused": True,
                "state": self.sm.state,
                "checkpoint": self.sm.tracker.summary(),
            }

    def handle_resume(self, now: float | None = None) -> tuple[int, dict[str, Any]]:
        """Resume from PAUSED or OBSTACLE_HOLD only when camera & safety interlocks pass."""
        with self._lock:
            cam = self.camera_monitor.evaluate(now=now)
            if not cam.healthy:
                return 412, {
                    "resumed": False,
                    "reason": f"CAMERA_UNHEALTHY:{cam.reason}",
                    "state": self.sm.state,
                }
            ok, reason = self.sm.resume()
            if not ok:
                return 412, {"resumed": False, "reason": reason, "state": self.sm.state}
            self.mission_active = True
            self.sm.running = True
            return 200, {"resumed": True, "reason": reason, "state": self.sm.state}

    def handle_recover(
        self,
        *,
        operator_confirmed: bool = False,
        relocalize_pose: tuple[float, float, float] | None = None,
    ) -> tuple[int, dict[str, Any]]:
        """
        Explicit operator-authorized recovery from ESP32 watchdog/E-stop latch and
        navigation FAULT state. Never clears latches silently.
        """
        with self._lock:
            if not operator_confirmed:
                return 400, {
                    "recovered": False,
                    "reason": "OPERATOR_CONFIRMATION_REQUIRED",
                    "state": self.sm.state,
                }
            if not self.esp32.connected:
                return 503, {
                    "recovered": False,
                    "reason": "ESP32_NOT_CONNECTED",
                    "state": self.sm.state,
                }

            # 1. Clear ESP32 watchdog/E-stop latch only if physical GPIO 13 switch is closed
            telem = self.esp32.read_telemetry()
            if not telem.valid or not telem.estop_ok or not telem.watchdog_ok:
                ok_latch, latch_msg = self.esp32.recover_watchdog_latch(operator_confirmed=True)
                if not ok_latch:
                    return 412, {
                        "recovered": False,
                        "reason": f"ESP32_LATCH_RECOVERY_FAILED:{latch_msg}",
                        "state": self.sm.state,
                    }

            # 2. Recover navigation state machine into PAUSED (operator must explicitly resume/start)
            ok_sm, sm_msg = self.sm.recover(relocalize_pose=relocalize_pose)
            if not ok_sm:
                return 412, {
                    "recovered": False,
                    "reason": sm_msg,
                    "state": self.sm.state,
                }

            self.mission_active = False
            return 200, {
                "recovered": True,
                "reason": sm_msg,
                "state": self.sm.state,
                "hardware": self.get_status()["hardware"],
            }

    def handle_startup_handshake(
        self,
        *,
        allow_clear_latch: bool = False,
        operator_confirmed: bool = False,
        now: float | None = None,
    ) -> tuple[int, dict[str, Any]]:
        """
        Safe USB ESP32 startup inspection & explicit operator-authorized latch clear:
          - Read-only mode (allow_clear_latch=False, DEFAULT):
              1. Verify/open USB serial link to ESP32.
              2. Send PING to verify responsiveness.
              3. Read TELEM? ONLY — NEVER sends CLEAR_LATCH automatically!
                 If watchdog or E-stop is latched, remains strictly LOCKED.
              4. Evaluate live camera readiness.
          - Explicit latch-clear mode (allow_clear_latch=True):
              Requires operator_confirmed=True (returns HTTP 400 otherwise).
              Dispatches CLEAR_LATCH, validates post-clear TELEM?, and leaves
              RoverStateMachine in PAUSED (never auto-resumes or auto-starts).
        """
        with self._lock:
            steps: list[dict[str, Any]] = []
            usb_port = getattr(self.esp32, "port", "USB-SIM" if self.simulate else "/dev/ttyUSB0")

            # Step 1: Verify USB serial connection
            if not self.esp32.connected:
                try:
                    self.esp32.connect()
                except Exception as exc:
                    steps.append({
                        "id": "usb_connect",
                        "command": f"OPEN {usb_port}",
                        "status": "fail",
                        "response": f"CONNECT_ERR:{exc}",
                        "detail": f"Unable to open ESP32 USB serial port ({usb_port}).",
                    })
                    return 503, {
                        "ok": False,
                        "usb_port": usb_port,
                        "esp32_ready": False,
                        "watchdog_initialized": False,
                        "estop_ok": False,
                        "latch_locked": True,
                        "clear_latch_attempted": False,
                        "camera_healthy": self.camera_monitor.evaluate(now=now).healthy,
                        "navigation_dispatch_unlocked": False,
                        "steps": steps,
                        "status": self.get_status(now=now),
                    }

            if not self.esp32.connected:
                steps.append({
                    "id": "usb_connect",
                    "command": f"OPEN {usb_port}",
                    "status": "fail",
                    "response": "ERR:DISCONNECTED",
                    "detail": f"ESP32 USB serial bridge on {usb_port} is disconnected.",
                })
                return 503, {
                    "ok": False,
                    "usb_port": usb_port,
                    "esp32_ready": False,
                    "watchdog_initialized": False,
                    "estop_ok": False,
                    "latch_locked": True,
                    "clear_latch_attempted": False,
                    "camera_healthy": self.camera_monitor.evaluate(now=now).healthy,
                    "navigation_dispatch_unlocked": False,
                    "steps": steps,
                    "status": self.get_status(now=now),
                }

            steps.append({
                "id": "usb_connect",
                "command": f"USB {usb_port}",
                "status": "pass",
                "response": "CONNECTED",
                "detail": f"ESP32 USB link active on {usb_port} (auto-configured 115200 baud).",
            })

            # Step 2: PING handshake (read-only liveness check — does NOT clear a latched fault)
            try:
                ping_resp = self.esp32.send("PING")
            except Exception as exc:
                ping_resp = f"UART_ERR:{exc}"
            ping_ok = ping_resp.startswith("PONG")
            steps.append({
                "id": "ping",
                "command": "PING",
                "status": "pass" if ping_ok else "fail",
                "response": ping_resp,
                "detail": "ESP32 responded to read-only PING." if ping_ok else "ESP32 did not acknowledge PING.",
            })
            if not ping_ok:
                return 503, {
                    "ok": False,
                    "usb_port": usb_port,
                    "esp32_ready": False,
                    "watchdog_initialized": False,
                    "estop_ok": False,
                    "latch_locked": True,
                    "clear_latch_attempted": False,
                    "camera_healthy": self.camera_monitor.evaluate(now=now).healthy,
                    "navigation_dispatch_unlocked": False,
                    "steps": steps,
                    "status": self.get_status(now=now),
                }

            # Step 3: Read current telemetry BEFORE deciding whether any latch is tripped
            pre_telem = self.esp32.read_telemetry()
            pre_estop_ok = bool(pre_telem.valid and pre_telem.estop_ok)
            pre_wd_ok = bool(pre_telem.valid and pre_telem.watchdog_ok)
            is_latched = (not pre_estop_ok) or (not pre_wd_ok) or (self.sm.state in (RoverState.FAULT, RoverState.ESTOP))

            clear_latch_attempted = False
            latch_ok = not is_latched

            if not allow_clear_latch:
                # Strict Read-Only Inspection: NEVER dispatch CLEAR_LATCH automatically!
                steps.append({
                    "id": "clear_latch_gate",
                    "command": "TELEM? (READ-ONLY)",
                    "status": "pass" if not is_latched else "warn",
                    "response": (
                        f"estop_ok={int(pre_estop_ok)} watchdog_ok={int(pre_wd_ok)} latch_locked={int(is_latched)}"
                        if pre_telem.valid
                        else "ERR:TELEM_INVALID"
                    ),
                    "detail": (
                        "Read-only startup inspection complete — no latch active (CLEAR_LATCH not required)."
                        if not is_latched
                        else "Safety latch is LOCKED. Automatic startup will NOT clear E-stop or watchdog latches — explicit operator authorization is required."
                    ),
                })
                telem = pre_telem
            else:
                # Explicit operator latch-clear path
                if not operator_confirmed:
                    steps.append({
                        "id": "clear_latch",
                        "command": "CLEAR_LATCH",
                        "status": "fail",
                        "response": "ERR:OPERATOR_CONFIRMATION_REQUIRED",
                        "detail": "Explicit operator confirmation is required before dispatching CLEAR_LATCH.",
                    })
                    return 400, {
                        "ok": False,
                        "usb_port": usb_port,
                        "esp32_ready": False,
                        "watchdog_initialized": False,
                        "estop_ok": pre_estop_ok,
                        "latch_locked": True,
                        "clear_latch_attempted": False,
                        "camera_healthy": self.camera_monitor.evaluate(now=now).healthy,
                        "navigation_dispatch_unlocked": False,
                        "steps": steps,
                        "status": self.get_status(now=now),
                    }

                clear_latch_attempted = True
                latch_ok, latch_resp = self.esp32.recover_watchdog_latch(operator_confirmed=True)
                steps.append({
                    "id": "clear_latch",
                    "command": "CLEAR_LATCH",
                    "status": "pass" if latch_ok else "fail",
                    "response": latch_resp,
                    "detail": (
                        "Operator-authorized CLEAR_LATCH verified; physical GPIO 13 safety loop is closed."
                        if latch_ok
                        else f"CLEAR_LATCH rejected ({latch_resp}). Verify physical GPIO 13 E-stop switch is closed."
                    ),
                })
                telem = self.esp32.read_telemetry()

            # Step 4: Validate resulting ready-state via TELEM?
            estop_ok = bool(telem.valid and telem.estop_ok)
            watchdog_ok = bool(telem.valid and telem.watchdog_ok)
            sm_latched = self.sm.state in (RoverState.FAULT, RoverState.ESTOP)

            # Recover state machine strictly to PAUSED ONLY on explicit operator-authorized clear_latch
            if allow_clear_latch and operator_confirmed and latch_ok and estop_ok and watchdog_ok and sm_latched:
                self.sm.recover()
                self.mission_active = False
                sm_latched = self.sm.state in (RoverState.FAULT, RoverState.ESTOP)

            latch_locked = (not estop_ok) or (not watchdog_ok) or sm_latched
            esp32_ready = bool(latch_ok and estop_ok and watchdog_ok and not sm_latched)
            steps.append({
                "id": "ready_validate",
                "command": "TELEM?",
                "status": "pass" if esp32_ready else "warn" if not allow_clear_latch else "fail",
                "response": (
                    f"estop_ok={int(estop_ok)} watchdog_ok={int(watchdog_ok)} dist_mm={telem.distance_mm} state={self.sm.state}"
                    if telem.valid
                    else "ERR:TELEM_INVALID"
                ),
                "detail": (
                    "ESP32 watchdog initialized and ready-state validated (rover remains PAUSED/IDLE until explicit mission start)."
                    if esp32_ready
                    else "ESP32 latch remains locked; navigation dispatch is blocked until explicit operator recovery."
                ),
            })

            # Step 5: Camera health readiness check
            cam = self.camera_monitor.evaluate(now=now)
            steps.append({
                "id": "camera_ready",
                "command": "CAMERA_HEALTH",
                "status": "pass" if cam.healthy else "warn",
                "response": cam.reason,
                "detail": (
                    f"Navigation camera healthy ({self._frames_ingested} frames ingested)."
                    if cam.healthy
                    else f"Camera not ready ({cam.reason}) — start MaixSense bridge or attach live feed before launching mission."
                ),
            })

            nav_unlocked = bool(esp32_ready and cam.healthy)
            http_code = 200 if (esp32_ready or not allow_clear_latch) else 412
            return http_code, {
                "ok": esp32_ready,
                "usb_port": usb_port,
                "simulated": self.simulate,
                "esp32_ready": esp32_ready,
                "watchdog_initialized": watchdog_ok and not latch_locked,
                "estop_ok": estop_ok,
                "latch_locked": latch_locked,
                "clear_latch_attempted": clear_latch_attempted,
                "inspection_only": not allow_clear_latch,
                "camera_healthy": cam.healthy,
                "camera_reason": cam.reason,
                "frames_ingested": self._frames_ingested,
                "navigation_dispatch_unlocked": nav_unlocked,
                "steps": steps,
                "status": self.get_status(now=now),
            }

    def handle_stop(self) -> tuple[int, dict[str, Any]]:
        """
        Handler for POST /stop (Audit 1E).
        Verifies actual ESP32 stop ACK. Returns HTTP 503 if hardware stop cannot be confirmed!
        """
        with self._lock:
            self.mission_active = False
            self.sm.running = False
            ack = self.esp32.send_emergency_stop()
            self.last_stop_ack = ack

            # On live hardware, a simulated ACK or unverified UART response MUST NOT report HTTP 200!
            hw_verified = ack.verified and (self.simulate or not ack.simulated)
            if not hw_verified:
                self.sm.state = RoverState.FAULT
                self.sm.fault_reason = f"ESTOP_ACK_FAILED:{ack.response}"
                return 503, {
                    "stopped": False,
                    "ack_verified": False,
                    "esp32_response": ack.response,
                    "simulated": ack.simulated,
                    "error": "ESP32 stop acknowledgement NOT verified — engage physical power cutoff immediately!",
                }

            self.sm.state = RoverState.ESTOP
            self.sm.fault_reason = "OPERATOR_ESTOP"
            return 200, {
                "stopped": True,
                "ack_verified": True,
                "esp32_response": ack.response,
                "estop_latched": ack.estop_latched,
                "simulated": ack.simulated,
            }

    def send_keepalive(self) -> None:
        """Keep the ESP32 250 ms serial watchdog alive while Pi server is running."""
        with self._lock:
            if self.esp32.connected:
                try:
                    self.esp32.read_telemetry()
                except Exception:
                    pass

    def step_control_loop(self, now: float | None = None) -> dict[str, Any]:
        """
        Single closed-loop control tick:
          1. Verifies live camera health (stops immediately on camera loss/stale frame — Audit 1C).
          2. Steps RoverStateMachine, updating pose ONLY from encoder+IMU feedback (Audit 1A)
             and executing real 3-stage headland crossing (Audit 1B).
        """
        with self._lock:
            self.worker_ticks += 1
            if not self.mission_active:
                self.send_keepalive()
                return self.get_status(now=now)

            cam = self.camera_monitor.evaluate(now=now)
            if not cam.healthy:
                self.mission_active = False
                self.sm.running = False
                self.esp32.send_stop()
                self.sm.state = RoverState.FAULT
                self.sm.fault_reason = f"CAMERA_LOSS:{cam.reason}"
                return self.get_status(now=now)

            self.sm.tick()
            if self.sm.state in (RoverState.FAULT, RoverState.ESTOP, RoverState.DONE):
                self.mission_active = False

            return self.get_status(now=now)

    def render_map_svg(self) -> str:
        """Render a clean SVG live field map showing measured encoder+IMU rover pose."""
        with self._lock:
            pose = self.sm.rover.localizer.get_pose()
            nav = self.sm.navigator
            w = max(100.0, nav.field_length_cm)
            h = max(100.0, nav.field_width_cm)
            px = max(0.0, min(w, pose.x_cm))
            py = max(0.0, min(h, pose.y_cm))
            rows_svg = "".join(
                f'<line x1="{nav.headland_margin_cm:.1f}" y1="{ry:.1f}" '
                f'x2="{w - nav.headland_margin_cm:.1f}" y2="{ry:.1f}" '
                f'stroke="#10b981" stroke-width="2" stroke-dasharray="6,4" opacity="0.55"/>'
                for ry in nav.row_centers_y
            )
            return (
                f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:.0f} {h:.0f}" '
                f'width="600" height="400" style="background:#f4f8f5">'
                f'<rect x="{nav.headland_margin_cm:.1f}" y="{nav.boundary.safety_margin_cm:.1f}" '
                f'width="{w - 2*nav.headland_margin_cm:.1f}" height="{h - 2*nav.boundary.safety_margin_cm:.1f}" '
                f'fill="none" stroke="#047857" stroke-width="2"/>'
                f"{rows_svg}"
                f'<circle cx="{px:.1f}" cy="{py:.1f}" r="8" fill="#059669" stroke="#ffffff" stroke-width="2"/>'
                f"</svg>"
            )

    def get_status(self, now: float | None = None) -> dict[str, Any]:
        with self._lock:
            pose = self.sm.rover.localizer.get_pose()
            cam = self.camera_monitor.evaluate(now=now)
            telem = self.esp32.read_telemetry() if self.esp32.connected else None
            estop_ok = bool(telem and telem.valid and telem.estop_ok)
            watchdog_ok = bool(telem and telem.valid and telem.watchdog_ok)
            latch_locked = (not estop_ok) or (not watchdog_ok) or (self.sm.state in (RoverState.FAULT, RoverState.ESTOP))
            return {
                "state": self.sm.state,
                "fault_reason": self.sm.fault_reason,
                "mission_active": self.mission_active,
                "nav_only_mode": self.nav_only_mode,
                "simulation_mode": self.simulate,
                "worker_ticks": self.worker_ticks,
                "frames_ingested": self._frames_ingested,
                "pose_measured": {
                    "x_cm": round(pose.x_cm, 2),
                    "y_cm": round(pose.y_cm, 2),
                    "heading_deg": round(pose.heading_deg, 2),
                    "localized": pose.localized,
                    "slip_residual_cm": round(pose.slip_residual_cm, 2),
                },
                "row_progress": self.sm.navigator.get_status(),
                "coverage": self.sm.tracker.summary(),
                "hardware": {
                    "esp32_connected": self.esp32.connected,
                    "estop_ok": estop_ok,
                    "watchdog_ok": watchdog_ok,
                    "latch_locked": latch_locked,
                    "left_ticks": telem.left_ticks if (telem and telem.valid) else 0,
                    "right_ticks": telem.right_ticks if (telem and telem.valid) else 0,
                    "distance_mm": telem.distance_mm if (telem and telem.valid) else -1,
                    "imu_connected": bool(getattr(self.sm.rover, "imu_heading_fn", None) is not None),
                    "camera_healthy": cam.healthy,
                    "camera_reason": cam.reason,
                    "visual_row_end_conf": round(self._latest_visual_row_end_conf, 3),
                    "visual_lateral_error_m": round(self._latest_visual_lateral_error_m, 4),
                    "visual_heading_error_rad": round(self._latest_visual_heading_error_rad, 4),
                    "model_loaded": self.model_loaded,
                    "model_file": os.path.basename(self.model_path) if self.model_path else None,
                    "homography_calibrated": self.target_mgr.is_calibrated,
                },
                "vision_analysis": self._latest_vision_analysis,
                "weeds_eliminated": self.target_mgr.weeds_eliminated,
                "rejected_crops": self.target_mgr.rejected_crops,
            }


class BackgroundControlWorker:
    """Daemon worker thread that continuously executes step_control_loop() at target Hz."""

    def __init__(self, controller: HardenedNavigationController, hz: float = 10.0):
        self.controller = controller
        self.period_s = 1.0 / max(1.0, min(50.0, float(hz)))
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

    @property
    def is_running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self) -> None:
        if self.is_running:
            return
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._run,
            name="rover-control-loop",
            daemon=True,
        )
        self._thread.start()

    def stop(self, timeout_s: float = 2.0) -> None:
        self._stop_event.set()
        if self._thread is not None and self._thread.is_alive():
            self._thread.join(timeout=timeout_s)
        self._thread = None

    def _run(self) -> None:
        while not self._stop_event.is_set():
            t0 = time.monotonic()
            try:
                self.controller.step_control_loop()
            except Exception as exc:
                self.controller.sm.fault_reason = f"WORKER_LOOP_EXCEPTION:{exc}"
                self.controller.mission_active = False
                try:
                    self.controller.esp32.send_stop()
                except Exception:
                    pass
            elapsed = time.monotonic() - t0
            sleep_s = max(0.005, self.period_s - elapsed)
            self._stop_event.wait(sleep_s)


class AsyncControlLoopWorker:
    """
    Asyncio background worker task for FastAPI lifespan.
    Continuously invokes controller.step_control_loop() off the event loop via
    asyncio.to_thread() so HTTP endpoints stay responsive while missions run.
    """

    def __init__(self, controller: HardenedNavigationController, hz: float = 10.0):
        self.controller = controller
        self.hz = max(1.0, min(50.0, float(hz)))
        self.period_s = 1.0 / self.hz
        self._task: asyncio.Task[None] | None = None
        self._stop_event: asyncio.Event | None = None
        self.last_tick_ts: float = 0.0
        self.last_error: str | None = None

    @property
    def is_running(self) -> bool:
        return self._task is not None and not self._task.done()

    @property
    def task(self) -> asyncio.Task[None] | None:
        return self._task

    def start(self) -> asyncio.Task[None]:
        if self.is_running and self._task is not None:
            return self._task
        self._stop_event = asyncio.Event()
        self._task = asyncio.create_task(self._run(), name="rover-navigation-control-loop")
        return self._task

    async def stop(self) -> None:
        if self._stop_event is not None:
            self._stop_event.set()
        if self._task is not None and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._task = None

    async def _run(self) -> None:
        stop_event = self._stop_event
        assert stop_event is not None
        try:
            while not stop_event.is_set():
                t0 = time.monotonic()
                try:
                    await asyncio.to_thread(self.controller.step_control_loop)
                    self.last_tick_ts = time.monotonic()
                    self.last_error = None
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    self.last_error = str(exc)
                    self.controller.sm.fault_reason = f"WORKER_LOOP_EXCEPTION:{exc}"
                    self.controller.mission_active = False
                    try:
                        await asyncio.to_thread(self.controller.esp32.send_stop)
                    except Exception:
                        pass

                elapsed = time.monotonic() - t0
                sleep_s = max(0.005, self.period_s - elapsed)
                try:
                    await asyncio.wait_for(stop_event.wait(), timeout=sleep_s)
                except asyncio.TimeoutError:
                    pass
        except asyncio.CancelledError:
            raise


def get_allowed_cors_origins() -> list[str]:
    """Configurable CORS origins for LAN deployment (Audit 2D)."""
    env_val = os.environ.get("WEED_ROVER_CORS_ORIGINS", "").strip()
    if env_val:
        return [o.strip() for o in env_val.split(",") if o.strip()]
    return [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://192.168.4.1:3000",
    ]


def create_fastapi_app(
    config: dict,
    simulate: bool = False,
    start_worker: bool = True,
    worker_hz: float = 10.0,
    api_token: str | None = None,
):
    """
    FastAPI app factory for Raspberry Pi 5 runtime on port 8000 with:
      - asyncio background control loop worker
      - server-side Bearer token authentication when PI_API_TOKEN (or api_token) is set
      - read-only default startup handshake (never auto-clears E-stop/watchdog latches)
      - real ExG crop-row vision analysis on /camera/frame and multipart Android /image
    """
    from fastapi import Depends, FastAPI, HTTPException, Request
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import JSONResponse, Response

    expected_token = (
        api_token.strip()
        if isinstance(api_token, str) and api_token.strip()
        else (os.environ.get("PI_API_TOKEN", "").strip() or None)
    )

    def require_bearer_auth(request: Request) -> None:
        if not verify_bearer_token(request.headers.get("authorization"), expected_token):
            raise HTTPException(
                status_code=401,
                detail="UNAUTHORIZED: Valid Authorization: Bearer <PI_API_TOKEN> header required.",
            )

    controller = HardenedNavigationController(config=config, simulate=simulate)
    worker = AsyncControlLoopWorker(controller, hz=worker_hz)

    @asynccontextmanager
    async def lifespan(fastapi_app: FastAPI):
        if start_worker:
            fastapi_app.state.control_loop_task = worker.start()
        else:
            fastapi_app.state.control_loop_task = None
        try:
            yield
        finally:
            await worker.stop()
            fastapi_app.state.control_loop_task = None
            try:
                await asyncio.to_thread(controller.esp32.send_stop)
            except Exception:
                pass

    app = FastAPI(title="Weeding Rover Hardened Navigation Server", lifespan=lifespan)
    app.state.controller = controller
    app.state.worker = worker
    app.state.control_loop_task = None
    app.state.auth_enabled = bool(expected_token)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=get_allowed_cors_origins(),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health")
    def get_health():
        status = controller.get_status()
        return {
            "ok": True,
            "auth_enabled": bool(expected_token),
            "worker_running": worker.is_running,
            "worker_hz": worker.hz,
            "worker_ticks": controller.worker_ticks,
            "worker_last_error": worker.last_error,
            "status": status,
        }

    @app.get("/cut_plan")
    def get_cut_plan():
        return controller.get_status()

    @app.post("/start_mission", dependencies=[Depends(require_bearer_auth)])
    def post_start_mission(payload: dict[str, Any] | None = None):
        body = payload or {}
        # Support both canonical payload and Android PiLiveClient payload (start/end/relay_mode)
        # while strictly preserving fail-closed operator_confirmed & nav_only safety gates.
        relay_mode = str(body.get("relay_mode", "")).strip().lower()
        if "nav_only" in body:
            nav_only = bool(body.get("nav_only"))
        else:
            nav_only = relay_mode not in ("grinder", "flame", "treatment")

        code, data = controller.handle_start_mission(
            source_type=str(body.get("source_type", "live_capture")),
            image_url=body.get("image_url"),
            nav_only=nav_only,
            operator_confirmed=bool(body.get("operator_confirmed", False)),
            mission_meta={
                k: body[k] for k in ("start", "end", "relay_mode", "start_row", "end_row") if k in body
            },
        )
        if code == 412 and isinstance(data, dict):
            data["contract_hint"] = (
                "Send operator_confirmed=true and nav_only=true (or relay_mode='nav_only') for navigation-only runs; "
                "treatment modes require loaded detector weights (/model/load) and 3x3 homography (/calibration/homography)."
            )
        return JSONResponse(status_code=code, content=data)

    @app.post("/pause", dependencies=[Depends(require_bearer_auth)])
    def post_pause():
        code, data = controller.handle_pause()
        return JSONResponse(status_code=code, content=data)

    @app.post("/resume", dependencies=[Depends(require_bearer_auth)])
    def post_resume():
        code, data = controller.handle_resume()
        return JSONResponse(status_code=code, content=data)

    @app.post("/recover", dependencies=[Depends(require_bearer_auth)])
    def post_recover(payload: dict[str, Any] | None = None):
        body = payload or {}
        pose_raw = body.get("relocalize_pose")
        pose_tuple = None
        if isinstance(pose_raw, (list, tuple)) and len(pose_raw) == 3:
            try:
                pose_tuple = (float(pose_raw[0]), float(pose_raw[1]), float(pose_raw[2]))
            except (TypeError, ValueError):
                return JSONResponse(
                    status_code=400,
                    content={"recovered": False, "reason": "INVALID_RELOCALIZE_POSE"},
                )
        code, data = controller.handle_recover(
            operator_confirmed=bool(body.get("operator_confirmed", False)),
            relocalize_pose=pose_tuple,
        )
        return JSONResponse(status_code=code, content=data)

    @app.post("/handshake", dependencies=[Depends(require_bearer_auth)])
    def post_handshake(payload: dict[str, Any] | None = None):
        body = payload or {}
        # Read-only by default: CLEAR_LATCH runs ONLY when BOTH allow_clear_latch=True and operator_confirmed=True!
        code, data = controller.handle_startup_handshake(
            allow_clear_latch=bool(body.get("allow_clear_latch", False)),
            operator_confirmed=bool(body.get("operator_confirmed", False)),
        )
        return JSONResponse(status_code=code, content=data)

    @app.post("/stop", dependencies=[Depends(require_bearer_auth)])
    def post_stop():
        code, data = controller.handle_stop()
        return JSONResponse(status_code=code, content=data)

    @app.get("/heartbeat")
    @app.post("/heartbeat")
    def handle_heartbeat():
        controller.send_keepalive()
        return {
            "ok": True,
            "auth_enabled": bool(expected_token),
            "worker_running": worker.is_running,
            "status": controller.get_status(),
        }

    async def _ingest_frame_request(request: Request):
        ctype = request.headers.get("content-type") or ""
        ctype_low = ctype.lower()
        vis_conf_hdr = request.headers.get("x-visual-row-end-conf")
        lat_err_hdr = request.headers.get("x-lateral-error-m")
        vis_conf = float(vis_conf_hdr) if vis_conf_hdr is not None else None
        lat_err = float(lat_err_hdr) if lat_err_hdr is not None else None

        if "application/json" in ctype_low:
            body = await request.json()
            if isinstance(body, dict):
                if "visual_row_end_conf" in body:
                    vis_conf = float(body["visual_row_end_conf"])
                if "lateral_error_m" in body:
                    lat_err = float(body["lateral_error_m"])
            code, data = controller.ingest_camera_frame(
                None,
                visual_row_end_conf=vis_conf,
                lateral_error_m=lat_err,
            )
            return JSONResponse(status_code=code, content=data)

        raw = await request.body()
        if "multipart/form-data" in ctype_low:
            img_bytes, mime = extract_multipart_image(raw, ctype)
            if img_bytes is None:
                return JSONResponse(
                    status_code=400,
                    content={"ok": False, "error": "MULTIPART_IMAGE_PART_NOT_FOUND"},
                )
            code, data = controller.ingest_camera_frame(
                img_bytes,
                mime_type=mime,
                visual_row_end_conf=vis_conf,
                lateral_error_m=lat_err,
            )
            return JSONResponse(status_code=code, content=data)

        mime = "image/png" if "png" in ctype_low else "image/jpeg"
        code, data = controller.ingest_camera_frame(
            raw,
            mime_type=mime,
            visual_row_end_conf=vis_conf,
            lateral_error_m=lat_err,
        )
        return JSONResponse(status_code=code, content=data)

    @app.post("/camera/frame", dependencies=[Depends(require_bearer_auth)])
    async def post_camera_frame(request: Request):
        return await _ingest_frame_request(request)

    @app.post("/image", dependencies=[Depends(require_bearer_auth)])
    async def post_image(request: Request):
        return await _ingest_frame_request(request)

    @app.get("/video_feed")
    def get_video_feed():
        if controller._latest_frame_bytes is None:
            return JSONResponse(
                status_code=503,
                content={"ok": False, "error": "CAMERA_NOT_ATTACHED"},
            )
        return Response(content=controller._latest_frame_bytes, media_type=controller._latest_frame_mime)

    @app.get("/bev_image")
    def get_bev_image():
        if controller._latest_frame_bytes is None:
            return JSONResponse(
                status_code=503,
                content={"ok": False, "error": "BEV_FRAME_UNAVAILABLE"},
            )
        return Response(content=controller._latest_frame_bytes, media_type=controller._latest_frame_mime)

    @app.get("/map_feed")
    def get_map_feed():
        return Response(content=controller.render_map_svg(), media_type="image/svg+xml")

    @app.post("/calibration/homography", dependencies=[Depends(require_bearer_auth)])
    def post_homography(payload: dict[str, Any] | None = None):
        body = payload or {}
        code, data = controller.set_homography_matrix(body.get("matrix"))
        return JSONResponse(status_code=code, content=data)

    @app.post("/model/load", dependencies=[Depends(require_bearer_auth)])
    def post_load_model(payload: dict[str, Any] | None = None):
        body = payload or {}
        code, data = controller.load_weed_model(body.get("model_path"))
        return JSONResponse(status_code=code, content=data)

    @app.post("/detections", dependencies=[Depends(require_bearer_auth)])
    def post_detections(payload: dict[str, Any] | None = None):
        body = payload or {}
        code, data = controller.handle_detection(
            class_name=str(body.get("class_name", "")),
            confidence=body.get("confidence", 0.0),
            u_px=body.get("u_px", 0.0),
            v_px=body.get("v_px", 0.0),
        )
        return JSONResponse(status_code=code, content=data)

    @app.post("/treatment/execute_next", dependencies=[Depends(require_bearer_auth)])
    def post_treatment_execute_next():
        code, data = controller.execute_next_treatment_target()
        return JSONResponse(status_code=code, content=data)

    return app


def create_default_app(simulate: bool | None = None, worker_hz: float | None = None):
    """
    Build the ready-to-run global FastAPI ASGI app for Raspberry Pi 5:
      PI_API_TOKEN=your-secret uvicorn Navigation.src.pi_server:app --host 0.0.0.0 --port 8000
    """
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    cfg_rel = os.environ.get("WEED_ROVER_CONFIG", "Navigation/rover_config.yaml")
    cfg_path = cfg_rel if os.path.isabs(cfg_rel) else os.path.join(repo_root, cfg_rel)
    config = load_yaml_config(cfg_path)
    sim_flag = (
        simulate
        if simulate is not None
        else os.environ.get("WEED_ROVER_SIMULATE", "false").strip().lower() in ("1", "true", "yes")
    )
    hz_val = (
        worker_hz
        if worker_hz is not None
        else float(os.environ.get("WEED_ROVER_LOOP_HZ", "10.0"))
    )
    return create_fastapi_app(
        config=config,
        simulate=sim_flag,
        start_worker=True,
        worker_hz=hz_val,
    )


# Export global, ready-to-run FastAPI application object for ASGI servers (uvicorn/gunicorn).
# Only falls back to None when FastAPI itself is not installed in a minimal unit-test environment.
try:
    import fastapi as _fastapi_check  # noqa: F401
except ImportError:
    app = None
else:
    app = create_default_app()


if __name__ == "__main__":
    import uvicorn

    if app is None:
        raise RuntimeError("FastAPI is not installed. Run: pip install -r Navigation/requirements.txt")
    port = int(os.environ.get("WEED_ROVER_PORT", "8000"))
    host = os.environ.get("WEED_ROVER_HOST", "0.0.0.0")
    uvicorn.run(app, host=host, port=port)

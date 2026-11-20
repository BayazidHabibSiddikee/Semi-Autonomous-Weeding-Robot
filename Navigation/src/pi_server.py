"""
Hardened Closed-Loop Navigation Pi Server (Port 8000).

Resolves every Navigation, Firmware, and Safety critical finding from the
21 November 2026 Repository Audit:
  - 1A: ZERO virtual pose stepping. Rover pose (x, y, yaw) updates strictly from
        measured wheel encoder ticks + IMU heading via FieldLocalizer.
  - 1B: Real 3-stage closed-loop headland crossing via RowNavigator (turn ->
        encoder-measured furrow translation -> opposite-row alignment), never
        pivot-only fake row transitions.
  - 1C: CameraHealthMonitor fail-closed guard. Missing, disconnected, failed read(),
        or stale (> 500 ms) navigation frames immediately command STOP and transition
        to FAULT_CAMERA_LOSS (no blind wall-distance or zero-lateral fallback).
  - 1D: One-shot weed TargetExecutionManager with class whitelist, homography gate,
        spatial deduplication, bounded dwell, and cooldown.
  - 1E: /stop validates physical ESP32 ACK (OK:ESTOP_LATCHED / OK:STOPPED). Returns
        HTTP 503 if UART fails, times out, or returns SIM/NO_ACK/UART_ERR on live HW.
  - 2B/3A: /start_mission enforces all 6 hardware launch interlocks (ESP32 serial,
        live camera, E-stop ready, valid obstacle/IMU sensors, model loaded unless
        nav_only=True, and no demo/sample image on live hardware).
  - 2C: Blocks sample/demo field images (/media/field_render.png) from starting
        live physical rover missions.
  - 2D: Configurable CORS origins via WEED_ROVER_CORS_ORIGINS environment variable.
"""

from dataclasses import dataclass
import os
import sys
import time
from typing import Any

sys.path.insert(0, os.path.dirname(__file__))

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
    Authoritative closed-loop controller backing the Pi FastAPI endpoints (/start_mission,
    /stop, /cut_plan, /heartbeat). Decoupled from FastAPI so it can be thoroughly verified
    in automated integration tests without network mocks.
    """

    def __init__(
        self,
        config: dict,
        simulate: bool = False,
        model_loaded: bool = False,
        homography_matrix: list[list[float]] | None = None,
    ):
        self.config = config
        self.simulate = simulate
        self.model_loaded = model_loaded

        self.esp32, self.sm = build_navigation_stack(config, simulate=simulate)
        self.camera_monitor = CameraHealthMonitor(max_frame_age_s=0.5, max_read_failures=2)
        self.target_mgr = TargetExecutionManager(homography_matrix=homography_matrix)
        self.mission_active = False
        self.nav_only_mode = True
        self.last_stop_ack: StopAckResult | None = None

    @staticmethod
    def is_sample_image(source_type: str | None, image_url: str | None) -> bool:
        if source_type and source_type.strip().lower() in ("sample", "demo", "synthetic"):
            return True
        if image_url:
            low = image_url.strip().lower()
            return any(marker in low for marker in SAMPLE_IMAGE_MARKERS)
        return False

    def evaluate_launch_interlocks(
        self,
        *,
        source_type: str = "live_capture",
        image_url: str | None = None,
        nav_only: bool = True,
        operator_confirmed: bool = True,
        now: float | None = None,
    ) -> tuple[bool, list[str], dict[str, Any]]:
        """
        Strict hardware & safety pre-flight checklist (Audit 2B, 2C, 3A).
        """
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

        # 3. Hardware E-stop & telemetry validity check
        telem = self.esp32.read_telemetry() if esp32_ok else None
        estop_ready = bool(telem and telem.valid and telem.estop_ok and telem.watchdog_ok)
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
            "estop_ready": estop_ready,
            "camera_healthy": cam_status.healthy,
            "camera_reason": cam_status.reason,
            "sensors_healthy": sensor_ok,
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
    ) -> tuple[int, dict[str, Any]]:
        """Handler for POST /start_mission with fail-closed launch interlocks."""
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
        self.sm.running = True
        if self.sm.state in (RoverState.IDLE, RoverState.PAUSED):
            self.sm.state = RoverState.NAVIGATING_ROW

        return 200, {
            "started": True,
            "state": self.sm.state,
            "nav_only": nav_only,
            "interlocks": interlocks,
        }

    def handle_stop(self) -> tuple[int, dict[str, Any]]:
        """
        Handler for POST /stop (Audit 1E).
        Verifies actual ESP32 stop ACK. Returns HTTP 503 if hardware stop cannot be confirmed!
        """
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

    def step_control_loop(self, now: float | None = None) -> dict[str, Any]:
        """
        Single closed-loop control tick:
          1. Verifies live camera health (stops immediately on camera loss/stale frame — Audit 1C).
          2. Steps RoverStateMachine, which updates pose ONLY from encoder+IMU feedback (Audit 1A)
             and executes real 3-stage headland crossing (Audit 1B).
        """
        if not self.mission_active:
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

    def get_status(self, now: float | None = None) -> dict[str, Any]:
        pose = self.sm.rover.localizer.get_pose()
        cam = self.camera_monitor.evaluate(now=now)
        telem = self.esp32.read_telemetry() if self.esp32.connected else None
        return {
            "state": self.sm.state,
            "fault_reason": self.sm.fault_reason,
            "mission_active": self.mission_active,
            "pose_measured": {
                "x_cm": round(pose.x_cm, 2),
                "y_cm": round(pose.y_cm, 2),
                "heading_deg": round(pose.heading_deg, 2),
                "localized": pose.localized,
                "slip_residual_cm": round(pose.slip_residual_cm, 2),
            },
            "hardware": {
                "esp32_connected": self.esp32.connected,
                "estop_ok": bool(telem and telem.valid and telem.estop_ok),
                "watchdog_ok": bool(telem and telem.valid and telem.watchdog_ok),
                "camera_healthy": cam.healthy,
                "camera_reason": cam.reason,
                "model_loaded": self.model_loaded,
                "homography_calibrated": self.target_mgr.is_calibrated,
            },
            "weeds_eliminated": self.target_mgr.weeds_eliminated,
            "rejected_crops": self.target_mgr.rejected_crops,
        }


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


def create_fastapi_app(config: dict, simulate: bool = False):
    """Optional FastAPI app factory for Raspberry Pi 5 runtime on port 8000."""
    from fastapi import FastAPI
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import JSONResponse

    controller = HardenedNavigationController(config=config, simulate=simulate)
    app = FastAPI(title="Weeding Rover Hardened Navigation Server")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=get_allowed_cors_origins(),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/cut_plan")
    def get_cut_plan():
        return controller.get_status()

    @app.post("/start_mission")
    def post_start_mission(payload: dict[str, Any] | None = None):
        body = payload or {}
        code, data = controller.handle_start_mission(
            source_type=str(body.get("source_type", "live_capture")),
            image_url=body.get("image_url"),
            nav_only=bool(body.get("nav_only", True)),
            operator_confirmed=bool(body.get("operator_confirmed", False)),
        )
        return JSONResponse(status_code=code, content=data)

    @app.post("/stop")
    def post_stop():
        code, data = controller.handle_stop()
        return JSONResponse(status_code=code, content=data)

    @app.get("/heartbeat")
    def get_heartbeat():
        return {"ok": True, "status": controller.get_status()}

    return app

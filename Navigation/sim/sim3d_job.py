#!/usr/bin/env python3
"""
Photo -> FreeCAD digital twin -> weeding animation video, as a background job
kicked off by the mission server after a successful photo upload.

Flow (thread):
  1. scene_spec.build_spec()   : BEV artifact -> rows/lanes/weeds JSON
  2. FreeCAD (RPC localhost:9875):
       photo_scene.build_and_animate() builds the twin (real CAD rover) and
       renders `frames` screenshots
  3. ffmpeg assembles the .mp4 into the outbox
  4. GET /sim3d reports state + the video artifact name
"""
from __future__ import annotations

import json
import os
import subprocess
import threading
import time
import xmlrpc.client
from typing import Any, Dict, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
OUTBOX = os.path.join(HERE, "outbox")
FRAMES_DIR = "/tmp/photo_sim_frames"
STATS_FILE = "/tmp/photo_sim_stats.json"
SPEC_FILE = "/tmp/photo_scene.json"
FREECAD_SCRIPT_DIR = os.path.join(REPO, "Navigation", "freeCAD_sim_marker")

FREECAD_RPC_URL = "http://127.0.0.1:9875"


def _freecad_code(spec_path: str, out_dir: str, frames: int, laser_m: float) -> str:
    sim_dir = os.path.join(REPO, "Navigation", "sim")
    return f'''
import os
import sys
import json
sys.path.append({sim_dir!r})
import photo_scene
import freecad_field_sim as sim
scene = photo_scene.build_scene_from_spec(doc_name="PhotoFieldSim", spec_path={spec_path!r})
files, stats = sim.animate(scene, frames={int(frames)}, out_dir={out_dir!r}, laser_range={float(laser_m)})
fcstd = os.path.join({sim_dir!r}, "photo_field_sim.FCStd")
scene["doc"].saveAs(fcstd)
res = {{"killed": stats.get("killed", 0), "weeds_total": len(scene["weeds"]), "frames": len(files)}}
_json = open("/tmp/photo_sim_stats.json", "w")
json.dump(res, _json)
_json.close()
try:
    res
except Exception:
    res = {{"killed": 0, "weeds_total": 0, "frames": 0}}
'''


class Sim3dJob:
    """One 3D-simulation render job (photo digital twin video)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.state: Dict[str, Any] = {
            "state": "idle",
            "frames": 0,
            "weeds": 0,
            "killed": 0,
            "video": "",
            "error": None,
            "updated": time.time(),
        }
        self._analysis = None
        self._params = {}

    # ---------------------------------------------------------------- api
    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            return dict(self.state)

    def _put(self, **kv: Any) -> None:
        with self._lock:
            self.state.update(kv)
            self.state["updated"] = time.time()

    def start(
        self,
        analysis,
        width_m: float,
        length_m: float,
        laser_range_m: float = 0.30,
        weed_threshold: float = 50.0,
        speed_mps: float = 0.5,
        force: bool = False,
    ) -> Optional[bool]:
        """Kick off the render; returns False if one is already running."""
        with self._lock:
            if self.state.get("state") in ("spec", "render", "encode") and not force:
                self.state["error"] = "a render job is already running"
                return False
        if analysis is not None:
            self._analysis = analysis
            self._params = {
                "width": width_m,
                "length": length_m,
                "laser": laser_range_m,
                "threshold": weed_threshold,
                "speed": speed_mps,
            }
        bev = getattr(self._analysis, "bev_path", None) if self._analysis else None
        if not bev or not os.path.isfile(bev):
            bev = self._latest_bev()
        if not bev:
            self._put(state="error", error="no BEV artifact from a photo upload yet")
            return None

        self._put(state="spec", video="", error=None, killed=0)
        threading.Thread(target=self._run, args=(bev,), daemon=True).start()
        return True

    # ------------------------------------------------------------ internals
    @staticmethod
    def _latest_bev() -> str:
        import glob
        files = sorted(glob.glob(os.path.join(OUTBOX, "*_bev.jpg")))
        return files[-1] if files else ""

    def _run(self, bev_path: str) -> None:
        import sys
        try:
            sys.path.insert(0, os.path.join(REPO, "sim") if os.path.isdir(
                os.path.join(REPO, "sim")) else HERE)
            import scene_spec

            p = self._params
            t = max(0.0, min(p.get("threshold", 50.0), 100.0))
            band_frac = 0.25 * (1.0 + (t - 50.0) / 100.0)      # stricter rows
            weed_min_area = int(18 * (1.0 + (t - 50.0) / 50.0))  # bigger weeds only

            spec = scene_spec.build_spec(
                bev_path, p.get("width", 6.0), p.get("length", 8.0),
                band_frac=band_frac,
                weed_min_area=weed_min_area,
                out_path=SPEC_FILE,
            )
            # animation density from the requested rover speed
            path_len = 2.0 * len(spec["lanes_y_m"]) * (p.get("length", 8.0) - 0.4)
            frames = int(path_len / max(p.get("speed", 0.5) * 0.6, 0.05))
            frames = max(60, min(frames, 400))
            self._put(state="render", frames=frames,
                      weeds=len(spec["weeds"]), lanes=len(spec["lanes_y_m"]))

            os.makedirs(FRAMES_DIR, exist_ok=True)
            for f in os.listdir(FRAMES_DIR):
                os.remove(os.path.join(FRAMES_DIR, f))

            rpc = xmlrpc.client.ServerProxy(FREECAD_RPC_URL, allow_none=True)
            code = _freecad_code(SPEC_FILE, FRAMES_DIR, frames, p.get("laser", 0.30))
            rpc.execute_code(code, 1700)

            with open(STATS_FILE) as fh:
                stats = json.load(fh)
            self._put(state="encode", killed=stats.get("killed", 0),
                      weeds=stats.get("weeds_total", 0),
                      frames=stats.get("frames", 0))

            ts = int(time.time() * 1000)
            out_mp4 = os.path.join(OUTBOX, f"photo_sim_{ts}.mp4")
            cmd = [
                "ffmpeg", "-y", "-loglevel", "error", "-framerate", "15",
                "-i", os.path.join(FRAMES_DIR, "frame_%04d.png"),
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", out_mp4,
            ]
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
            if proc.returncode != 0 or not os.path.isfile(out_mp4):
                raise RuntimeError(f"ffmpeg failed: {proc.stderr[:300]}")

            # keep only the newest 4 videos around
            vids = sorted(
                (f for f in os.listdir(OUTBOX) if f.startswith("photo_sim_")),
                key=lambda f: os.path.getctime(os.path.join(OUTBOX, f)),
            )
            for old in vids[:-4]:
                os.remove(os.path.join(OUTBOX, old))

            self._put(state="done", video=os.path.basename(out_mp4))
        except xmlrpc.client.Fault as exc:
            self._put(state="error", error=f"FreeCAD render failed: {exc.faultString[:200] if exc.faultString else exc}")
        except Exception as exc:  # noqa: BLE001
            self._put(state="error", error=str(exc)[:300])


_singleton: Optional[Sim3dJob] = None


def get() -> Sim3dJob:
    global _singleton
    if _singleton is None:
        _singleton = Sim3dJob()
    return _singleton

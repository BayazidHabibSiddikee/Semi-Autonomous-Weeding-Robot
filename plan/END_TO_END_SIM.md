# End-to-End Simulation: Android → Pi → ESP32 → Rover

The whole product chain can be simulated on one machine, with no hardware.

```
┌──────────────────┐   HTTP POST /mission   ┌─────────────────┐   serial protocol  ┌────────────┐
│  "Android app"   │ ──────────────────────► │  Pi 5 server    │ ─────────────────► │   ESP32    │
│  end_to_end_sim  │                         │ mission_server  │  MOVE/SERVO/LASER │  virtual   │
│  · photo         │ ◄── GET /status ────── │ mission_executor│                    │  (sim)     │
│  · BEV + rows    │                         │                 │                    └─────┬──────┘
│  · mission JSON  │                         └─────────────────┘                          │
└──────────────────┘                                                                  ▼
                                                                            ┌────────────────┐
                                                                            │  Field sim     │
                                                                            │  crops + weeds │
                                                                            └────────────────┘
```

## Run it

```bash
# terminal 1 - the Pi side
python3 Navigation/sim/mission_server.py --port 8080

# terminal 2 - the phone side
python3 Navigation/sim/end_to_end_sim.py --image Navigation/images/field_topview.jpeg
```

Expected output:

```
[APP] ExG cut=44  rows detected=13  corners=4
[APP] POSTing mission to http://127.0.0.1:8080/mission ...
[APP] server accepted: {'accepted': True, 'rows': 13, 'waypoints': 26, 'distanceM': 109.12}
[APP] state=DONE rows=13/13 killed=39 remaining=0
```

## Pieces

| File | Role |
|---|---|
| `Navigation/src/mission_planner.py` | Parses the app's `Mission` JSON → waypoints (the Pi only needs the wire format) |
| `Navigation/src/virtual_esp32.py` | ESP32 firmware simulator: `MOVE F/B/R/L/T/S`, `SERVO PAN/TILT`, `LASER ON/OFF`, `ULTRASONIC?` |
| `Navigation/src/mission_executor.py` | Pure-pursuit driving + stop→scan→aim→fire→move cycle |
| `Navigation/sim/mission_server.py` | HTTP server: `POST /mission`, `GET /status`, `GET /plan`, `GET /health` |
| `Navigation/sim/end_to_end_sim.py` | Plays the phone: photo → CV → mission JSON → HTTP → status polling |
| `Navigation/src/field_analyzer_reference.py` | Python mirror of the Android `FieldAnalyzer` (used to validate the port) |

## The mission JSON contract

The Pi and the app only share this JSON. Example (exactly what the app sends):

```json
{
  "version": 1,
  "field": {"widthM": 6.0, "lengthM": 8.0, "totalRows": 9,
            "rowSpacingM": 0.75, "originCorner": "TOP_LEFT"},
  "path": [
    {"type": "FollowRow", "seq": 1, "row": 1, "expectedDistM": 8.0,
     "turnAfter": "RIGHT",
     "startPoint": {"x": 0.0, "y": 0.4}, "endPoint": {"x": 8.0, "y": 0.4}},
    {"type": "Turn", "seq": 2, "direction": "RIGHT", "gapM": 0.75,
     "startPoint": {"x": 8.0, "y": 0.4}, "endPoint": {"x": 8.0, "y": 1.15}}
  ],
  "attentionWindow": {"startM": 7.0, "endM": 8.5},
  "generatedAt": 1700000000000
}
```

## Notes / next steps

- The simulated field is **built from the plan** (`FieldSimulator(rows_y_cm=...)`):
  crop rows are placed exactly where the mission drives, weeds are scattered
  along them. That is why a photo-driven plan can be validated end to end.
- `MissionExecutor._run_on_hardware()` is still a stub - it needs the real
  `ESP32Bridge` wired in (same interface as `VirtualESP32`).
- The Android app should poll `GET /status` to show progress; that endpoint
  already returns `rowsDone`, `weedsKilled`, `weedsRemaining` and `state`.

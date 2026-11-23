"""
Simpla Bot — Simplified MaixSense-A075V + Normal Motor Driver + Flame/Grinder Stack.

A zero-ROS, minimal-hardware weeding robot stack designed for:
  - Sipeed MaixSense-A075V (ToF Depth + RGB camera over USB-RNDIS) for all spatial sensing:
    corners, row ends, obstacle stopping, exact distance-to-go, and weed distance-to-tool.
  - Normal Motor Driver (L298N, BTS7960, Cytron, or serial Arduino/ESP32 bridge).
  - Flame Control + Grinding Machine relays with strict hardware/software safety interlocks.
"""

__version__ = "1.0.0"

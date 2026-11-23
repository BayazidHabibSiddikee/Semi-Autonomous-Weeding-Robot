#!/usr/bin/env python3
"""
Pure-Python PDF 1.4 Generator for Simpla Bot Manual (simpla_bot/SIMPLA_BOT_MANUAL.pdf).

Zero third-party dependencies (stdlib only) so the manual can always be built or
regenerated on any Raspberry Pi, Linux, macOS, or Windows machine.
"""

from __future__ import annotations

from pathlib import Path
from typing import List, Tuple


PAGE_W = 612  # US Letter width in points (8.5 in)
PAGE_H = 792  # US Letter height in points (11.0 in)
MARGIN_X = 48
MARGIN_TOP = 54
MARGIN_BOTTOM = 54
CONTENT_W = PAGE_W - 2 * MARGIN_X


def _pdf_escape(text: str) -> str:
    """Escape ASCII text for PDF literal strings."""
    safe = text.encode("ascii", errors="replace").decode("ascii")
    return safe.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def _wrap_text(text: str, max_chars: int) -> List[str]:
    if not text:
        return [""]
    words = text.split(" ")
    lines: List[str] = []
    cur = ""
    for w in words:
        if not cur:
            cur = w
        elif len(cur) + 1 + len(w) <= max_chars:
            cur += " " + w
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


class SimplePDFBuilder:
    """Minimal, spec-compliant PDF 1.4 layout engine with Type1 Helvetica & Courier fonts."""

    def __init__(self, doc_title: str) -> None:
        self.doc_title = doc_title
        self.pages: List[List[str]] = []
        self.cur_cmds: List[str] = []
        self.y: float = PAGE_H - MARGIN_TOP

    def _start_page(self, with_header: bool = True) -> None:
        if self.cur_cmds:
            self.pages.append(self.cur_cmds)
        self.cur_cmds = []
        self.y = PAGE_H - MARGIN_TOP
        if with_header:
            # Subtle top header rule
            self.cur_cmds.append("0.15 0.35 0.25 rg")
            self.cur_cmds.append(
                f"BT /F2 8.5 Tf {MARGIN_X} {PAGE_H - 32} Td "
                f"({_pdf_escape('SIMPLA BOT TECHNICAL & OPERATOR MANUAL  |  BRANCH: simpla_bot')}) Tj ET"
            )
            self.cur_cmds.append("0.78 0.84 0.80 RG 0.8 w")
            self.cur_cmds.append(
                f"{MARGIN_X} {PAGE_H - 38} m {PAGE_W - MARGIN_X} {PAGE_H - 38} l S"
            )
            self.y = PAGE_H - 58

    def ensure_space(self, needed_pts: float) -> None:
        if self.y - needed_pts < MARGIN_BOTTOM + 16:
            self._start_page(with_header=True)

    def add_cover_page(self) -> None:
        self._start_page(with_header=False)
        # Top dark forest accent banner
        self.cur_cmds.append("0.10 0.28 0.20 rg")
        self.cur_cmds.append(f"0 {PAGE_H - 210} {PAGE_W} 210 re f")

        # Accent orange safety stripe
        self.cur_cmds.append("0.88 0.42 0.12 rg")
        self.cur_cmds.append(f"0 {PAGE_H - 218} {PAGE_W} 8 re f")

        # Cover Title
        self.cur_cmds.append("1 1 1 rg")
        self.cur_cmds.append(
            f"BT /F2 28 Tf {MARGIN_X} {PAGE_H - 95} Td (SIMPLA BOT) Tj ET"
        )
        self.cur_cmds.append(
            f"BT /F1 15 Tf {MARGIN_X} {PAGE_H - 125} Td "
            f"(Complete Hardware, Wiring & Operation Manual) Tj ET"
        )
        self.cur_cmds.append("0.82 0.94 0.87 rg")
        self.cur_cmds.append(
            f"BT /F1 11 Tf {MARGIN_X} {PAGE_H - 158} Td "
            f"(Sipeed MaixSense-A075V  +  Normal Motor Driver  +  Flame Control & Grinder) Tj ET"
        )
        self.cur_cmds.append(
            f"BT /F3 10 Tf {MARGIN_X} {PAGE_H - 184} Td "
            f"(Git Branch: simpla_bot   |   Version 1.0   |   Zero-ROS Standalone Python 3) Tj ET"
        )

        # Summary Spec Box
        box_y = PAGE_H - 425
        self.cur_cmds.append("0.95 0.97 0.96 rg")
        self.cur_cmds.append(f"{MARGIN_X} {box_y} {CONTENT_W} 170 re f")
        self.cur_cmds.append("0.15 0.35 0.25 RG 1 w")
        self.cur_cmds.append(f"{MARGIN_X} {box_y} {CONTENT_W} 170 re S")

        self.cur_cmds.append("0.10 0.28 0.20 rg")
        self.cur_cmds.append(
            f"BT /F2 12 Tf {MARGIN_X + 16} {box_y + 144} Td (WHAT THIS ROBOT USES) Tj ET"
        )
        specs = [
            "1. Sensor (All Spatial Logic): Sipeed MaixSense-A075V ToF Depth + RGB (USB-RNDIS 192.168.233.1)",
            "   Detects corners (Left/Right/Dead-End/Row-End), distance-to-go (mm), obstacles & weeds.",
            "2. Drive Control: Standard Normal Motor Driver (L298N, BTS7960, or Arduino USB Serial).",
            "   Direct Raspberry Pi GPIO or Arduino Uno/Nano hardware watchdog bridge.",
            "3. Weeding Tools ONLY: 2-Channel Opto-Isolated Relay for Grinding Machine + Flame Control.",
            "4. Safety First: dry_run=True default, stationary interlock, 2.5s flame cap, physical E-Stop.",
        ]
        ty = box_y + 120
        self.cur_cmds.append("0.15 0.18 0.16 rg")
        for line in specs:
            self.cur_cmds.append(
                f"BT /F1 9.5 Tf {MARGIN_X + 16} {ty} Td ({_pdf_escape(line)}) Tj ET"
            )
            ty -= 18

        # Table of Contents
        toc_y = box_y - 36
        self.cur_cmds.append("0.10 0.28 0.20 rg")
        self.cur_cmds.append(
            f"BT /F2 13 Tf {MARGIN_X} {toc_y} Td (TABLE OF CONTENTS) Tj ET"
        )
        toc_items = [
            "1. System Architecture & Bill of Materials (BOM)",
            "2. Wiring Diagrams & Pinout Tables (Raspberry Pi GPIO + Arduino Serial)",
            "3. Sipeed MaixSense-A075V Mounting, USB-RNDIS Setup & Protocol",
            "4. Corner Detection, Distance-to-Go Math & Weed-to-Tool Alignment",
            "5. Normal Motor Driver Calibration (Distance, 90-Deg Turns & Tool Offset)",
            "6. Flame Control & Grinding Machine Safety Interlocks (5 Layers)",
            "7. Step-by-Step Bench Test, Dry-Run & Armed Field Operation",
            "8. Troubleshooting Guide & Creating the simpla_bot Git Branch",
        ]
        ty = toc_y - 22
        self.cur_cmds.append("0.18 0.20 0.19 rg")
        for item in toc_items:
            self.cur_cmds.append(
                f"BT /F1 10.5 Tf {MARGIN_X + 12} {ty} Td ({_pdf_escape(item)}) Tj ET"
            )
            ty -= 17

        # Red Safety Banner at bottom of cover
        warn_y = 66
        self.cur_cmds.append("0.98 0.92 0.90 rg")
        self.cur_cmds.append(f"{MARGIN_X} {warn_y} {CONTENT_W} 68 re f")
        self.cur_cmds.append("0.78 0.16 0.12 RG 1.2 w")
        self.cur_cmds.append(f"{MARGIN_X} {warn_y} {CONTENT_W} 68 re S")
        self.cur_cmds.append("0.72 0.12 0.08 rg")
        self.cur_cmds.append(
            f"BT /F2 10.5 Tf {MARGIN_X + 12} {warn_y + 48} Td "
            f"(CRITICAL SAFETY NOTICE - READ BEFORE POWERING ON) Tj ET"
        )
        self.cur_cmds.append("0.20 0.10 0.10 rg")
        self.cur_cmds.append(
            f"BT /F1 9 Tf {MARGIN_X + 12} {warn_y + 30} Td "
            f"(Always wire a physical Normally-Closed E-Stop switch in series with 12V motor, grinder & gas valve power.) Tj ET"
        )
        self.cur_cmds.append(
            f"BT /F1 9 Tf {MARGIN_X + 12} {warn_y + 15} Td "
            f"(Complete all bench & dry-run tests with wheels elevated and gas supply CLOSED before passing --arm-tools.) Tj ET"
        )

        # Start main content on page 2
        self._start_page(with_header=True)

    def add_section(self, title: str) -> None:
        # Reserve space for section bar + at least 65pt of following body/table so headers never orphan
        self.ensure_space(100)
        self.y -= 8
        bar_h = 22
        self.cur_cmds.append("0.12 0.32 0.22 rg")
        self.cur_cmds.append(f"{MARGIN_X} {self.y - bar_h + 6} {CONTENT_W} {bar_h} re f")
        self.cur_cmds.append("1 1 1 rg")
        self.cur_cmds.append(
            f"BT /F2 11.5 Tf {MARGIN_X + 10} {self.y - 10} Td ({_pdf_escape(title)}) Tj ET"
        )
        self.y -= (bar_h + 10)

    def add_subheading(self, title: str) -> None:
        # Reserve space for subheading + following content so subheadings never orphan at page bottom
        self.ensure_space(82)
        self.y -= 4
        self.cur_cmds.append("0.14 0.36 0.24 rg")
        self.cur_cmds.append(
            f"BT /F2 10.5 Tf {MARGIN_X} {self.y} Td ({_pdf_escape(title)}) Tj ET"
        )
        self.y -= 15

    def add_paragraph(self, text: str, indent: int = 0) -> None:
        max_chars = max(40, int((CONTENT_W - indent) / 5.4))
        lines = _wrap_text(text, max_chars)
        self.ensure_space(len(lines) * 13.5 + 6)
        self.cur_cmds.append("0.14 0.16 0.15 rg")
        for line in lines:
            self.cur_cmds.append(
                f"BT /F1 9.8 Tf {MARGIN_X + indent} {self.y} Td ({_pdf_escape(line)}) Tj ET"
            )
            self.y -= 13.5
        self.y -= 3

    def add_bullet(self, lead: str, body: str) -> None:
        full = f"- {lead}: {body}" if lead else f"- {body}"
        lines = _wrap_text(full, 88)
        self.ensure_space(len(lines) * 13 + 3)
        self.cur_cmds.append("0.14 0.16 0.15 rg")
        for idx, line in enumerate(lines):
            x = MARGIN_X + (8 if idx == 0 else 18)
            self.cur_cmds.append(
                f"BT /F1 9.5 Tf {x} {self.y} Td ({_pdf_escape(line)}) Tj ET"
            )
            self.y -= 13
        self.y -= 1.5

    def add_code_block(self, lines: List[str]) -> None:
        h = len(lines) * 11.2 + 12
        self.ensure_space(h + 6)
        top = self.y + 4
        self.cur_cmds.append("0.94 0.96 0.95 rg")
        self.cur_cmds.append(f"{MARGIN_X} {top - h} {CONTENT_W} {h} re f")
        self.cur_cmds.append("0.75 0.80 0.77 RG 0.6 w")
        self.cur_cmds.append(f"{MARGIN_X} {top - h} {CONTENT_W} {h} re S")
        self.cur_cmds.append("0.10 0.15 0.12 rg")
        cy = top - 13
        for line in lines:
            self.cur_cmds.append(
                f"BT /F3 8.0 Tf {MARGIN_X + 10} {cy} Td ({_pdf_escape(line[:98])}) Tj ET"
            )
            cy -= 11.2
        self.y = top - h - 9

    def add_callout(self, title: str, body: str) -> None:
        wrapped = _wrap_text(body, 86)
        h = 22 + len(wrapped) * 12.5 + 8
        self.ensure_space(h + 8)
        top = self.y + 4
        self.cur_cmds.append("0.99 0.94 0.90 rg")
        self.cur_cmds.append(f"{MARGIN_X} {top - h} {CONTENT_W} {h} re f")
        self.cur_cmds.append("0.85 0.36 0.10 RG 1 w")
        self.cur_cmds.append(f"{MARGIN_X} {top - h} {CONTENT_W} {h} re S")
        self.cur_cmds.append("0.72 0.24 0.05 rg")
        self.cur_cmds.append(
            f"BT /F2 9.5 Tf {MARGIN_X + 10} {top - 15} Td ({_pdf_escape(title)}) Tj ET"
        )
        self.cur_cmds.append("0.22 0.14 0.10 rg")
        cy = top - 30
        for line in wrapped:
            self.cur_cmds.append(
                f"BT /F1 9 Tf {MARGIN_X + 10} {cy} Td ({_pdf_escape(line)}) Tj ET"
            )
            cy -= 12.5
        self.y = top - h - 10

    def add_table(self, headers: List[str], rows: List[List[str]], col_widths: List[int]) -> None:
        row_h = 17
        needed = row_h * (len(rows) + 1) + 10
        if needed > PAGE_H - MARGIN_TOP - MARGIN_BOTTOM - 40:
            # Allow multi-page table by checking per row
            self.ensure_space(row_h * 3)
        else:
            self.ensure_space(needed)

        def draw_row(cells: List[str], is_header: bool, zebra: bool) -> None:
            self.ensure_space(row_h + 6)
            top = self.y + 4
            if is_header:
                self.cur_cmds.append("0.16 0.36 0.26 rg")
                self.cur_cmds.append(f"{MARGIN_X} {top - row_h} {CONTENT_W} {row_h} re f")
            elif zebra:
                self.cur_cmds.append("0.95 0.97 0.96 rg")
                self.cur_cmds.append(f"{MARGIN_X} {top - row_h} {CONTENT_W} {row_h} re f")
            self.cur_cmds.append("0.80 0.84 0.81 RG 0.4 w")
            self.cur_cmds.append(f"{MARGIN_X} {top - row_h} {CONTENT_W} {row_h} re S")

            cx = MARGIN_X + 6
            for text, width in zip(cells, col_widths):
                max_ch = max(6, int((width - 8) / 4.9))
                clipped = text if len(text) <= max_ch else text[: max_ch - 2] + ".."
                if is_header:
                    self.cur_cmds.append("1 1 1 rg")
                    font = "/F2 8.5 Tf"
                else:
                    self.cur_cmds.append("0.14 0.16 0.15 rg")
                    font = "/F1 8.4 Tf"
                self.cur_cmds.append(
                    f"BT {font} {cx} {top - 12} Td ({_pdf_escape(clipped)}) Tj ET"
                )
                cx += width
            self.y -= row_h

        draw_row(headers, is_header=True, zebra=False)
        for idx, row in enumerate(rows):
            draw_row(row, is_header=False, zebra=(idx % 2 == 1))
        self.y -= 8

    def render_bytes(self) -> bytes:
        if self.cur_cmds:
            self.pages.append(self.cur_cmds)
            self.cur_cmds = []

        total_pages = len(self.pages)
        # Stamp footers onto all pages except cover (page 1)
        for idx, cmds in enumerate(self.pages):
            page_num = idx + 1
            if page_num > 1:
                cmds.append("0.78 0.84 0.80 RG 0.6 w")
                cmds.append(f"{MARGIN_X} 42 m {PAGE_W - MARGIN_X} 42 l S")
                cmds.append("0.40 0.46 0.43 rg")
                cmds.append(
                    f"BT /F1 8 Tf {MARGIN_X} 28 Td "
                    f"(Simpla Bot Manual  -  MaixSense-A075V + Normal Motor Driver + Flame & Grinder) Tj ET"
                )
                cmds.append(
                    f"BT /F2 8.5 Tf {PAGE_W - MARGIN_X - 58} 28 Td "
                    f"(Page {page_num} of {total_pages}) Tj ET"
                )

        # Build PDF objects:
        # 1: Catalog, 2: Pages, 3: Helvetica, 4: Helvetica-Bold, 5: Courier
        # 6.. : alternating Page object and Content Stream object
        objects: List[bytes] = []
        page_obj_ids: List[int] = []

        # Placeholders for 1..5
        objects.append(b"")  # 1 Catalog
        objects.append(b"")  # 2 Pages
        objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
        objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>")
        objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>")

        for cmds in self.pages:
            stream_data = ("\n".join(cmds) + "\n").encode("ascii")
            page_id = len(objects) + 1
            content_id = page_id + 1
            page_obj_ids.append(page_id)

            page_dict = (
                f"<< /Type /Page /Parent 2 0 R "
                f"/MediaBox [0 0 {PAGE_W} {PAGE_H}] "
                f"/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> "
                f"/Contents {content_id} 0 R >>"
            ).encode("ascii")
            content_obj = (
                f"<< /Length {len(stream_data)} >>\nstream\n".encode("ascii")
                + stream_data
                + b"endstream"
            )
            objects.append(page_dict)
            objects.append(content_obj)

        kids_ref = " ".join(f"{pid} 0 R" for pid in page_obj_ids)
        objects[0] = b"<< /Type /Catalog /Pages 2 0 R >>"
        objects[1] = f"<< /Type /Pages /Kids [{kids_ref}] /Count {len(page_obj_ids)} >>".encode("ascii")

        # Assemble PDF with accurate byte offsets for xref table
        out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
        offsets: List[int] = [0]
        for obj_num, body in enumerate(objects, start=1):
            offsets.append(len(out))
            out.extend(f"{obj_num} 0 obj\n".encode("ascii"))
            out.extend(body)
            out.extend(b"\nendobj\n")

        xref_pos = len(out)
        out.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
        out.extend(b"0000000000 65535 f \n")
        for off in offsets[1:]:
            out.extend(f"{off:010d} 00000 n \n".encode("ascii"))

        trailer = (
            f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
            f"startxref\n{xref_pos}\n%%EOF\n"
        )
        out.extend(trailer.encode("ascii"))
        return bytes(out)


def build_manual_pdf(output_path: str | Path | None = None) -> Path:
    """Generate the complete multi-page Simpla Bot PDF manual."""
    dest = Path(output_path) if output_path else Path(__file__).with_name("SIMPLA_BOT_MANUAL.pdf")
    pdf = SimplePDFBuilder("Simpla Bot Manual")
    pdf.add_cover_page()

    # Section 1
    pdf.add_section("1. System Architecture & Bill of Materials")
    pdf.add_paragraph(
        "Simpla Bot is a minimal, zero-ROS weeding robot architecture created for the simpla_bot branch. "
        "It eliminates complex LiDAR/SLAM pipelines and relies on a single Sipeed MaixSense-A075V ToF+RGB "
        "camera for all spatial intelligence: measuring exact forward distance-to-go, detecting left/right "
        "corners and row ends, stopping for obstacles, and computing exact weed-to-tool alignment."
    )
    pdf.add_code_block([
        "  [ Sipeed MaixSense-A075V ] --- USB-RNDIS (192.168.233.1) ---> [ Raspberry Pi / Python 3 ]",
        "                                                                       |           |",
        "                        Option A: Direct Pi GPIO (backend: gpio) ------+           |",
        "                        Option B: Arduino USB Serial (backend: serial) ------------+",
        "                                                                                   v",
        "                  [ Normal Motor Driver (L298N / BTS7960) ]   [ 2-Ch Relay + NC E-Stop ]",
        "                         |                        |               |              |",
        "                    Left Motor               Right Motor      CH1 Grinder    CH2 Flame",
    ])
    pdf.add_table(
        headers=["Qty", "Component", "Specification & Role"],
        rows=[
            ["1", "Sipeed MaixSense-A075V", "16-bit ToF Depth (200-2400mm) + RGB over USB-C"],
            ["1", "Raspberry Pi 3B+/4/5", "Runs pure-Python simpla_bot controller (no ROS needed)"],
            ["1", "Normal Motor Driver", "L298N (bench/light) or dual BTS7960 43A (heavy field)"],
            ["2", "DC Geared Motors", "12V or 24V differential drive (left + right wheels)"],
            ["1", "2-Channel Relay Board", "5V opto-isolated, active-LOW, 10A-30A contacts"],
            ["1", "Grinding Machine", "12V/24V trimmer or contactor wired to Relay CH1 (NO)"],
            ["1", "Flame Control Kit", "12V NC gas solenoid + spark igniter + flashback arrestor"],
            ["1", "Physical E-Stop (NC)", "Latching red mushroom switch cutting 12V + logic pin"],
            ["0-1", "Arduino Uno / Nano", "Optional serial bridge with 800ms hardware watchdog"],
        ],
        col_widths=[36, 155, 325],
    )

    # Section 2
    pdf.add_section("2. Wiring Diagrams & Pinout Tables")
    pdf.add_callout(
        "POWER & GROUNDING RULE",
        "NEVER power drive motors, grinding machine, or gas solenoid from Raspberry Pi 5V pins. "
        "Always wire the physical Normally-Closed E-Stop switch in series with the 12V positive line "
        "feeding the Motor Driver and Relay COM terminals, and connect all GND lines together."
    )
    pdf.add_subheading("Option A: Direct Raspberry Pi GPIO Wiring (config.yaml -> backend: gpio)")
    pdf.add_table(
        headers=["Signal Function", "Pi BCM Pin", "Header Pin", "Connect To"],
        rows=[
            ["Left Motor PWM", "GPIO 12", "Pin 32", "L298N ENA (or BTS7960 EN)"],
            ["Left Dir A / Dir B", "GPIO 5 / 6", "Pin 29 / 31", "L298N IN1 / IN2"],
            ["Right Motor PWM", "GPIO 13", "Pin 33", "L298N ENB"],
            ["Right Dir A / Dir B", "GPIO 20 / 21", "Pin 38 / 40", "L298N IN3 / IN4"],
            ["Grinder Relay (CH1)", "GPIO 17", "Pin 11", "2-Ch Relay IN1 (Active-LOW)"],
            ["Flame Relay (CH2)", "GPIO 27", "Pin 13", "2-Ch Relay IN2 (Active-LOW)"],
            ["Hardware E-Stop (NC)", "GPIO 22", "Pin 15", "NC E-Stop switch -> GND"],
            ["Common Ground", "GND", "Pin 6 / 9", "Motor Driver + Relay + Battery GND"],
        ],
        col_widths=[145, 90, 90, 191],
    )

    pdf.add_subheading("Option B: Arduino Uno/Nano USB Serial Bridge (Recommended for Field)")
    pdf.add_paragraph(
        "Flash simpla_bot/firmware/simpla_motor_relay.ino to an Arduino Uno or Nano, connect to the "
        "Raspberry Pi via USB (/dev/ttyUSB0), and set backend: serial in simpla_bot/config.yaml. "
        "The Arduino enforces an independent 800ms watchdog and 2.5s hard flame shutoff in firmware."
    )
    pdf.add_table(
        headers=["Signal Function", "Arduino Pin", "Connect To"],
        rows=[
            ["Left Motor PWM / IN1 / IN2", "D5 / D7 / D8", "L298N ENA / IN1 / IN2"],
            ["Right Motor PWM / IN3 / IN4", "D6 / D9 / D10", "L298N ENB / IN3 / IN4"],
            ["Grinder Relay (CH1)", "D3", "2-Ch Relay IN1 (Active-LOW)"],
            ["Flame Relay (CH2)", "D4", "2-Ch Relay IN2 (Active-LOW)"],
            ["Hardware E-Stop (NC)", "D2 (INPUT_PULLUP)", "NC E-Stop switch -> GND"],
        ],
        col_widths=[180, 130, 206],
    )
    pdf.add_code_block([
        "12V+ Battery -> [20A FUSE] -> [PHYSICAL E-STOP NC] --+--> Motor Driver +12V",
        "                                                     +--> Relay CH1 COM -> (NO) Grinder +",
        "                                                     +--> Relay CH2 COM -> (NO) Flame Valve +",
        "NOTE: Always use the NO (Normally Open) relay terminals so power loss keeps tools OFF.",
    ])

    # Section 3
    pdf.add_section("3. Sipeed MaixSense-A075V Mounting & USB-RNDIS Setup")
    pdf.add_bullet(
        "Mounting Height & Angle",
        "Mount centered on the front nose at 350mm-500mm height (camera_height_mm), pitched downward "
        "25-35 degrees (camera_pitch_deg) so it views both upcoming walls/corners and weeds on the ground."
    )
    pdf.add_bullet(
        "Tool Offset Measurement",
        "Measure horizontal mm from camera lens to the grinder/flame tip. Set tool_offset_forward_mm "
        "negative if tool is behind the camera (e.g. -120.0) or positive if mounted ahead (+150.0)."
    )
    pdf.add_bullet(
        "USB-RNDIS Connection",
        "Plug MaixSense USB-C into Raspberry Pi. Default camera IP is 192.168.233.1. Simpla Bot sends "
        "the official 12-byte POST /set_cfg packet and polls GET /getdeep for 16-bit depth + RGB JPEG."
    )
    pdf.add_code_block([
        "# Verify MaixSense link and inspect live L/C/R depths & corners:",
        "ping -c 3 192.168.233.1",
        "python3 -m simpla_bot.run_simpla_bot --check-maixsense",
        "",
        "# If Linux did not auto-assign an IP to usb0:",
        "sudo ip addr add 192.168.233.2/24 dev usb0 && sudo ip link set usb0 up",
    ])

    # Section 4
    pdf.add_section("4. Corner Detection, Distance-to-Go & Weed Alignment Logic")
    pdf.add_paragraph(
        "Every ToF depth frame is divided across its mid-horizon band (25%-68% vertical) into Left (5-33%), "
        "Center (34-66%), and Right (67-95%) zones. Median depths filter sensor speckle while the Center "
        "10th percentile catches thin poles or close obstacles."
    )
    pdf.add_bullet(
        "Exact Distance-to-Go",
        "recommended_travel_mm = max(0, center_mm - corner_stop_mm). As the bot nears a corner wall, "
        "its final step automatically slows to approach_speed_pct and rolls only the exact remaining mm."
    )
    pdf.add_bullet(
        "Row Centering",
        "While cruising straight, steer_adjust_pct = clamp((right_mm - left_mm) * 0.04, -18%, +18%) "
        "keeps the rover centered between crop rows or corridor walls without needing encoders or IMU."
    )
    pdf.add_bullet(
        "Weed-to-Tool Projection",
        "Green weeds are segmented in the RGB center lane using Excess-Green (2G - R - B >= 38). "
        "The centroid ToF depth is projected horizontally using camera pitch/height to compute "
        "dx_to_tool_mm = forward_from_cam_mm - tool_offset_forward_mm. The rover rolls exactly that far, "
        "stops completely, and fires the selected tool."
    )
    pdf.add_table(
        headers=["MaixSense Depth Pattern", "Corner Type", "Bot Action"],
        rows=[
            ["min_center <= 320mm (not corner)", "OBSTACLE_STOP", "Immediate full HALT"],
            ["center <= 520mm, Left >= 1050mm, R shut", "LEFT_CORNER", "Stop + Pivot -90 deg LEFT"],
            ["center <= 520mm, Right >= 1050mm, L shut", "RIGHT_CORNER", "Stop + Pivot +90 deg RIGHT"],
            ["center <= 520mm, Both sides open (T)", "Wider Side", "Pivot 90 deg to wider side"],
            ["center <= 520mm, Both sides blocked", "DEAD_END", "Stop + 180 deg U-TURN"],
            ["Center, Left & Right all >= 1850mm", "ROW_END_HEADLAND", "Exited row -> 180 deg U-TURN"],
        ],
        col_widths=[236, 118, 162],
    )

    # Section 5
    pdf.add_section("5. Five-Minute Calibration Guide")
    pdf.add_paragraph(
        "Because normal motor drivers have no wheel encoders, Simpla Bot uses two simple constants in "
        "simpla_bot/config.yaml to turn millimeter & angle commands into accurate timed moves:"
    )
    pdf.add_code_block([
        "# 1. Calibrate straight distance (commands 1000mm at 50% PWM):",
        "python3 -m simpla_bot.run_simpla_bot --calibrate-drive 1000",
        "# Measure actual tape distance (mm). Update config.yaml:",
        "#   new_speed = old_speed * (actual_mm / 1000.0)",
        "",
        "# 2. Calibrate 90-degree pivot turn:",
        "python3 -m simpla_bot.run_simpla_bot --calibrate-turn 90",
        "# Measure actual turn angle (deg). Update config.yaml:",
        "#   new_turn_90_sec = old_turn_90_sec * (90.0 / actual_deg)",
    ])
    pdf.add_paragraph(
        "3. Calibrate tool_offset_forward_mm: place a green card 600mm ahead and run in dry-run mode "
        "(--mode live --tool grinder without --arm-tools). When it stops and prints DRY_RUN_RELAY, "
        "measure how far off the grinder/flame tip is from the card and adjust tool_offset_forward_mm."
    )

    # Section 6
    pdf.add_section("6. Flame Control & Grinder Safety Interlocks")
    pdf.add_table(
        headers=["Safety Layer", "Mechanism", "Default Limit"],
        rows=[
            ["1. Safe Boot", "dry_run=True blocks relays unless --arm-tools passed", "dry_run: true"],
            ["2. Zero-Motion", "Software & Arduino block relays if any wheel PWM != 0", "0.45s settle"],
            ["3. Flame Hard Cap", "Software + Arduino both force flame OFF after cap", "max 2.5s burn"],
            ["4. Flame Cooldown", "Mandatory wait between consecutive flame pulses", "3.0s cooldown"],
            ["5. Watchdogs", "Camera freeze or USB disconnect kills all outputs", "1.0s cam / 0.8s USB"],
            ["6. Physical E-Stop", "NC mushroom switch cuts 12V supply + signals pin", "Instant hardware cut"],
        ],
        col_widths=[115, 285, 116],
    )

    # Section 7
    pdf.add_section("7. Step-by-Step Operation & Bench-to-Field Checklist")
    pdf.add_subheading("Step 1: Offline Bench Simulation (Run on any PC or Pi)")
    pdf.add_code_block([
        "python3 -m simpla_bot.run_simpla_bot --mode sim --tool both",
    ])
    pdf.add_subheading("Step 2: Live Hardware Dry-Run (Wheels Elevated, Gas Valve CLOSED)")
    pdf.add_code_block([
        "python3 -m simpla_bot.run_simpla_bot --mode live --tool both",
        "# Confirm: wheels turn right direction, corner box triggers turn, unplugging",
        "# MaixSense halts motors within 1s, and relays stay OFF (dry_run=True).",
    ])
    pdf.add_subheading("Step 3: Armed Field Operation (Physical E-Stop & Fire Extinguisher Ready)")
    pdf.add_code_block([
        "python3 -m simpla_bot.run_simpla_bot --mode live --tool grinder --arm-tools",
        "python3 -m simpla_bot.run_simpla_bot --mode live --tool flame --arm-tools",
        "python3 -m simpla_bot.run_simpla_bot --mode live --tool both --arm-tools",
    ])
    pdf.add_callout(
        "PRE-FLAME FIELD SAFETY CHECKLIST",
        "[ ] Propane/gas fittings leak-checked with soapy water.  [ ] Flashback arrestor installed.  "
        "[ ] Physical NC E-Stop tested and cuts 12V to solenoid & grinder.  [ ] Class ABC fire "
        "extinguisher within reach.  [ ] Dry brush/straw cleared from boundaries.  [ ] Operator walking alongside."
    )

    # Section 8
    pdf.add_section("8. Troubleshooting & Publishing the simpla_bot Branch")
    pdf.add_table(
        headers=["Issue", "Root Cause", "Solution"],
        rows=[
            ["MaixSense timeout", "usb0 missing 192.168.233.x IP", "Assign 192.168.233.2/24 to usb0; retry"],
            ["Bot drives backward", "Motor wires reversed", "Set invert_left or invert_right: true"],
            ["Relays ON at boot", "Active-HIGH relay board", "Set relay_active_low: false in config & .ino"],
            ["Blocked: E-stop active", "NC switch open or unwired", "Verify GND continuity on E-Stop pin"],
            ["No weeds detected live", "JPEG decoder not installed", "Run: pip install pillow on Raspberry Pi"],
        ],
        col_widths=[125, 165, 226],
    )
    pdf.add_subheading("Creating & Pushing Branch 'simpla_bot' on GitHub")
    pdf.add_code_block([
        "# From your local git clone root:",
        "bash simpla_bot/setup_simpla_bot_branch.sh",
        "git push -u origin simpla_bot",
    ])

    pdf_bytes = pdf.render_bytes()
    dest.write_bytes(pdf_bytes)
    public_dir = dest.resolve().parent.parent / "public"
    if public_dir.is_dir():
        (public_dir / "SIMPLA_BOT_MANUAL.pdf").write_bytes(pdf_bytes)
    return dest


if __name__ == "__main__":
    out_file = build_manual_pdf()
    print(f"Generated {out_file} ({out_file.stat().st_size:,} bytes)")

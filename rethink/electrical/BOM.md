# Electrical Bill of Materials (BOM) — Weeding Turret & Base

Comprehensive electrical component list, specifications, and suggested part numbers.

| Ref | Item Description | Specification / Ratings | Qty | Purpose / Circuit Location |
|---|---|---|---|---|
| **U1** | ESP32 DevKit V1 | 38-Pin ESP-WROOM-32, Dual-core 240MHz, 3.3V Logic | 1 | Master embedded real-time controller |
| **U2** | L298N Dual H-Bridge Driver | Dual H-bridge, 2A/channel peak, 5V onboard regulator | 1 | Group 4: 4WD base motors + 5V logic supply |
| **U3** | Isolated 5V Buck Converter | Input: 7-28V, Output: 5V regulated @ 0.5A - 1A | 1 | Dedicated isolated supply for Arc + Relay coil |
| **U4** | 2-Channel Optocoupler Relay | 5V trigger, Active-LOW, isolated `JD-VCC` header, 10A contacts | 1 | Group 1: Optically isolated high-power switching |
| **U5** | High-Voltage Electric Arc Module | Input: 3.7V - 6V DC, Output: ~10kV pulse arc | 1 | Group 1: Weed burner pilot torch ignition |
| **U6** | LM7805CV Linear Voltage Regulator | 5V Output, 1.5A Max, TO-220 Package + Heatsink | 1 | Group 3: Clean, dedicated servo motor power rail |
| **U7** | 180° Turret Cylinder Servo | 180° rotation, standard footprint (40.5×20×42mm), metal gear | 1 | Group 3: Top cylinder rotation through 120° sector |
| **U8** | MG996R Metal Gear Servo | 180°, 11 kg·cm torque, 40.8×19.9×42mm, metal gear | 1 | Group 3: Rear torch gas needle valve control |
| **U9** | HC-SR04 Ultrasonic Sensor | 5V supply, 2 cm - 400 cm range, 10µs trigger pulse | 1 | Group 2: Front obstacle & collision avoidance |
| **M1-M4** | TT DC Gearmotors (4WD) | 1:48 gear ratio, 3-6V (run at 6-9V via PWM), dual shaft | 4 | Group 4: Rover chassis wheels (2 left, 2 right) |
| **M5** | 12V Mini Grinding Motor | 12V DC, high-speed miniature brush motor, 26mm diameter | 1 | Group 1: Mechanical weed root/stem cutter |
| **BT1** | 3S LiPo Battery | 11.1V nominal, 12.6V charged, 2200-5000mAh, 25C+ | 1 | Main vehicle electrical energy pack |
| **SW1** | Heavy-Duty Toggle Switch | 12V DC, 15A SPST or DPST toggle switch | 1 | Master system power disconnect |
| **F1** | In-Line Blade Fuse Holder + Fuse | 15A standard automotive blade fuse (ATO/ATC) | 1 | Primary battery short-circuit protection |
| **D1** | 1N4007 Rectifier Diode | 1000V, 1A Silicon Diode | 1 | Flyback inductive snubber across Arc input |
| **D2** | 1N4007 Rectifier Diode | 1000V, 1A Silicon Diode | 1 | Flyback snubber across Grinder motor terminals |
| **C1** | Ceramic Disc Capacitor | 0.1 µF (100nF), 50V | 1 | Motor brush RF noise suppression across M5 |
| **C2** | Electrolytic Capacitor | 10 µF, 25V or 50V radial | 1 | LM7805CV regulator input filter |
| **C3** | Electrolytic Capacitor | 100 µF, 16V or 25V radial | 1 | LM7805CV regulator output buffer |
| **C4** | Ceramic Capacitor | 0.1 µF (100nF), 50V | 1 | LM7805CV regulator high-frequency bypass |
| **C5** | Low-ESR Electrolytic Capacitor | 1000 µF, 25V radial | 1 | Bulk reservoir across ESP32 VIN/GND (anti-brownout) |
| **R1** | Metal Film Resistor | 1.0 kΩ, 1/4W, 1% tolerance | 1 | Ultrasonic Echo divider upper leg |
| **R2** | Metal Film Resistor | 2.0 kΩ (or 2.2 kΩ), 1/4W, 1% tolerance | 1 | Ultrasonic Echo divider lower leg to GND |
| **HS1** | Extruded Aluminum Heatsink | TO-220 form factor, thermal resistance < 10°C/W | 1 | Clips/bolts onto LM7805CV tab |

#ifndef CONFIG_H
#define CONFIG_H

// =========================================================================
// WEEDING TURRET & ROVER PINOUT CONFIGURATION (ESP32)
// =========================================================================

// --- Group 4: Base Drive (L298N Motor Driver) ---
#define PIN_L298N_ENA       25    // PWM Left Channel Speed (0 - 255)
#define PIN_L298N_IN1       26    // Left Direction 1
#define PIN_L298N_IN2       27    // Left Direction 2
#define PIN_L298N_ENB       14    // PWM Right Channel Speed (0 - 255)
#define PIN_L298N_IN3       12    // Right Direction 1
#define PIN_L298N_IN4       13    // Right Direction 2

// PWM Configuration for ESP32
#define PWM_FREQ            1000  // 1 kHz PWM frequency for L298N
#define PWM_RES             8     // 8-bit resolution (0-255)
#define PWM_CH_LEFT         0
#define PWM_CH_RIGHT        1

// --- Group 2: Front Ultrasonic Distance Sensor (HC-SR04) ---
#define PIN_US_TRIG         5     // 10us trigger pulse output
#define PIN_US_ECHO         18    // Echo input (via 1k / 2k voltage divider to protect 3.3V GPIO!)

// Ultrasonic Safety Parameters
#define OBSTACLE_STOP_CM    15    // Emergency halt distance
#define OBSTACLE_WARN_CM    30    // Warning distance

// --- Group 3: Servo Actuators ---
#define PIN_SERVO_CYL       19    // 180° Turret Cylinder Rotation Servo (Module 1.5, 16T Pinion)
#define PIN_SERVO_GAS       21    // MG996R Gas Knob Servo (Module 1.25, 24T Gear)

// Servo Angles & Mechanical Calibration
#define CYL_SERVO_CENTER    90    // Straight ahead (0 deg turret)
#define CYL_SERVO_MIN       0     // Hard mechanical limit CW
#define CYL_SERVO_MAX       180   // Hard mechanical limit CCW
#define CYL_GEAR_RATIO      3.25f // 52T equivalent / 16T pinion = 3.25:1

#define GAS_CLOSED_ANGLE    20    // Gas torch needle valve fully seated/closed
#define GAS_IGNITE_ANGLE    75    // Low gas flow for reliable arc ignition
#define GAS_OPEN_ANGLE      110   // Working weed burner flame flow rate

// --- Group 1: Optocoupler Relays (Active LOW) ---
#define PIN_RELAY_ARC       22    // Relay CH1: Electric Arc Ignitor Module (Isolated Buck 5V)
#define PIN_RELAY_GRINDER   23    // Relay CH2: 12V Mini Grinding Motor (Raw 12V Battery Rail)

// Active-LOW relay logic constants
#define RELAY_ACTIVE        LOW
#define RELAY_INACTIVE      HIGH

// Timing Parameters (in milliseconds)
#define ARC_PULSE_MS        400   // Duration of high voltage arc strike
#define VALVE_SETTLE_MS     250   // Gas valve mechanical opening delay
#define TURRET_STEP_DELAY   8     // Milliseconds per degree for smooth servo ramping

#endif // CONFIG_H

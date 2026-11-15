/*
 * Autonomous Weeding Robot - Complete Turret & Base Controller
 * Target Microcontroller: ESP32 DevKit V1 / WROOM-32
 * 
 * Hardware Subsystems:
 * 1. Base 4WD Drive (L298N Dual H-Bridge with PWM speed regulation)
 * 2. Ultrasonic Safety Guard (HC-SR04 with instant e-stop on collision hazard)
 * 3. Rotary Cylinder Turret (180° servo driving 120° sector gear, 3.25:1 ratio)
 * 4. Thermal Weeding Stage (MG996R servo gas meter + 10kV pulse arc ignitor)
 * 5. Mechanical Weeding Stage (12V high-RPM mini grinding cutter motor)
 * 6. Sequential Power Management to prevent voltage drop and brownout
 */

#include <Arduino.h>
#include <ESP32Servo.h>
#include "config.h"

Servo cylServo;
Servo gasServo;

// Internal State
int currentCylAngle = 90;
int currentGasAngle = GAS_CLOSED_ANGLE;
unsigned long lastPingTime = 0;
float currentDistanceCm = 999.0f;
bool emergencyHaltActive = false;

// Function Prototypes
void initGPIO();
void initServos();
void initMotorDriver();
float readUltrasonicCm();
void setBaseDrive(int speedL, int speedR);
void emergencyStop();
void setCylTurretAngle(float turretDeg, bool smooth = true);
void fireFlameBurst(float targetAngleDeg, int burnTimeMs);
void runGrinderCut(float targetAngleDeg, int cutTimeMs);
void processSerialCommand(char cmd);

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println(F("\n======================================================="));
  Serial.println(F("   AUTONOMOUS WEEDING TURRET CONTROLLER INITIALIZING   "));
  Serial.println(F("======================================================="));

  initGPIO();
  initServos();
  initMotorDriver();

  Serial.println(F("[STATUS] Hardware initialized. System ready for commands."));
  Serial.println(F("[HELP] Available Serial Commands:"));
  Serial.println(F("  'F' -> Fire flame burst (+15 deg, 1500 ms)"));
  Serial.println(F("  'G' -> Run grinder cut (-15 deg, 2000 ms)"));
  Serial.println(F("  'C' -> Center turret (0 deg)"));
  Serial.println(F("  'w' -> Drive Forward (speed 180)"));
  Serial.println(F("  's' -> Drive Reverse (speed 180)"));
  Serial.println(F("  'a' -> Spin Left (speed 150)"));
  Serial.println(F("  'd' -> Spin Right (speed 150)"));
  Serial.println(F("  'x' -> Stop Motors"));
  Serial.println(F("  'p' -> Read Ultrasonic Distance"));
}

void loop() {
  // 1. Non-blocking Ultrasonic Ranging (every 60ms)
  unsigned long now = millis();
  if (now - lastPingTime >= 60) {
    lastPingTime = now;
    currentDistanceCm = readUltrasonicCm();

    // Emergency collision avoidance check
    if (currentDistanceCm > 0.0f && currentDistanceCm < OBSTACLE_STOP_CM) {
      if (!emergencyHaltActive) {
        emergencyHaltActive = true;
        emergencyStop();
        Serial.print(F("[ALERT] COLLISION HAZARD! Distance: "));
        Serial.print(currentDistanceCm);
        Serial.println(F(" cm. E-STOP TRIGGERED!"));
      }
    } else {
      emergencyHaltActive = false;
    }
  }

  // 2. Command Processing via UART
  if (Serial.available()) {
    char cmd = Serial.read();
    processSerialCommand(cmd);
  }
}

// -------------------------------------------------------------------------
// HARDWARE INITIALIZATION
// -------------------------------------------------------------------------
void initGPIO() {
  // Optocoupler Relays (Active-LOW: Set HIGH before output to prevent turn-on glitch)
  digitalWrite(PIN_RELAY_ARC, RELAY_INACTIVE);
  digitalWrite(PIN_RELAY_GRINDER, RELAY_INACTIVE);
  pinMode(PIN_RELAY_ARC, OUTPUT);
  pinMode(PIN_RELAY_GRINDER, OUTPUT);

  // Ultrasonic Sensor
  pinMode(PIN_US_TRIG, OUTPUT);
  pinMode(PIN_US_ECHO, INPUT);
  digitalWrite(PIN_US_TRIG, LOW);
}

void initServos() {
  // Allocate ESP32 timers
  ESP32PWM::allocateTimer(0);
  ESP32PWM::allocateTimer(1);
  ESP32PWM::allocateTimer(2);
  ESP32PWM::allocateTimer(3);

  cylServo.setPeriodHertz(50);
  gasServo.setPeriodHertz(50);

  cylServo.attach(PIN_SERVO_CYL, 500, 2400);
  gasServo.attach(PIN_SERVO_GAS, 500, 2400);

  // Default safe resting positions
  gasServo.write(GAS_CLOSED_ANGLE);
  currentGasAngle = GAS_CLOSED_ANGLE;

  cylServo.write(CYL_SERVO_CENTER);
  currentCylAngle = CYL_SERVO_CENTER;
}

void initMotorDriver() {
  pinMode(PIN_L298N_IN1, OUTPUT);
  pinMode(PIN_L298N_IN2, OUTPUT);
  pinMode(PIN_L298N_IN3, OUTPUT);
  pinMode(PIN_L298N_IN4, OUTPUT);

  // ESP32 LEDC PWM attachment for motor speed control
  ledcAttach(PIN_L298N_ENA, PWM_FREQ, PWM_RES);
  ledcAttach(PIN_L298N_ENB, PWM_FREQ, PWM_RES);

  setBaseDrive(0, 0);
}

// -------------------------------------------------------------------------
// SENSOR ROUTINES
// -------------------------------------------------------------------------
float readUltrasonicCm() {
  digitalWrite(PIN_US_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_US_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_US_TRIG, LOW);

  unsigned long durationUs = pulseIn(PIN_US_ECHO, HIGH, 25000); // 25ms timeout (~4.3m max)
  if (durationUs == 0) return -1.0f; // Timeout / out of range
  return (durationUs * 0.0343f) / 2.0f;
}

// -------------------------------------------------------------------------
// ACTUATION & SMOOTH SERVO CONTROL
// -------------------------------------------------------------------------
void setCylTurretAngle(float turretDeg, bool smooth) {
  // turretDeg is relative to center (-27 to +27 deg field of aim)
  // Gear ratio is 3.25:1 (52T sector gear / 16T servo pinion)
  int targetServoAngle = constrain(CYL_SERVO_CENTER + (int)(turretDeg * CYL_GEAR_RATIO), CYL_SERVO_MIN, CYL_SERVO_MAX);

  if (!smooth) {
    cylServo.write(targetServoAngle);
    currentCylAngle = targetServoAngle;
    delay(200);
    return;
  }

  // Smooth ramping to protect 3D printed gear teeth & reduce peak inrush
  int step = (targetServoAngle >= currentCylAngle) ? 1 : -1;
  while (currentCylAngle != targetServoAngle) {
    currentCylAngle += step;
    cylServo.write(currentCylAngle);
    delay(TURRET_STEP_DELAY);
  }
}

void setGasValveAngle(int targetAngle, bool smooth) {
  targetAngle = constrain(targetAngle, GAS_CLOSED_ANGLE, GAS_OPEN_ANGLE);
  if (!smooth) {
    gasServo.write(targetAngle);
    currentGasAngle = targetAngle;
    delay(150);
    return;
  }

  int step = (targetAngle >= currentGasAngle) ? 1 : -1;
  while (currentGasAngle != targetAngle) {
    currentGasAngle += step;
    gasServo.write(currentGasAngle);
    delay(6);
  }
}

// -------------------------------------------------------------------------
// WEEDING SEQUENCES (STRICTLY SEQUENTIAL POWER PROFILE)
// -------------------------------------------------------------------------
void fireFlameBurst(float targetAngleDeg, int burnTimeMs) {
  if (emergencyHaltActive) {
    Serial.println(F("[SAFETY] Flame firing BLOCKED: Obstacle in danger zone!"));
    return;
  }

  Serial.print(F("[THERMAL] Starting Flame Sequence at angle "));
  Serial.print(targetAngleDeg);
  Serial.println(F(" deg..."));

  // Ensure grinder relay is de-energized
  digitalWrite(PIN_RELAY_GRINDER, RELAY_INACTIVE);

  // 1. Aim rotating cylinder turret to weed coordinate
  setCylTurretAngle(targetAngleDeg, true);
  delay(150); // Settle oscillation

  // 2. Open gas needle valve to ignition setting
  setGasValveAngle(GAS_IGNITE_ANGLE, true);
  delay(VALVE_SETTLE_MS);

  // 3. Pulse isolated high-voltage arc ignitor (400 ms)
  Serial.println(F("[THERMAL] Striking 10kV electric arc..."));
  digitalWrite(PIN_RELAY_ARC, RELAY_ACTIVE);
  delay(ARC_PULSE_MS);
  digitalWrite(PIN_RELAY_ARC, RELAY_INACTIVE);

  // 4. Increase gas flow to working weed torch flame
  setGasValveAngle(GAS_OPEN_ANGLE, true);

  // 5. Burn target weed for prescribed thermal dose
  Serial.print(F("[THERMAL] Burning weed for "));
  Serial.print(burnTimeMs);
  Serial.println(F(" ms..."));
  delay(burnTimeMs);

  // 6. Extinguish flame: seat gas valve closed
  Serial.println(F("[THERMAL] Closing gas valve."));
  setGasValveAngle(GAS_CLOSED_ANGLE, true);
  delay(VALVE_SETTLE_MS);

  Serial.println(F("[THERMAL] Flame Weeding Sequence Complete."));
}

void runGrinderCut(float targetAngleDeg, int cutTimeMs) {
  if (emergencyHaltActive) {
    Serial.println(F("[SAFETY] Grinder operation BLOCKED: Obstacle in danger zone!"));
    return;
  }

  Serial.print(F("[MECHANICAL] Starting Grinder Sequence at angle "));
  Serial.print(targetAngleDeg);
  Serial.println(F(" deg..."));

  // Guarantee gas valve is sealed and arc is off
  setGasValveAngle(GAS_CLOSED_ANGLE, false);
  digitalWrite(PIN_RELAY_ARC, RELAY_INACTIVE);

  // 1. Aim rotating cylinder turret to weed coordinate
  setCylTurretAngle(targetAngleDeg, true);
  delay(150);

  // 2. Spin up 12V mini grinding motor via Relay CH2
  Serial.println(F("[MECHANICAL] Grinder Motor ON..."));
  digitalWrite(PIN_RELAY_GRINDER, RELAY_ACTIVE);

  // 3. Perform cutting duration
  delay(cutTimeMs);

  // 4. Spin down grinder motor
  digitalWrite(PIN_RELAY_GRINDER, RELAY_INACTIVE);
  Serial.println(F("[MECHANICAL] Grinder Motor OFF. Grinder Sequence Complete."));
}

// -------------------------------------------------------------------------
// BASE 4WD DRIVE ROUTINES
// -------------------------------------------------------------------------
void setBaseDrive(int speedL, int speedR) {
  if (emergencyHaltActive && (speedL > 0 || speedR > 0)) {
    // Forbid forward motion when obstacle detected
    speedL = 0;
    speedR = 0;
  }

  // Left side direction & PWM
  if (speedL > 0) {
    digitalWrite(PIN_L298N_IN1, HIGH);
    digitalWrite(PIN_L298N_IN2, LOW);
    ledcWrite(PIN_L298N_ENA, constrain(speedL, 0, 255));
  } else if (speedL < 0) {
    digitalWrite(PIN_L298N_IN1, LOW);
    digitalWrite(PIN_L298N_IN2, HIGH);
    ledcWrite(PIN_L298N_ENA, constrain(-speedL, 0, 255));
  } else {
    digitalWrite(PIN_L298N_IN1, LOW);
    digitalWrite(PIN_L298N_IN2, LOW);
    ledcWrite(PIN_L298N_ENA, 0);
  }

  // Right side direction & PWM
  if (speedR > 0) {
    digitalWrite(PIN_L298N_IN3, HIGH);
    digitalWrite(PIN_L298N_IN4, LOW);
    ledcWrite(PIN_L298N_ENB, constrain(speedR, 0, 255));
  } else if (speedR < 0) {
    digitalWrite(PIN_L298N_IN3, LOW);
    digitalWrite(PIN_L298N_IN4, HIGH);
    ledcWrite(PIN_L298N_ENB, constrain(-speedR, 0, 255));
  } else {
    digitalWrite(PIN_L298N_IN3, LOW);
    digitalWrite(PIN_L298N_IN4, LOW);
    ledcWrite(PIN_L298N_ENB, 0);
  }
}

void emergencyStop() {
  // Immediately kill base motion
  setBaseDrive(0, 0);
  // De-energize high-power switched loads
  digitalWrite(PIN_RELAY_ARC, RELAY_INACTIVE);
  digitalWrite(PIN_RELAY_GRINDER, RELAY_INACTIVE);
  // Close gas flow
  gasServo.write(GAS_CLOSED_ANGLE);
  currentGasAngle = GAS_CLOSED_ANGLE;
}

// -------------------------------------------------------------------------
// SERIAL TELEMETRY & COMMAND HANDLER
// -------------------------------------------------------------------------
void processSerialCommand(char cmd) {
  switch (cmd) {
    case 'F':
      fireFlameBurst(15.0f, 1500);
      break;
    case 'G':
      runGrinderCut(-15.0f, 2000);
      break;
    case 'C':
      Serial.println(F("[COMMAND] Centering Turret"));
      setCylTurretAngle(0.0f, true);
      break;
    case 'w':
      Serial.println(F("[DRIVE] Forward"));
      setBaseDrive(180, 180);
      break;
    case 's':
      Serial.println(F("[DRIVE] Reverse"));
      setBaseDrive(-180, -180);
      break;
    case 'a':
      Serial.println(F("[DRIVE] Spin Left"));
      setBaseDrive(-150, 150);
      break;
    case 'd':
      Serial.println(F("[DRIVE] Spin Right"));
      setBaseDrive(150, -150);
      break;
    case 'x':
      Serial.println(F("[DRIVE] Stop"));
      setBaseDrive(0, 0);
      break;
    case 'p':
      Serial.print(F("[PING] Distance: "));
      Serial.print(readUltrasonicCm());
      Serial.println(F(" cm"));
      break;
    default:
      break;
  }
}

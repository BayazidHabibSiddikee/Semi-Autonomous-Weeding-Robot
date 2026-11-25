/*
 * ESP32 Complete Weeding Rover Controller
 * 
 * Features:
 *  1. 8-Direction Rover Movement (0, 45, 90, 135, 180, 225, 270, 315 deg)
 *     driven via dual L298N DC motor H-bridge channels.
 *  2. Cylinder Turret Yaw Servo (MG996R, 120° sector gear, -35° to +35° range).
 *  3. Relay 1: Mechanical Grinder Motor / Relay 2: Flame Valve Solenoid.
 * 
 * Serial Command Protocol (115200 baud on Serial or Serial2):
 *  - "DIR <angle>"       e.g., DIR 0, DIR 45, DIR 90, DIR 180, DIR 270, DIR 315
 *  - "STOP"              Instant motor brake
 *  - "TURRET <deg>"      e.g., TURRET -25, TURRET 0, TURRET 30 (range: -35 to +35 deg)
 *  - "CUT <GRINDER|FLAME|ALL> <duration_ms>" e.g., CUT GRINDER 1500
 *  - "RELAY1 <ON|OFF>"   Direct manual relay 1 control
 *  - "RELAY2 <ON|OFF>"   Direct manual relay 2 control
 *  - "STATUS?"           Returns JSON status of all motors and relays
 */

#include <ESP32Servo.h>
#include <WiFi.h>
#include <WebServer.h>

// Raspberry Pi Hotspot Credentials (fixed)
const char* WIFI_SSID = "bayazid";
const char* WIFI_PASS = "12345678";
WebServer wifiServer(8081);
unsigned long lastWifiRetry = 0;

// =========================================================================
// PIN DEFINITIONS
// =========================================================================
// L298N Motor Pins (Left & Right differential drive)
const int PIN_IN1 = 26; // Left Motor Fwd
const int PIN_IN2 = 27; // Left Motor Bwd
const int PIN_IN3 = 14; // Right Motor Fwd
const int PIN_IN4 = 12; // Right Motor Bwd
const int PIN_ENA = 25; // Left Motor PWM speed
const int PIN_ENB = 33; // Right Motor PWM speed

// Actuation & Turret Pins
const int PIN_TURRET_SERVO = 15; // MG996R Yaw Servo PWM
const int PIN_RELAY_GRINDER = 4;  // Relay 1: Grinder Motor
const int PIN_RELAY_FLAME   = 2;  // Relay 2: Flame Valve Solenoid

// Serial Communication Pins with Pi
#define RXD2 16
#define TXD2 17

// Relays active LOW definition (adjust if your module is active HIGH)
const int RELAY_ACTIVE   = LOW;
const int RELAY_INACTIVE = HIGH;

// PWM Properties
const int PWM_FREQ = 2000;
const int PWM_RES  = 8; // 0-255
const int CH_LEFT  = 0;
const int CH_RIGHT = 1;

Servo turretServo;
int currentHeading = 0;
int currentTurretDeg = 0;

void setMotorRaw(int leftPwm, int rightPwm) {
  // Left Motor Direction
  if (leftPwm > 0) {
    digitalWrite(PIN_IN1, HIGH);
    digitalWrite(PIN_IN2, LOW);
    ledcWrite(CH_LEFT, constrain(leftPwm, 0, 255));
  } else if (leftPwm < 0) {
    digitalWrite(PIN_IN1, LOW);
    digitalWrite(PIN_IN2, HIGH);
    ledcWrite(CH_LEFT, constrain(-leftPwm, 0, 255));
  } else {
    digitalWrite(PIN_IN1, LOW);
    digitalWrite(PIN_IN2, LOW);
    ledcWrite(CH_LEFT, 0);
  }

  // Right Motor Direction
  if (rightPwm > 0) {
    digitalWrite(PIN_IN3, HIGH);
    digitalWrite(PIN_IN4, LOW);
    ledcWrite(CH_RIGHT, constrain(rightPwm, 0, 255));
  } else if (rightPwm < 0) {
    digitalWrite(PIN_IN3, LOW);
    digitalWrite(PIN_IN4, HIGH);
    ledcWrite(CH_RIGHT, constrain(-rightPwm, 0, 255));
  } else {
    digitalWrite(PIN_IN3, LOW);
    digitalWrite(PIN_IN4, LOW);
    ledcWrite(CH_RIGHT, 0);
  }
}

void apply8WayDirection(int headingDeg, int baseSpeed = 200) {
  currentHeading = headingDeg;
  int lPwm = 0;
  int rPwm = 0;

  switch (headingDeg) {
    case 0:    // Straight Forward
      lPwm = baseSpeed;
      rPwm = baseSpeed;
      break;
    case 45:   // Veer Forward-Right
      lPwm = baseSpeed;
      rPwm = baseSpeed * 0.40;
      break;
    case 90:   // Pivot Right in place (Odd row corner turn)
      lPwm = baseSpeed * 0.85;
      rPwm = -baseSpeed * 0.85;
      break;
    case 135:  // Reverse-Right
      lPwm = -baseSpeed * 0.80;
      rPwm = -baseSpeed * 0.35;
      break;
    case 180:  // Straight Reverse
      lPwm = -baseSpeed * 0.80;
      rPwm = -baseSpeed * 0.80;
      break;
    case 225:  // Reverse-Left
      lPwm = -baseSpeed * 0.35;
      rPwm = -baseSpeed * 0.80;
      break;
    case 270:  // Pivot Left in place (Even row corner turn)
      lPwm = -baseSpeed * 0.85;
      rPwm = baseSpeed * 0.85;
      break;
    case 315:  // Veer Forward-Left
      lPwm = baseSpeed * 0.40;
      rPwm = baseSpeed;
      break;
    default:   // Stop on unknown heading
      lPwm = 0;
      rPwm = 0;
      break;
  }
  setMotorRaw(lPwm, rPwm);
}

void setTurretAngle(int deg) {
  // Servo range: -35 to +35 deg mapped to 55° - 125° physical servo range (90° is center)
  deg = constrain(deg, -35, 35);
  currentTurretDeg = deg;
  int servoPwmDeg = 90 + deg;
  turretServo.write(servoPwmDeg);
}

void executeCut(String tool, int durationMs) {
  // Stop rover movement during cutting
  setMotorRaw(0, 0);

  if (tool == "GRINDER" || tool == "ALL") {
    digitalWrite(PIN_RELAY_GRINDER, RELAY_ACTIVE);
  }
  if (tool == "FLAME" || tool == "ALL") {
    digitalWrite(PIN_RELAY_FLAME, RELAY_ACTIVE);
  }

  delay(durationMs);

  digitalWrite(PIN_RELAY_GRINDER, RELAY_INACTIVE);
  digitalWrite(PIN_RELAY_FLAME, RELAY_INACTIVE);
}

void parseCommand(String cmd) {
  cmd.trim();
  if (cmd.length() == 0) return;

  if (cmd.startsWith("DIR")) {
    int angle = cmd.substring(4).toInt();
    apply8WayDirection(angle);
    Serial.printf("ACK: DIR %d\n", angle);
  } else if (cmd == "STOP") {
    setMotorRaw(0, 0);
    Serial.println("ACK: STOPPED");
  } else if (cmd.startsWith("TURRET")) {
    int deg = cmd.substring(7).toInt();
    setTurretAngle(deg);
    Serial.printf("ACK: TURRET %d\n", deg);
  } else if (cmd.startsWith("CUT")) {
    // Format: CUT <TOOL> <DURATION_MS>
    int firstSpace = cmd.indexOf(' ', 4);
    String tool = "GRINDER";
    int duration = 1500;
    if (firstSpace > 0) {
      tool = cmd.substring(4, firstSpace);
      duration = cmd.substring(firstSpace + 1).toInt();
    } else {
      tool = cmd.substring(4);
    }
    executeCut(tool, duration > 0 ? duration : 1500);
    Serial.println("ACK: CUT COMPLETE");
  } else if (cmd == "STATUS?") {
    Serial.printf("{\"heading\":%d,\"turret_deg\":%d,\"grinder\":%d,\"flame\":%d}\n",
                  currentHeading, currentTurretDeg,
                  digitalRead(PIN_RELAY_GRINDER) == RELAY_ACTIVE,
                  digitalRead(PIN_RELAY_FLAME) == RELAY_ACTIVE);
  }
}

void setup() {
  Serial.begin(115200);
  Serial2.begin(115200, SERIAL_8N1, RXD2, TXD2);

  // Motor pins
  pinMode(PIN_IN1, OUTPUT);
  pinMode(PIN_IN2, OUTPUT);
  pinMode(PIN_IN3, OUTPUT);
  pinMode(PIN_IN4, OUTPUT);

  // Configure PWM channels for motor speeds
  ledcAttachChannel(PIN_ENA, PWM_FREQ, PWM_RES, CH_LEFT);
  ledcAttachChannel(PIN_ENB, PWM_FREQ, PWM_RES, CH_RIGHT);

  // Relay pins
  pinMode(PIN_RELAY_GRINDER, OUTPUT);
  pinMode(PIN_RELAY_FLAME, OUTPUT);
  digitalWrite(PIN_RELAY_GRINDER, RELAY_INACTIVE);
  digitalWrite(PIN_RELAY_FLAME, RELAY_INACTIVE);

  // Turret Servo
  turretServo.attach(PIN_TURRET_SERVO);
  setTurretAngle(0);

  setMotorRaw(0, 0);

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  wifiServer.on("/cmd", []() {
    String q = wifiServer.hasArg("q") ? wifiServer.arg("q") : "";
    parseCommand(q);
    wifiServer.send(200, "text/plain", "OK");
  });
  wifiServer.on("/status", []() {
    String json = String("{\"heading\":") + currentHeading + ",\"turret_deg\":" + currentTurretDeg
                + ",\"grinder\":" + (digitalRead(PIN_RELAY_GRINDER) == RELAY_ACTIVE)
                + ",\"flame\":" + (digitalRead(PIN_RELAY_FLAME) == RELAY_ACTIVE)
                + ",\"wifi\":" + (WiFi.status() == WL_CONNECTED ? 1 : 0) + "}";
    wifiServer.send(200, "application/json", json);
  });
  wifiServer.begin();

  Serial.println("ESP32 8-Way Weeding Controller Ready (Wi-Fi: bayazid).");
}

void loop() {
  wifiServer.handleClient();
  if (WiFi.status() != WL_CONNECTED && millis() - lastWifiRetry > 5000) {
    lastWifiRetry = millis();
    WiFi.begin(WIFI_SSID, WIFI_PASS);
  }
  // Read from USB Serial or Hardware UART2 (from Pi)
  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    parseCommand(cmd);
  }
  if (Serial2.available()) {
    String cmd = Serial2.readStringUntil('\n');
    parseCommand(cmd);
  }
}

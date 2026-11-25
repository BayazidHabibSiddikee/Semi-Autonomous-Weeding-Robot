/*
 * Simpla Bot ESP32 Complete Controller (USB Serial + Wi-Fi "bayazid" / "12345678")
 *
 * Hardware:
 *   1. L298N Dual H-Bridge (4 motors paired: Left=ENA/IN1/IN2, Right=ENB/IN3/IN4)
 *   2. MG996R Servo on GPIO 15 driven by exact 50 Hz LEDC frequency PWM (-30° to +30°)
 *   3. High-Voltage Arc Module on GPIO 18 (safety-interlocked, non-blocking 2000 ms cap)
 *   4. Hardware E-Stop Switch on GPIO 4 (NC to GND with INPUT_PULLUP)
 *
 * Serial / HTTP Commands (115200 baud or http://<esp32-ip>:8081/cmd?q=...):
 *   - DIR <0|45|90|135|180|225|270|315> [speed]
 *   - M <left -35..35> <right -35..35>
 *   - SERVO <deg -30..30>  (alias: TURRET <deg>)  -> 50 Hz PWM frequency control
 *   - ARC <ms> | ARC ON | ARC OFF                 -> Arc module (blocked if moving/E-stop)
 *   - STOP                                        -> Motors OFF + Arc OFF
 *   - PING / STATUS?
 */
#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>

// Fixed Raspberry Pi hotspot credentials
const char* WIFI_SSID = "bayazid";
const char* WIFI_PASS = "12345678";

// L298N Motor Pins
const int ENA = 27, IN1 = 25, IN2 = 26;
const int ENB = 14, IN3 = 32, IN4 = 33;
const int ESTOP = 4; // NC switch to GND with INPUT_PULLUP

// MG996R Servo (50 Hz frequency PWM via ESP32 LEDC) & Arc Module
const int PIN_SERVO = 15;
const int SERVO_FREQ_HZ = 50;       // Standard 50 Hz (20,000 us period)
const int SERVO_RES_BITS = 16;      // 0..65535 duty resolution
const int SERVO_MIN_DEG = -30;
const int SERVO_MAX_DEG = 30;

const int PIN_ARC_MODULE = 18;
const int ARC_ACTIVE = HIGH;
const int ARC_INACTIVE = LOW;
const unsigned long MAX_ARC_MS = 2000;

const unsigned long WATCHDOG_MS = 500;
const unsigned long WIFI_RETRY_MS = 5000;

WebServer server(8081);
String rx;
unsigned long lastCommand = 0;
unsigned long lastWifiCheck = 0;
bool wifiStarted = false;

int leftNow = 0, rightNow = 0;
int headingNow = 0;
int servoDegNow = 0;
bool arcActive = false;
unsigned long arcOffAtMs = 0;

void setArc(bool on, unsigned long durationMs = MAX_ARC_MS) {
  if (!on) {
    arcActive = false;
    arcOffAtMs = 0;
    digitalWrite(PIN_ARC_MODULE, ARC_INACTIVE);
    return;
  }
  // Safety interlocks: never energize Arc while moving or E-stop open
  if (digitalRead(ESTOP) == HIGH || leftNow != 0 || rightNow != 0) {
    arcActive = false;
    digitalWrite(PIN_ARC_MODULE, ARC_INACTIVE);
    return;
  }
  unsigned long clampedMs = constrain(durationMs, 50UL, MAX_ARC_MS);
  arcActive = true;
  arcOffAtMs = millis() + clampedMs;
  digitalWrite(PIN_ARC_MODULE, ARC_ACTIVE);
}

void setServoFrequencyAngle(int deg) {
  deg = constrain(deg, SERVO_MIN_DEG, SERVO_MAX_DEG);
  servoDegNow = deg;
  // Map -30..+30 deg -> physical 60..120 deg -> 1167..1833 us pulse at 50 Hz (20000 us period)
  float physicalDeg = 90.0f + (float)deg;
  float pulseUs = 500.0f + (physicalDeg / 180.0f) * 2000.0f;
  uint32_t duty = (uint32_t)((pulseUs / 20000.0f) * 65535.0f);
  ledcWrite(PIN_SERVO, duty);
}

void channel(int en, int a, int b, int value) {
  value = constrain(value, -35, 35);
  digitalWrite(a, value > 0);
  digitalWrite(b, value < 0);
  analogWrite(en, map(abs(value), 0, 35, 0, 255));
}

void stopMotors() {
  leftNow = rightNow = 0;
  analogWrite(ENA, 0);
  analogWrite(ENB, 0);
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, LOW);
  digitalWrite(IN3, LOW);
  digitalWrite(IN4, LOW);
}

void applyDrive(int l, int r) {
  l = constrain(l, -35, 35);
  r = constrain(r, -35, 35);
  if (l != 0 || r != 0) setArc(false); // Stationary interlock
  leftNow = l;
  rightNow = r;
  channel(ENA, IN1, IN2, l);
  channel(ENB, IN3, IN4, r);
}

void apply8WayDirection(int headingDeg, int baseSpeed = 28) {
  baseSpeed = constrain(baseSpeed, 10, 35);
  headingNow = ((headingDeg % 360) + 360) % 360;
  int l = 0, r = 0;
  switch (headingNow) {
    case 0:   l = baseSpeed;               r = baseSpeed;               break;
    case 45:  l = baseSpeed;               r = (int)(baseSpeed * 0.40); break;
    case 90:  l = (int)(baseSpeed * 0.85); r = -(int)(baseSpeed * 0.85);break;
    case 135: l = -(int)(baseSpeed * 0.80);r = -(int)(baseSpeed * 0.35);break;
    case 180: l = -baseSpeed;              r = -baseSpeed;              break;
    case 225: l = -(int)(baseSpeed * 0.35);r = -(int)(baseSpeed * 0.80);break;
    case 270: l = -(int)(baseSpeed * 0.85);r = (int)(baseSpeed * 0.85); break;
    case 315: l = (int)(baseSpeed * 0.40); r = baseSpeed;               break;
    default:  l = 0;                       r = 0;                       break;
  }
  applyDrive(l, r);
}

String command(String line) {
  line.trim();
  if (!line.length()) return "";
  if (line == "STOP") {
    lastCommand = millis();
    stopMotors();
    setArc(false);
    return "OK STOP";
  }
  if (line == "PING") {
    return String(digitalRead(ESTOP) == HIGH ? "PONG ESTOP=1" : "PONG ESTOP=0")
         + " WIFI=" + (WiFi.status() == WL_CONNECTED ? "1" : "0")
         + " SERVO=" + servoDegNow
         + " ARC=" + (arcActive ? "1" : "0");
  }
  if (line == "STATUS?") {
    return String("{\"heading\":") + headingNow + ",\"left\":" + leftNow + ",\"right\":" + rightNow
         + ",\"servo_deg\":" + servoDegNow + ",\"arc\":" + (arcActive ? 1 : 0)
         + ",\"estop\":" + (digitalRead(ESTOP) == HIGH ? 1 : 0)
         + ",\"wifi\":" + (WiFi.status() == WL_CONNECTED ? 1 : 0) + "}";
  }
  if (line.startsWith("SERVO ") || line.startsWith("TURRET ")) {
    int sp = line.indexOf(' ');
    int deg = line.substring(sp + 1).toInt();
    setServoFrequencyAngle(deg);
    return String("OK SERVO ") + servoDegNow;
  }
  if (line.startsWith("ARC")) {
    String arg = line.length() > 3 ? line.substring(3) : "";
    arg.trim();
    arg.toUpperCase();
    if (arg == "OFF" || arg == "0") {
      setArc(false);
      return "OK ARC OFF";
    }
    if (digitalRead(ESTOP) == HIGH) { setArc(false); return "ERR ESTOP"; }
    if (leftNow != 0 || rightNow != 0) { setArc(false); return "ERR MOVING"; }
    unsigned long ms = (arg == "ON" || arg.length() == 0) ? 800UL : (unsigned long)arg.toInt();
    setArc(true, ms > 0 ? ms : 800UL);
    return String("OK ARC ") + (arcOffAtMs - millis());
  }
  if (line.startsWith("DIR ")) {
    if (digitalRead(ESTOP) == HIGH) { stopMotors(); setArc(false); return "ERR ESTOP"; }
    String rest = line.substring(4);
    rest.trim();
    int sp = rest.indexOf(' ');
    int angle = (sp < 0) ? rest.toInt() : rest.substring(0, sp).toInt();
    int spd = (sp < 0) ? 28 : rest.substring(sp + 1).toInt();
    lastCommand = millis();
    apply8WayDirection(angle, spd > 0 ? spd : 28);
    return String("OK DIR ") + headingNow;
  }
  if (line.startsWith("M ")) {
    int split = line.indexOf(' ', 2);
    if (split < 0) return "ERR FORMAT";
    int l = constrain(line.substring(2, split).toInt(), -35, 35);
    int r = constrain(line.substring(split + 1).toInt(), -35, 35);
    if (digitalRead(ESTOP) == HIGH) { stopMotors(); setArc(false); return "ERR ESTOP"; }
    lastCommand = millis();
    applyDrive(l, r);
    return "OK";
  }
  return "ERR UNKNOWN";
}

void setupWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  server.on("/ping", []() { server.send(200, "text/plain", command("PING")); });
  server.on("/status", []() { server.send(200, "application/json", command("STATUS?")); });
  server.on("/cmd", []() {
    String q = server.hasArg("q") ? server.arg("q") : "";
    String res = command(q);
    server.send(res.startsWith("ERR") ? 400 : 200, "text/plain", res);
  });
  server.begin();
  wifiStarted = true;
}

void setup() {
  pinMode(ENA, OUTPUT); pinMode(IN1, OUTPUT); pinMode(IN2, OUTPUT);
  pinMode(ENB, OUTPUT); pinMode(IN3, OUTPUT); pinMode(IN4, OUTPUT);
  pinMode(PIN_ARC_MODULE, OUTPUT);
  digitalWrite(PIN_ARC_MODULE, ARC_INACTIVE);
  pinMode(ESTOP, INPUT_PULLUP);
  stopMotors();

  // 50 Hz frequency PWM for MG996R servo (-30..+30 deg)
  ledcAttach(PIN_SERVO, SERVO_FREQ_HZ, SERVO_RES_BITS);
  setServoFrequencyAngle(0);

  Serial.begin(115200);
  lastCommand = millis();
  setupWifi();
  Serial.println("SIMPLA_ESP32_READY");
}

void loop() {
  if (digitalRead(ESTOP) == HIGH) {
    stopMotors();
    setArc(false);
  }
  if ((leftNow || rightNow) && millis() - lastCommand > WATCHDOG_MS) {
    stopMotors();
  }
  if (arcActive && (long)(millis() - arcOffAtMs) >= 0) {
    setArc(false);
  }
  if (wifiStarted) {
    server.handleClient();
    if (WiFi.status() != WL_CONNECTED && millis() - lastWifiRetry > WIFI_RETRY_MS) {
      lastWifiRetry = millis();
      WiFi.begin(WIFI_SSID, WIFI_PASS);
    }
  }
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      String out = command(rx);
      if (out.length()) Serial.println(out);
      rx = "";
    } else if (rx.length() < 64) {
      rx += c;
    }
  }
}

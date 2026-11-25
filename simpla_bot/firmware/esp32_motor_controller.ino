/*
 * Simpla Bot ESP32 Motor Controller (USB Serial + Wi-Fi "bayazid" / "12345678")
 *
 * Supports:
 *   - 8-Direction drive: DIR <0|45|90|135|180|225|270|315> [speed]
 *   - Differential drive: M <left -35..35> <right -35..35>
 *   - Instant stop:       STOP
 *   - Health check:       PING  -> PONG ESTOP=<0|1> WIFI=<0|1>
 *   - JSON status:        STATUS?
 *
 * Transports:
 *   1. USB Serial (115200 baud) from Raspberry Pi
 *   2. Wi-Fi Station on Pi hotspot ("bayazid" / "12345678"), HTTP port 8081:
 *      GET /cmd?q=DIR+45  |  GET /cmd?q=M+28+28  |  GET /cmd?q=STOP  |  GET /ping
 *
 * Four motors remain paired: left pair = channel A, right pair = channel B.
 */
#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>

// Always connect to the Raspberry Pi hotspot credentials
const char* WIFI_SSID = "bayazid";
const char* WIFI_PASS = "12345678";

const int ENA = 27, IN1 = 25, IN2 = 26;
const int ENB = 14, IN3 = 32, IN4 = 33;
const int ESTOP = 4; // NC switch to GND with INPUT_PULLUP
const unsigned long WATCHDOG_MS = 500;
const unsigned long WIFI_RETRY_MS = 5000;

WebServer server(8081);
String rx;
unsigned long lastCommand = 0;
unsigned long lastWifiCheck = 0;
bool wifiStarted = false;
int leftNow = 0, rightNow = 0;
int headingNow = 0;

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
    case 0:   l = baseSpeed;               r = baseSpeed;               break; // Forward
    case 45:  l = baseSpeed;               r = (int)(baseSpeed * 0.40); break; // Fwd-Right
    case 90:  l = (int)(baseSpeed * 0.85); r = -(int)(baseSpeed * 0.85);break; // Pivot Right
    case 135: l = -(int)(baseSpeed * 0.80);r = -(int)(baseSpeed * 0.35);break; // Rev-Right
    case 180: l = -baseSpeed;              r = -baseSpeed;              break; // Reverse
    case 225: l = -(int)(baseSpeed * 0.35);r = -(int)(baseSpeed * 0.80);break; // Rev-Left
    case 270: l = -(int)(baseSpeed * 0.85);r = (int)(baseSpeed * 0.85); break; // Pivot Left
    case 315: l = (int)(baseSpeed * 0.40); r = baseSpeed;               break; // Fwd-Left
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
    return "OK STOP";
  }
  if (line == "PING") {
    return String(digitalRead(ESTOP) == HIGH ? "PONG ESTOP=1" : "PONG ESTOP=0")
         + " WIFI=" + (WiFi.status() == WL_CONNECTED ? "1" : "0");
  }
  if (line == "STATUS?") {
    return String("{\"heading\":") + headingNow + ",\"left\":" + leftNow + ",\"right\":" + rightNow
         + ",\"estop\":" + (digitalRead(ESTOP) == HIGH ? 1 : 0)
         + ",\"wifi\":" + (WiFi.status() == WL_CONNECTED ? 1 : 0) + "}";
  }
  if (line.startsWith("DIR ")) {
    if (digitalRead(ESTOP) == HIGH) { stopMotors(); return "ERR ESTOP"; }
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
    if (digitalRead(ESTOP) == HIGH) { stopMotors(); return "ERR ESTOP"; }
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
  pinMode(ESTOP, INPUT_PULLUP);
  stopMotors();
  Serial.begin(115200);
  lastCommand = millis();
  setupWifi();
  Serial.println("SIMPLA_ESP32_READY");
}

void loop() {
  if (digitalRead(ESTOP) == HIGH || ((leftNow || rightNow) && millis() - lastCommand > WATCHDOG_MS)) {
    stopMotors();
  }
  if (wifiStarted) {
    server.handleClient();
    if (WiFi.status() != WL_CONNECTED && millis() - lastWifiCheck > WIFI_RETRY_MS) {
      lastWifiCheck = millis();
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

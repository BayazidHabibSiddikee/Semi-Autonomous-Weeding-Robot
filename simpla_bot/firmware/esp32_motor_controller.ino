/*
 * Simpla Bot ESP32 Dual-Path Controller (USB Serial + Direct Phone Wi-Fi Web/API)
 *
 * Two Ways to Control from Phone:
 *   Way 1: Phone -> Raspberry Pi Hub (:8080) -> ESP32 USB Serial
 *   Way 2: Phone -> ESP32 Direct (:8081) over Wi-Fi ("bayazid"/"12345678" or AP "esp32-rover"/"12345678")
 *          Open http://<esp32-ip>:8081 or http://esp32-rover.local:8081 in phone browser,
 *          or switch Android app to "DIRECT ESP32" mode (auto-discovers via UDP port 8082).
 *
 * Hardware:
 *   1. L298N Dual H-Bridge (Left=ENA 27/IN1 25/IN2 26, Right=ENB 14/IN3 32/IN4 33)
 *   2. MG996R Servo on GPIO 15 driven by exact 50 Hz LEDC frequency PWM (-30° to +30°)
 *   3. High-Voltage Arc Module on GPIO 18 (safety-interlocked, non-blocking 2000 ms cap)
 *   4. Hardware E-Stop Switch on GPIO 4 (NC to GND with INPUT_PULLUP)
 */
#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <WiFiUdp.h>
#include <ESPmDNS.h>

// Fixed Raspberry Pi hotspot credentials + fallback Direct AP
const char* WIFI_SSID = "bayazid";
const char* WIFI_PASS = "12345678";
const char* AP_SSID   = "esp32-rover";
const char* AP_PASS   = "12345678";

const int ENA = 27, IN1 = 25, IN2 = 26;
const int ENB = 14, IN3 = 32, IN4 = 33;
const int ESTOP = 4;

const int PIN_SERVO = 15;
const int SERVO_FREQ_HZ = 50;
const int SERVO_RES_BITS = 16;
const int SERVO_MIN_DEG = -30;
const int SERVO_MAX_DEG = 30;

const int PIN_ARC_MODULE = 18;
const int ARC_ACTIVE = HIGH;
const int ARC_INACTIVE = LOW;
const unsigned long MAX_ARC_MS = 2000;

const unsigned long WATCHDOG_MS = 500;
const unsigned long WIFI_RETRY_MS = 5000;
const uint16_t UDP_DISCOVERY_PORT = 8082;

WebServer server(8081);
WiFiUDP udp;
String rx;
unsigned long lastCommand = 0;
unsigned long lastWifiRetry = 0;
bool wifiStarted = false;

int leftNow = 0, rightNow = 0;
int headingNow = 0;
int servoDegNow = 0;
bool arcActive = false;
unsigned long arcOffAtMs = 0;

const char WEB_UI_HTML[] PROGMEM = R"HTML(<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ESP32 Rover Direct</title>
<style>
body{font-family:sans-serif;background:#10141a;color:#eef;text-align:center;margin:0;padding:14px}
.grid{display:grid;grid-template-columns:repeat(3,76px);gap:10px;justify-content:center;margin:14px auto}
button{padding:16px;font-size:20px;border:none;border-radius:12px;background:#263238;color:#fff;touch-action:none}
button:active{background:#00bfa5}
.stop{background:#c62828;font-size:15px;font-weight:bold}
.arc{background:#ef6c00;font-size:15px;padding:12px 18px;margin:6px}
.card{background:#1a222c;border-radius:12px;padding:12px;margin:10px auto;max-width:340px}
</style></head><body>
<h3>ESP32 Direct Control</h3>
<div id="st" class="card">Connecting...</div>
<div class="grid">
  <button onpointerdown="hold('DIR 315')" onpointerup="stop()">&#8598;</button>
  <button onpointerdown="hold('DIR 0')" onpointerup="stop()">&#9650;</button>
  <button onpointerdown="hold('DIR 45')" onpointerup="stop()">&#8599;</button>
  <button onpointerdown="hold('DIR 270')" onpointerup="stop()">&#9664;</button>
  <button class="stop" onclick="stop()">STOP</button>
  <button onpointerdown="hold('DIR 90')" onpointerup="stop()">&#9654;</button>
  <button onpointerdown="hold('DIR 225')" onpointerup="stop()">&#8601;</button>
  <button onpointerdown="hold('DIR 180')" onpointerup="stop()">&#9660;</button>
  <button onpointerdown="hold('DIR 135')" onpointerup="stop()">&#8600;</button>
</div>
<div class="card">
  <div>Servo (50Hz): <span id="sv">0</span>&deg;</div>
  <input type="range" min="-30" max="30" value="0" style="width:90%" oninput="sv.innerText=this.value" onchange="cmd('SERVO '+this.value)">
  <div><button class="arc" onclick="cmd('ARC 800')">ARC PULSE 0.8s</button><button onclick="cmd('ARC OFF')">ARC OFF</button></div>
</div>
<script>
let t=null;
function cmd(q){return fetch('/cmd?q='+encodeURIComponent(q)).catch(()=>{});}
function hold(q){clearInterval(t);cmd(q);t=setInterval(()=>cmd(q),180);}
function stop(){clearInterval(t);t=null;cmd('STOP');}
setInterval(()=>fetch('/status').then(r=>r.json()).then(s=>{
  st.innerText=`Heading:${s.heading} Servo:${s.servo_deg} Arc:${s.arc} EStop:${s.estop}`;
}).catch(()=>{}),700);
</script></body></html>)HTML";

void setArc(bool on, unsigned long durationMs = MAX_ARC_MS) {
  if (!on) {
    arcActive = false;
    arcOffAtMs = 0;
    digitalWrite(PIN_ARC_MODULE, ARC_INACTIVE);
    return;
  }
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
  if (l != 0 || r != 0) setArc(false);
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
         + ",\"wifi\":" + (WiFi.status() == WL_CONNECTED ? 1 : 0)
         + ",\"ip\":\"" + WiFi.localIP().toString() + "\"}";
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
  WiFi.mode(WIFI_AP_STA);
  WiFi.setAutoReconnect(true);
  WiFi.softAP(AP_SSID, AP_PASS);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  MDNS.begin("esp32-rover");
  udp.begin(UDP_DISCOVERY_PORT);

  server.on("/", []() { server.send_P(200, "text/html", WEB_UI_HTML); });
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

void handleUdpDiscovery() {
  int pktSize = udp.parsePacket();
  if (pktSize <= 0) return;
  char buf[64];
  int n = udp.read(buf, sizeof(buf) - 1);
  buf[n > 0 ? n : 0] = '\0';
  String msg(buf);
  msg.trim();
  if (msg == "DISCOVER_ESP32" || msg == "DISCOVER_PI_ROVER") {
    String ipStr = (WiFi.status() == WL_CONNECTED) ? WiFi.localIP().toString() : WiFi.softAPIP().toString();
    String reply = String("{\"service\":\"esp32-rover\",\"port\":8081,\"ip\":\"") + ipStr + "\"}";
    udp.beginPacket(udp.remoteIP(), udp.remotePort());
    udp.print(reply);
    udp.endPacket();
  }
}

void setup() {
  pinMode(ENA, OUTPUT); pinMode(IN1, OUTPUT); pinMode(IN2, OUTPUT);
  pinMode(ENB, OUTPUT); pinMode(IN3, OUTPUT); pinMode(IN4, OUTPUT);
  pinMode(PIN_ARC_MODULE, OUTPUT);
  digitalWrite(PIN_ARC_MODULE, ARC_INACTIVE);
  pinMode(ESTOP, INPUT_PULLUP);
  stopMotors();

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
    handleUdpDiscovery();
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

#include <WiFi.h>
#include <esp_wifi.h>
#include <WebServer.h>
#include <ESPmDNS.h>

// Motor driver pins
const int ENA = 27;
const int IN1 = 25;
const int IN2 = 26;

const int ENB = 14;
const int IN3 = 32;
const int IN4 = 33;

// Phone Hotspot Credentials
const char* ssid = "Inox";
const char* password = "12345678";

WebServer server(80);

unsigned long lastCommand = 0;
const unsigned long WATCHDOG = 500;
bool mdnsStarted = false;

// Motor control
void leftMotor(int speed) {
  speed = constrain(speed, -255, 255);
  digitalWrite(IN1, speed > 0);
  digitalWrite(IN2, speed < 0);
  analogWrite(ENA, abs(speed));
}

void rightMotor(int speed) {
  speed = constrain(speed, -255, 255);
  digitalWrite(IN3, speed > 0);
  digitalWrite(IN4, speed < 0);
  analogWrite(ENB, abs(speed));
}

void stopCar() {
  leftMotor(0);
  rightMotor(0);
}

void forward() {
  leftMotor(180);
  rightMotor(180);
  lastCommand = millis();
}

void backward() {
  leftMotor(-180);
  rightMotor(-180);
  lastCommand = millis();
}

void turnLeft() {
  leftMotor(-160);
  rightMotor(160);
  lastCommand = millis();
}

void turnRight() {
  leftMotor(160);
  rightMotor(-160);
  lastCommand = millis();
}

// HTML Web Page
const char webpage[] PROGMEM = R"rawliteral(
<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body {
  background: #111827;
  color: white;
  font-family: Arial;
  text-align: center;
  margin-top: 30px;
}
h2 { color: #38bdf8; }
.grid {
  display: grid;
  grid-template-columns: 90px 90px 90px;
  gap: 12px;
  justify-content: center;
  margin-top: 35px;
}
button {
  height: 80px;
  width: 90px;
  font-size: 25px;
  border: none;
  border-radius: 15px;
  background: #334155;
  color: white;
  touch-action: none;
  user-select: none;
}
button:active { background: #0ea5e9; }
.stop { background: #dc2626; font-size: 18px; }
.empty { visibility: hidden; }
</style>
</head>
<body>
<h2>ESP32 BOT CONTROL</h2>
<p>Press and hold to move</p>
<div class="grid">
  <button class="empty"></button>
  <button onpointerdown="startMove('forward')" onpointerup="stopMove()" onpointerleave="stopMove()" onpointercancel="stopMove()">&#8593;</button>
  <button class="empty"></button>
  <button onpointerdown="startMove('left')" onpointerup="stopMove()" onpointerleave="stopMove()" onpointercancel="stopMove()">&#8592;</button>
  <button class="stop" onclick="stopMove()">STOP</button>
  <button onpointerdown="startMove('right')" onpointerup="stopMove()" onpointerleave="stopMove()" onpointercancel="stopMove()">&#8594;</button>
  <button class="empty"></button>
  <button onpointerdown="startMove('backward')" onpointerup="stopMove()" onpointerleave="stopMove()" onpointercancel="stopMove()">&#8595;</button>
  <button class="empty"></button>
</div>
<script>
let timer = null;
function sendCommand(cmd) { fetch('/' + cmd).catch(() => {}); }
function startMove(cmd) {
  stopTimer();
  sendCommand(cmd);
  timer = setInterval(() => { sendCommand(cmd); }, 200);
}
function stopTimer() {
  if (timer) { clearInterval(timer); timer = null; }
}
function stopMove() {
  stopTimer();
  sendCommand('stop');
}
</script>
</body>
</html>
)rawliteral";

void setupServer() {
  server.on("/", []() { server.send_P(200, "text/html", webpage); });
  server.on("/forward", []() { forward(); server.send(200, "text/plain", "Forward"); });
  server.on("/backward", []() { backward(); server.send(200, "text/plain", "Backward"); });
  server.on("/left", []() { turnLeft(); server.send(200, "text/plain", "Left"); });
  server.on("/right", []() { turnRight(); server.send(200, "text/plain", "Right"); });
  server.on("/stop", []() { stopCar(); server.send(200, "text/plain", "Stop"); });
  server.begin();
}

void setup() {
  Serial.begin(115200);

  pinMode(ENA, OUTPUT);
  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);
  pinMode(ENB, OUTPUT);
  pinMode(IN3, OUTPUT);
  pinMode(IN4, OUTPUT);
  stopCar();

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(ssid, password);
  WiFi.setSleep(false);
  esp_wifi_set_ps(WIFI_PS_NONE);

  Serial.print("\nConnecting to phone hotspot: ");
  Serial.println(ssid);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 8000) {
    delay(250);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("Connected! IP Address: ");
    Serial.println(WiFi.localIP());
    if (MDNS.begin("esp32-bot")) {
      mdnsStarted = true;
      Serial.println("mDNS active: http://esp32-bot.local");
    }
  } else {
    Serial.println("Hotspot not found yet, will auto-reconnect when Inox is on.");
  }

  setupServer();
}

void loop() {
  if (WiFi.status() == WL_CONNECTED && !mdnsStarted) {
    Serial.print("Connected! IP Address: ");
    Serial.println(WiFi.localIP());
    if (MDNS.begin("esp32-bot")) {
      mdnsStarted = true;
      Serial.println("mDNS active: http://esp32-bot.local");
    }
  }

  server.handleClient();

  // Safety watchdog
  if ((millis() - lastCommand > WATCHDOG) &&
      (digitalRead(IN1) != digitalRead(IN2) ||
       digitalRead(IN3) != digitalRead(IN4))) {
    stopCar();
  }
}

/*
 * ============================================================================
 * Simpla Bot — Normal Motor Driver + 2-Channel Relay Firmware
 * Target: Arduino Uno / Nano / Mega (or ESP32 with pin remap)
 * Branch: simpla_bot
 *
 * Hardware controlled:
 *   - Normal Dual H-Bridge Motor Driver (L298N or BTS7960)
 *   - Channel 1 Relay: Grinding Machine (motor contactor)
 *   - Channel 2 Relay: Flame Control (solenoid gas valve + spark igniter)
 *   - Hardware E-Stop Switch (Normally Closed -> GND; opening cuts all outputs)
 *
 * USB Serial Protocol (115200 baud, newline terminated):
 *   M <left_pct> <right_pct>   -> Drive motors (-100..100 each)
 *   R <grinder 0|1> <flame 0|1> -> Set relays (BLOCKED if moving or E-stop!)
 *   STOP                       -> Stop motors immediately
 *   PING                       -> Returns "PONG ESTOP=<0|1>"
 *
 * Built-in Hardware Safety Watchdogs:
 *   1. 800 ms Serial Watchdog: if Raspberry Pi freezes or USB unplugs,
 *      motors + grinder + flame IMMEDIATELY shut off.
 *   2. 2500 ms Hard Flame Cap: even if software crashes mid-burn, Arduino
 *      forcibly closes the flame relay after 2.5 seconds.
 *   3. Stationary Interlock: flame & grinder relays are refused while PWM > 0.
 *   4. Physical E-Stop Pin: polled every loop; forces all outputs OFF instantly.
 * ============================================================================
 */

// --- L298N Normal Motor Driver Pins (Arduino Uno/Nano) ---
const int PIN_ENA = 5;   // Left PWM (Timer0)
const int PIN_IN1 = 7;   // Left DIR A
const int PIN_IN2 = 8;   // Left DIR B

const int PIN_ENB = 6;   // Right PWM (Timer0)
const int PIN_IN3 = 9;   // Right DIR A
const int PIN_IN4 = 10;  // Right DIR B

// --- 2-Channel Relay Module Pins (Active-LOW on most opto-isolated boards) ---
const bool RELAY_ACTIVE_LOW = true;
const int PIN_RELAY_GRINDER = 3;
const int PIN_RELAY_FLAME   = 4;

// --- Physical E-Stop Switch (NC switch wired between D2 and GND) ---
// With INPUT_PULLUP: LOW = safe (closed), HIGH = E-STOP TRIGGERED (open/pressed)
const int PIN_ESTOP = 2;

// --- Safety Timers ---
const unsigned long SERIAL_WATCHDOG_MS = 800;
const unsigned long MAX_FLAME_ON_MS    = 2500;

int currentLeftPct  = 0;
int currentRightPct = 0;
bool grinderState   = false;
bool flameState     = false;

unsigned long lastCommandMs = 0;
unsigned long flameStartMs  = 0;
String rxLine = "";

inline bool isEstopTriggered() {
  return digitalRead(PIN_ESTOP) == HIGH;
}

inline void writeRelay(int pin, bool on) {
  if (RELAY_ACTIVE_LOW) {
    digitalWrite(pin, on ? LOW : HIGH);
  } else {
    digitalWrite(pin, on ? HIGH : LOW);
  }
}

void setMotors(int leftPct, int rightPct) {
  leftPct  = constrain(leftPct,  -100, 100);
  rightPct = constrain(rightPct, -100, 100);

  if (isEstopTriggered()) {
    leftPct = 0;
    rightPct = 0;
  }

  // Never allow tools to remain ON if rover starts moving
  if (leftPct != 0 || rightPct != 0) {
    grinderState = false;
    flameState = false;
    writeRelay(PIN_RELAY_GRINDER, false);
    writeRelay(PIN_RELAY_FLAME, false);
  }

  currentLeftPct = leftPct;
  currentRightPct = rightPct;

  // Left channel
  if (leftPct > 0) {
    digitalWrite(PIN_IN1, HIGH);
    digitalWrite(PIN_IN2, LOW);
    analogWrite(PIN_ENA, map(leftPct, 0, 100, 0, 255));
  } else if (leftPct < 0) {
    digitalWrite(PIN_IN1, LOW);
    digitalWrite(PIN_IN2, HIGH);
    analogWrite(PIN_ENA, map(-leftPct, 0, 100, 0, 255));
  } else {
    digitalWrite(PIN_IN1, LOW);
    digitalWrite(PIN_IN2, LOW);
    analogWrite(PIN_ENA, 0);
  }

  // Right channel
  if (rightPct > 0) {
    digitalWrite(PIN_IN3, HIGH);
    digitalWrite(PIN_IN4, LOW);
    analogWrite(PIN_ENB, map(rightPct, 0, 100, 0, 255));
  } else if (rightPct < 0) {
    digitalWrite(PIN_IN3, LOW);
    digitalWrite(PIN_IN4, HIGH);
    analogWrite(PIN_ENB, map(-rightPct, 0, 100, 0, 255));
  } else {
    digitalWrite(PIN_IN3, LOW);
    digitalWrite(PIN_IN4, LOW);
    analogWrite(PIN_ENB, 0);
  }
}

void emergencyAllOff() {
  grinderState = false;
  flameState = false;
  writeRelay(PIN_RELAY_GRINDER, false);
  writeRelay(PIN_RELAY_FLAME, false);
  currentLeftPct = 0;
  currentRightPct = 0;
  digitalWrite(PIN_IN1, LOW);
  digitalWrite(PIN_IN2, LOW);
  digitalWrite(PIN_IN3, LOW);
  digitalWrite(PIN_IN4, LOW);
  analogWrite(PIN_ENA, 0);
  analogWrite(PIN_ENB, 0);
}

void setRelays(bool grinderOn, bool flameOn) {
  if (isEstopTriggered() || currentLeftPct != 0 || currentRightPct != 0) {
    grinderState = false;
    flameState = false;
    writeRelay(PIN_RELAY_GRINDER, false);
    writeRelay(PIN_RELAY_FLAME, false);
    Serial.println("ERR INTERLOCK_BLOCKED");
    return;
  }

  if (flameOn && !flameState) {
    flameStartMs = millis();
  }
  grinderState = grinderOn;
  flameState   = flameOn;
  writeRelay(PIN_RELAY_GRINDER, grinderState);
  writeRelay(PIN_RELAY_FLAME, flameState);
  Serial.println("OK");
}

void handleLine(String line) {
  line.trim();
  if (line.length() == 0) return;
  lastCommandMs = millis();

  if (line == "STOP") {
    emergencyAllOff();
    Serial.println("OK STOP");
    return;
  }
  if (line == "PING") {
    Serial.print("PONG ESTOP=");
    Serial.println(isEstopTriggered() ? 1 : 0);
    return;
  }
  if (line.startsWith("M ")) {
    int sp1 = line.indexOf(' ');
    int sp2 = line.indexOf(' ', sp1 + 1);
    if (sp2 > sp1) {
      int l = line.substring(sp1 + 1, sp2).toInt();
      int r = line.substring(sp2 + 1).toInt();
      setMotors(l, r);
      Serial.println("OK");
      return;
    }
  }
  if (line.startsWith("R ")) {
    int sp1 = line.indexOf(' ');
    int sp2 = line.indexOf(' ', sp1 + 1);
    if (sp2 > sp1) {
      int g = line.substring(sp1 + 1, sp2).toInt();
      int f = line.substring(sp2 + 1).toInt();
      setRelays(g != 0, f != 0);
      return;
    }
  }
  Serial.println("ERR UNKNOWN_CMD");
}

void setup() {
  pinMode(PIN_ENA, OUTPUT);
  pinMode(PIN_IN1, OUTPUT);
  pinMode(PIN_IN2, OUTPUT);
  pinMode(PIN_ENB, OUTPUT);
  pinMode(PIN_IN3, OUTPUT);
  pinMode(PIN_IN4, OUTPUT);

  pinMode(PIN_RELAY_GRINDER, OUTPUT);
  pinMode(PIN_RELAY_FLAME, OUTPUT);
  pinMode(PIN_ESTOP, INPUT_PULLUP);

  emergencyAllOff();

  Serial.begin(115200);
  lastCommandMs = millis();
  Serial.println("SIMPLA_BOT_READY");
}

void loop() {
  // 1. Hardware E-Stop has highest priority
  if (isEstopTriggered()) {
    emergencyAllOff();
  }

  // 2. Hardware flame burn time limit (2.5s hard cap)
  if (flameState && (millis() - flameStartMs >= MAX_FLAME_ON_MS)) {
    flameState = false;
    writeRelay(PIN_RELAY_FLAME, false);
    Serial.println("WARN FLAME_CAP_CUTOFF");
  }

  // 3. Serial communication watchdog (800ms)
  if ((currentLeftPct != 0 || currentRightPct != 0 || grinderState || flameState) &&
      (millis() - lastCommandMs > SERIAL_WATCHDOG_MS)) {
    emergencyAllOff();
    Serial.println("WARN WATCHDOG_CUTOFF");
  }

  // 4. Read serial commands
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (rxLine.length() > 0) {
        handleLine(rxLine);
        rxLine = "";
      }
    } else if (rxLine.length() < 64) {
      rxLine += c;
    }
  }
}

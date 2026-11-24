/*
 * Simpla Bot ESP32 USB motor controller.
 * ESP32 owns the L298N. Pi sends: M <left -100..100> <right -100..100>, STOP, PING.
 * Four motors remain paired: left pair = channel A, right pair = channel B.
 * Verify pin assignments and driver/motor current ratings before connecting motors.
 */
#include <Arduino.h>
const int ENA=27, IN1=25, IN2=26;
const int ENB=14, IN3=32, IN4=33;
const int ESTOP=4; // NC switch to GND with INPUT_PULLUP; supplementary input only
const unsigned long WATCHDOG_MS=500;
String rx;
unsigned long lastCommand=0;
int leftNow=0, rightNow=0;

void channel(int en,int a,int b,int value) {
  value=constrain(value,-35,35);
  digitalWrite(a,value>0); digitalWrite(b,value<0);
  analogWrite(en,map(abs(value),0,35,0,255));
}
void stopMotors() {
  leftNow=rightNow=0;
  analogWrite(ENA,0); analogWrite(ENB,0);
  digitalWrite(IN1,LOW); digitalWrite(IN2,LOW);
  digitalWrite(IN3,LOW); digitalWrite(IN4,LOW);
}
void command(String line) {
  line.trim(); if (!line.length()) return;
  lastCommand=millis();
  if (line=="STOP") { stopMotors(); Serial.println("OK STOP"); return; }
  if (line=="PING") { Serial.println(digitalRead(ESTOP)==HIGH ? "PONG ESTOP=1" : "PONG ESTOP=0"); return; }
  if (line.startsWith("M ")) {
    int split=line.indexOf(' ',2); if (split<0) { Serial.println("ERR FORMAT"); return; }
    int l=constrain(line.substring(2,split).toInt(),-35,35);
    int r=constrain(line.substring(split+1).toInt(),-35,35);
    if (digitalRead(ESTOP)==HIGH) { stopMotors(); Serial.println("ERR ESTOP"); return; }
    leftNow=l; rightNow=r;
    channel(ENA,IN1,IN2,l); channel(ENB,IN3,IN4,r);
    Serial.println("OK"); return;
  }
  Serial.println("ERR UNKNOWN");
}
void setup() {
  pinMode(ENA,OUTPUT); pinMode(IN1,OUTPUT); pinMode(IN2,OUTPUT);
  pinMode(ENB,OUTPUT); pinMode(IN3,OUTPUT); pinMode(IN4,OUTPUT);
  pinMode(ESTOP,INPUT_PULLUP); stopMotors();
  Serial.begin(115200); lastCommand=millis(); Serial.println("SIMPLA_ESP32_READY");
}
void loop() {
  if (digitalRead(ESTOP)==HIGH || ((leftNow||rightNow) && millis()-lastCommand>WATCHDOG_MS)) stopMotors();
  while (Serial.available()) {
    char c=(char)Serial.read();
    if (c=='\n' || c=='\r') { command(rx); rx=""; }
    else if (rx.length()<64) rx+=c;
  }
}

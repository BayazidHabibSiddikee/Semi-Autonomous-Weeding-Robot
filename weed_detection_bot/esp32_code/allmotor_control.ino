#include <ESP32Servo.h>

Servo weedServo;

// --- PIN DEFINITIONS ---
const int servoPin = 15;  
#define RXD2 16           
#define TXD2 17           

// New Relay Pins
const int relay1Pin = 26;
const int relay2Pin = 27;

// IMPORTANT: Most Arduino relays turn ON when the signal is LOW. 
// If your relays turn on at the wrong time, change HIGH to LOW and LOW to HIGH here:
const int RELAY_ON = HIGH; 
const int RELAY_OFF = LOW;

void setup() {
  Serial.begin(115200);
  Serial2.begin(115200, SERIAL_8N1, RXD2, TXD2);
  
  // Setup Relay Pins
  pinMode(relay1Pin, OUTPUT);
  pinMode(relay2Pin, OUTPUT);
  
  // Ensure relays are OFF at startup
  digitalWrite(relay1Pin, RELAY_OFF);
  digitalWrite(relay2Pin, RELAY_OFF);
  
  weedServo.attach(servoPin);
  weedServo.write(0); 
  
  Serial.println("ESP32 Online. Relays configured on Pins 26 and 27.");
}

void loop() {
  if (Serial2.available() > 0) {
    String command = Serial2.readStringUntil('\n');
    command.trim(); 
    
    int targetAngle = command.toInt();
    
    // 1. Move the servo to the requested angle
    weedServo.write(targetAngle);
    
    // 2. If the Pi commanded 90 degrees, run the Relay Sequence!
    if (targetAngle == 90) {
      Serial.println("Target acquired. Executing Relay Sequence...");
      
      // Turn ON Relay 1 for 5 seconds
      Serial.println("Relay 1: ON");
      digitalWrite(relay1Pin, RELAY_ON);
      delay(5000); 
      
      // Turn OFF Relay 1, Turn ON Relay 2 for 5 seconds
      Serial.println("Relay 1: OFF | Relay 2: ON");
      digitalWrite(relay1Pin, RELAY_OFF);
      digitalWrite(relay2Pin, RELAY_ON);
      delay(5000);
      
      // Turn OFF Relay 2 (Sequence Complete)
      Serial.println("Relay 2: OFF. Sequence Complete.");
      digitalWrite(relay2Pin, RELAY_OFF);
    }
    
    // 3. Safety Check: If returning to 0, ensure relays are forced OFF
    if (targetAngle == 0) {
       digitalWrite(relay1Pin, RELAY_OFF);
       digitalWrite(relay2Pin, RELAY_OFF);
    }
  }
}
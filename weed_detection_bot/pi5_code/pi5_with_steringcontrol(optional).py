import cv2
import time
import threading
import serial
import RPi.GPIO as GPIO
from ultralytics import YOLO

# ==========================================
# 1. ESP32 SERIAL CONNECTION
# ==========================================
try:
    print("Connecting to ESP32 on /dev/ttyAMA0...")
    esp32 = serial.Serial('/dev/ttyAMA0', 115200, timeout=1)
    time.sleep(2) 
    print("ESP32 Connected Successfully!")
except serial.SerialException:
    print("[ERROR] ESP32 not found on /dev/ttyAMA0! Check RX/TX jumper wires.")
    exit()

# ==========================================
# 2. THREADED CAMERA CLASS (Pi 5 Optimized)
# ==========================================
class CameraStream:
    def __init__(self, src=0):
        self.stream = cv2.VideoCapture(src)
        self.stream.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*'MJPG'))
        self.stream.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
        self.stream.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
        self.stream.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        (self.grabbed, self.frame) = self.stream.read()
        self.stopped = False

    def start(self):
        threading.Thread(target=self.update, args=(), daemon=True).start()
        return self

    def update(self):
        while True:
            if self.stopped:
                self.stream.release()
                return
            (self.grabbed, self.frame) = self.stream.read()

    def read(self):
        return self.frame

    def stop(self):
        self.stopped = True

# ==========================================
# 3. GPIO HARDWARE CONFIGURATION
# ==========================================
GPIO.setmode(GPIO.BCM)
GPIO.setwarnings(False)

PIN_CROP_LED = 17   
PIN_WEED_LED = 27   
PIN_IN1 = 22        
PIN_IN3 = 23        
PIN_ENA = 12        
PIN_ENB = 13        
PIN_CUTTER = 24     

pins_to_setup = [PIN_CROP_LED, PIN_WEED_LED, PIN_IN1, PIN_IN3, PIN_ENA, PIN_ENB, PIN_CUTTER]
for pin in pins_to_setup:
    GPIO.setup(pin, GPIO.OUT)

pwm_left = GPIO.PWM(PIN_ENA, 100)   
pwm_right = GPIO.PWM(PIN_ENB, 100)
pwm_left.start(0)
pwm_right.start(0)

# ==========================================
# 4. ACTION FUNCTIONS
# ==========================================
def move_forward(speed):
    GPIO.output(PIN_IN1, GPIO.HIGH)
    GPIO.output(PIN_IN3, GPIO.HIGH)
    pwm_left.ChangeDutyCycle(speed)
    pwm_right.ChangeDutyCycle(speed)

def turn_left(speed):
    # Soft pivot left: Left motor OFF, Right motor FORWARD
    GPIO.output(PIN_IN1, GPIO.LOW)
    GPIO.output(PIN_IN3, GPIO.HIGH)
    pwm_left.ChangeDutyCycle(0)
    pwm_right.ChangeDutyCycle(speed)

def turn_right(speed):
    # Soft pivot right: Left motor FORWARD, Right motor OFF
    GPIO.output(PIN_IN1, GPIO.HIGH)
    GPIO.output(PIN_IN3, GPIO.LOW)
    pwm_left.ChangeDutyCycle(speed)
    pwm_right.ChangeDutyCycle(0)

def stop_robot():
    GPIO.output(PIN_IN1, GPIO.LOW)
    GPIO.output(PIN_IN3, GPIO.LOW)
    pwm_left.ChangeDutyCycle(0)
    pwm_right.ChangeDutyCycle(0)

def set_servo_angle_esp32(angle):
    command = f"{angle}\n"
    esp32.write(command.encode('utf-8'))
    time.sleep(0.5) 

def activate_cutter(camera_stream, duration=12.0):
    print(f">>> CUTTING WEED FOR {duration} SECONDS... <<<")
    GPIO.output(PIN_CUTTER, GPIO.HIGH)  
    start_time = time.time()
    while time.time() - start_time < duration:
        current_frame = camera_stream.read()
        time.sleep(0.1) 
    GPIO.output(PIN_CUTTER, GPIO.LOW)   
    print(">>> CUTTING DONE. RESUMING MOVEMENT. <<<")

def startup_sequence():
    print(">>> EXECUTING STARTUP WAVE <<<")
    for _ in range(2):
        GPIO.output(PIN_WEED_LED, GPIO.HIGH)
        GPIO.output(PIN_CROP_LED, GPIO.HIGH)
        set_servo_angle_esp32(80) 
        time.sleep(0.5) 
        GPIO.output(PIN_WEED_LED, GPIO.LOW)
        GPIO.output(PIN_CROP_LED, GPIO.LOW)
        set_servo_angle_esp32(0)
        time.sleep(0.5)
    print(">>> STARTUP WAVE COMPLETE <<<")

stop_robot()
GPIO.output(PIN_CUTTER, GPIO.LOW)
set_servo_angle_esp32(0) 

# ==========================================
# 5. MAIN PROGRAM SETTINGS & AI TUNING
# ==========================================
ROBOT_SPEED = 20         
CONFIRM_FRAMES = 2       
HISTORY_LENGTH = 5       

AI_CONFIDENCE = 0.60     
MIN_WEED_SIZE = 2000     
MAX_WEED_SIZE = 290000   

history = []
last_state = "stopped"

print("Loading YOLO Model...")
model = YOLO("/home/yash/crop_weed_bot/2best.pt") 

print("Starting Camera...")
cam = CameraStream(src=0).start()
time.sleep(1.0) 

startup_sequence()
print("SYSTEM READY. Scanning for weeds...")

# ==========================================
# 6. MAIN LOOP (HEADLESS AUTONOMOUS MODE)
# ==========================================
try:
    while True:
        try:
            frame = cam.read()
            if frame is None: 
                time.sleep(0.5)
                continue

            results = model(frame, imgsz=256, conf=AI_CONFIDENCE, verbose=False)
            detected_object = "none"
            
            if results[0].boxes:
                box = results[0].boxes[0]
                confidence = float(box.conf[0])
                
                x1, y1, x2, y2 = map(int, box.xyxy[0])
                box_area = (x2 - x1) * (y2 - y1)
                
                if MIN_WEED_SIZE < box_area < MAX_WEED_SIZE:
                    cls_id = int(box.cls[0])
                    class_name = model.names[cls_id].lower()
                    detected_object = class_name
                    
                    # Draw boxes silently in the background (will appear in the saved photo)
                    color = (0, 0, 255) if class_name == "weed" else (0, 255, 0)
                    cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
                    cv2.putText(frame, f"{class_name.upper()} {confidence:.2f}", (x1, y1 - 10), 
                                cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)

            history.append(detected_object)
            history = history[-HISTORY_LENGTH:]

            # --- VISUAL SERVOING / TARGET CENTERING LOGIC ---
            if history.count("weed") >= CONFIRM_FRAMES and detected_object == "weed":
                # Calculate the exact center of the weed bounding box
                x_center = (x1 + x2) / 2
                
                # Check if it is outside our Strike Zone (Pixel 240 to 400)
                if x_center < 240:
                    print(f"Target at X:{x_center}. Steering LEFT to center...")
                    turn_left(ROBOT_SPEED)
                    last_state = "turning"
                    
                elif x_center > 400:
                    print(f"Target at X:{x_center}. Steering RIGHT to center...")
                    turn_right(ROBOT_SPEED)
                    last_state = "turning"
                    
                else:
                    # THE WEED IS IN THE STRIKE ZONE! Execute the cut.
                    if last_state != "action":
                        stop_robot()
                        GPIO.output(PIN_WEED_LED, GPIO.HIGH)
                        GPIO.output(PIN_CROP_LED, GPIO.LOW)
                        
                        # Draw CUTTING warning and save the annotated photo
                        cv2.putText(frame, "STATUS: LOCKED & CUTTING!", (50, 50), cv2.FONT_HERSHEY_SIMPLEX, 1.5, (0, 0, 255), 3)
                        cv2.imwrite("/home/yash/crop_weed_bot/evidence.jpg", frame)
                        print(f">>> Target Locked at X:{x_center}! Saved annotated photo to evidence.jpg <<<")
                        
                        print("Deploying cutter to 90 degrees...")
                        set_servo_angle_esp32(90)   
                        activate_cutter(cam, duration=12.0)        
                        
                        print("Retracting cutter to 0 degrees...")
                        set_servo_angle_esp32(0)      
                        
                        # --- THE BLIND DRIVE ADDITION ---
                        print(">>> CLEARING THE AREA: Driving forward blindly for 2 seconds... <<<")
                        move_forward(ROBOT_SPEED)
                        time.sleep(2.0) # YOLO is paused while motors run!
                        # --------------------------------
                        
                        last_state = "moving" # Changed to moving since motors are now on
                        history = ["none"] * HISTORY_LENGTH 
                    
            else:
                # --- THE LED FIX ---
                # 1. ALWAYS update the LEDs every frame based on what we see right now
                GPIO.output(PIN_WEED_LED, GPIO.LOW)
                GPIO.output(PIN_CROP_LED, GPIO.HIGH if "crop" in history else GPIO.LOW)

                # 2. ONLY send motor commands if we are currently stopped or were turning
                if last_state != "moving" and last_state != "turning":
                    move_forward(ROBOT_SPEED)
                    last_state = "moving"

        except Exception as e:
            print(f"[WARNING] Minor glitch skipped: {e}")
            time.sleep(0.5) 

except KeyboardInterrupt:
    print("\nStopping Program...")

finally:
    cam.stop()
    stop_robot()
    GPIO.output(PIN_CUTTER, GPIO.LOW)
    try:
        set_servo_angle_esp32(0)
        esp32.close()
    except:
        pass
    pwm_left.stop()
    pwm_right.stop()
    GPIO.cleanup()
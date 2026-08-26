"""
Laser control via GPIO/MOSFET.
Fires laser at detected weed positions with safety limits.
"""
import time
import threading

try:
    import RPi.GPIO as GPIO
    HAS_GPIO = True
except (ImportError, RuntimeError):
    HAS_GPIO = False

class LaserController:
    def __init__(self, pin=18, simulate=False):
        """
        pin: GPIO pin connected to MOSFET gate
        simulate: if True, don't actually fire (for testing)
        """
        self.pin = pin
        self.simulate = simulate
        self.is_on = False
        self.last_fire_time = 0
        self.cooldown_s = 1.0
        self.max_continuous_s = 5.0
        self.fire_count = 0
        self._lock = threading.Lock()

        if not simulate and HAS_GPIO:
            GPIO.setmode(GPIO.BCM)
            GPIO.setup(self.pin, GPIO.OUT)
            GPIO.output(self.pin, GPIO.LOW)
            print(f"Laser initialized on GPIO {self.pin}")
        elif simulate:
            print("[SIM] Laser initialized (simulation mode)")

    def fire(self, duration_ms=300):
        """
        Fire laser for specified duration (milliseconds).
        Laser is fixed at 3cm height — constant power, no Z adjustment.
        Includes safety checks: cooldown, max continuous.
        """
        with self._lock:
            now = time.time()

            # Cooldown check
            if now - self.last_fire_time < self.cooldown_s:
                wait = self.cooldown_s - (now - self.last_fire_time)
                print(f"  Laser cooldown: waiting {wait:.1f}s")
                time.sleep(wait)

            # Max continuous check
            if self.fire_count > 0 and (now - self.last_fire_time) > self.max_continuous_s:
                print("  Max continuous fire reached, cooling down...")
                self.off()
                time.sleep(2.0)
                self.fire_count = 0

            # Fire
            self.on()
            time.sleep(duration_ms / 1000.0)
            self.off()

            self.fire_count += 1
            self.last_fire_time = time.time()

    def on(self):
        """Turn laser ON."""
        if self.simulate:
            print("[SIM] Laser ON")
        elif HAS_GPIO:
            GPIO.output(self.pin, GPIO.HIGH)
        self.is_on = True

    def off(self):
        """Turn laser OFF."""
        if self.simulate:
            print("[SIM] Laser OFF")
        elif HAS_GPIO:
            GPIO.output(self.pin, GPIO.LOW)
        self.is_on = False

    def emergency_off(self):
        """Emergency shutoff — always safe to call."""
        self.off()
        self.fire_count = 0
        print("LASER EMERGENCY OFF")

    def self_test(self):
        """Quick self-test: fire for 50ms."""
        print("Running laser self-test...")
        self.fire(50)
        print("Self-test complete")

    def cleanup(self):
        """Release GPIO resources."""
        self.off()
        if HAS_GPIO and not self.simulate:
            GPIO.cleanup(self.pin)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.cleanup()


class LaserSafety:
    """Safety interlock system."""

    def __init__(self, emergency_stop_pin=23, interlock_pin=24, simulate=False):
        self.estop_pin = emergency_stop_pin
        self.interlock_pin = interlock_pin
        self.simulate = simulate
        self.is_safe = True

        if not simulate and HAS_GPIO:
            GPIO.setmode(GPIO.BCM)
            GPIO.setup(self.estop_pin, GPIO.IN, pull_up_down=GPIO.PUD_UP)
            GPIO.setup(self.interlock_pin, GPIO.IN, pull_up_down=GPIO.PUD_UP)

            # Add interrupt for emergency stop
            GPIO.add_event_detect(
                self.estop_pin, GPIO.FALLING,
                callback=self._estop_callback, bouncetime=100
            )

    def _estop_callback(self, channel):
        """Called when emergency stop button is pressed."""
        print("\n*** EMERGENCY STOP PRESSED ***")
        self.is_safe = False

    def check_safety(self):
        """Check if all safety conditions are met."""
        if self.simulate:
            return True

        if not self.is_safe:
            return False

        if HAS_GPIO:
            # Check interlock (e.g., enclosure door switch)
            if GPIO.input(self.interlock_pin) == GPIO.HIGH:
                print("Safety interlock open!")
                return False

        return True

    def reset(self):
        """Reset safety state (after clearing emergency)."""
        self.is_safe = True
        print("Safety system reset")

    def cleanup(self):
        if HAS_GPIO and not self.simulate:
            GPIO.remove_event_detect(self.estop_pin)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--simulate", action="store_true")
    parser.add_argument("--test", action="store_true")
    args = parser.parse_args()

    with LaserController(simulate=args.simulate) as laser:
        if args.test:
            laser.self_test()
            print("Laser OK")

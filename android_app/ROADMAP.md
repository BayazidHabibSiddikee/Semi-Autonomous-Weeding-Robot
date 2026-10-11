# BEV Navigation App for Agricultural Robotics - Implementation Roadmap

## Project Overview
Build a Kotlin Android application that:
1. Captures a photo of an 8x6m chili field from a side angle (~40°)
2. User marks 4 corners of the field
3. Generates a Bird's Eye View (BEV) using OpenCV homography
4. Detects crop rows and generates Boustrophedon path
5. Sends JSON mission payload to Raspberry Pi via WiFi/Bluetooth

---

## Phase 1: Project Setup & OpenCV Integration (Week 1)

### 1.1 Gradle Configuration
- [ ] Add OpenCV Android SDK dependency (v4.10.0+)
- [ ] Configure native library loading
- [ ] Set up CMake for native OpenCV modules (optional)
- [ ] Add CameraX for camera capture
- [ ] Add Kotlin Coroutines & Flow for async operations
- [ ] Add Material Design components for UI

### 1.2 Project Structure (Clean Architecture)
```
app/
├── src/main/
│   ├── java/com/weedlaser/bev/
│   │   ├── data/              # Repository implementations
│   │   │   ├── local/         # Local storage (preferences, cache)
│   │   │   └── remote/        # Network (WiFi/Bluetooth to Pi)
│   │   ├── domain/            # Pure Kotlin business logic
---

## Phase 2: Camera & Image Capture (Week 1-2)

### 2.1 Camera Implementation
- [ ] CameraX setup with preview + capture use cases
- [ ] High-resolution capture (4032x3024 or max available)
- [ ] Orientation handling (EXIF rotation)
- [ ] Flash/torch control for consistent lighting
- [ ] Save captured image to internal storage

### 2.2 Image Preprocessing
- [ ] Downscale for UI display (maintain aspect ratio)
- [ ] Keep full-res for BEV processing
- [ ] Auto-enhance: contrast, brightness for better corner detection

---

## Phase 3: Corner Selection & Homography (Week 2)

### 3.1 Corner Selection UI
- [ ] Interactive overlay with 4 draggable corner handles
- [ ] Magnifying glass for precise placement
---

## Phase 4: Row Detection & Path Generation (Week 2-3)

### 4.1 Row Detection Algorithm
- [ ] Convert BEV to HSV color space
- [ ] Green vegetation threshold (chili plants)
- [ ] Morphological operations (close gaps, remove noise)
- [ ] Find vertical line clusters (HoughLinesP or contour projection)
- [ ] Cluster lines into distinct rows
- [ ] Output: row count, row center X positions, row spacing

### 4.2 Boustrophedon Path Generation
- [ ] Input: field dimensions, row count, row spacing
- [ ] Generate waypoints along each row centerline
- [ ] Add headland turns (alternating L/R)
- [ ] Calculate expected distance per row
- [ ] Output: ordered list of path segments with metadata

### 4.3 Path Visualization
- [ ] Draw path on BEV preview
- [ ] Show waypoints, turn directions
- [ ] Display metrics: total distance, estimated time

---

## Phase 5: Mission Payload & Communication (Week 3)

### 5.1 JSON Payload Structure
```json
{
  "version": 1,
  "field": {
    "width_m": 6.0,
    "length_m": 8.0,
    "total_rows": 10,
    "row_spacing_m": 0.6,
    "origin_corner": "top_left"
  },
  "path": [
---

## Phase 6: Polish & Testing (Week 3-4)

### 6.1 UI/UX Improvements
- [ ] Material 3 theming
- [ ] Dark mode support
- [ ] Error states & empty states
- [ ] Onboarding flow
- [ ] Settings: field dimensions, row count override

### 6.2 Testing
- [ ] Unit tests: homography math, path generation
- [ ] Instrumented tests: corner selection, camera
- [ ] Field testing with real 8x6m plot
- [ ] Integration test with Pi (mock or real)

### 6.3 Documentation
- [ ] User guide
- [ ] Developer setup guide
- [ ] API documentation for Pi integration

---

## Technical Specifications

### OpenCV Operations
```kotlin
// Key OpenCV calls
val src = MatOfPoint2f(cornerPoints.toTypedArray())
val dst = MatOfPoint2f(
    Point(0, 0),
    Point(outputWidth, 0),
    Point(outputWidth, outputHeight),
    Point(0, outputHeight)
)
val homography = Imgproc.getPerspectiveTransform(src, dst)
val bev = Mat()
Imgproc.warpPerspective(sourceMat, bev, homography, Size(outputWidth, outputHeight))
```
---

## Dependencies

```gradle
// build.gradle.kts (app module)
dependencies {
    // OpenCV
    implementation("org.opencv:opencv:4.10.0") // or local AAR
    
    // CameraX
    implementation("androidx.camera:camera-core:1.3.3")
    implementation("androidx.camera:camera-camera2:1.3.3")
    implementation("androidx.camera:camera-view:1.3.3")
    implementation("androidx.camera:camera-video:1.3.3")
    
    // Coroutines
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.9.0")
    
    // Flow
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.0")
    
    // Koin DI
    implementation("io.insert-koin:koin-android:3.5.6")
    implementation("io.insert-koin:koin-androidx-viewmodel:3.5.6")
    
    // Serialization
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")
    
    // Network
    implementation("com.squareup.okio:okio:3.9.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    
    // UI
    implementation("androidx.compose.ui:ui:1.6.0")
    implementation("androidx.compose.material3:material3:1.2.0")
    implementation("androidx.activity:activity-compose:1.9.0")
}
```

---

## Success Criteria

| Metric | Target |
|--------|--------|
| BEV geometric accuracy | <5% error at field corners |
| Row detection rate | >90% on clear furrows |
| App-to-Pi latency | <500ms over WiFi |
| Capture-to-BEV time | <3 seconds |
| App size | <50MB |
| Battery per session | <5% on modern phone |

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| OpenCV native lib load failure | Bundle AAR, fallback to Java-only perspective transform |
| Poor corner selection | Auto-detect ArUco markers at corners |
| Lighting variation | Guide user to capture at solar noon, add exposure lock |
| WiFi interference | Implement Bluetooth LE fallback |
| Parallax on tall plants | Document limitation, rely on bot's local sensors |

---

## Next Steps

1. **Initialize Android project** with Clean Architecture modules
2. **Integrate OpenCV** (download AAR, add to libs, configure CMake)
3. **Build Camera + Corner Selection** screens
4. **Implement Homography & BEV** pipeline
5. **Add Row Detection & Path Generation**
6. **Build Mission Sender** to Pi
7. **Field test & iterate**

### Row Detection Parameters (tunable)
- HSV Green range: H=[35,85], S=[40,255], V=[40,255]
- Morphology kernel: 5x5 ellipse
- HoughLinesP: rho=1, theta=π/180, threshold=50, minLineLength=100, maxLineGap=10
- Row clustering tolerance: ±15px

### Output Resolution
- BEV output: 800x600px (1px = 1cm) or 1600x1200px (1px = 0.5cm)
- Path waypoint spacing: 50cm intervals
    {"seq": 1, "type": "FOLLOW_ROW", "row": 1, "expected_dist_m": 8.0, "turn_after": "RIGHT"},
    {"seq": 2, "type": "TURN", "direction": "RIGHT", "gap_m": 0.6},
    {"seq": 3, "type": "FOLLOW_ROW", "row": 2, "expected_dist_m": 8.0, "turn_after": "RIGHT"},
    ...
  ],
  "attention_window": {
    "start_m": 7.0,
    "end_m": 8.5
  }
}
```

### 5.2 Network Communication
- [ ] WiFi Direct / Hotspot connection to Pi
- [ ] TCP socket for reliable JSON delivery
- [ ] Bluetooth fallback (optional)
- [ ] ACK/NACK protocol with retry
- [ ] Connection status UI
- [ ] Snap-to-edges assistance (optional)
- [ ] Visual feedback: field boundary preview
- [ ] Undo/Reset functionality

### 3.2 Homography Computation (OpenCV)
- [ ] Convert 4 user-selected points to `MatOfPoint2f`
- [ ] Define destination points for 8x6m field (e.g., 800x600px output)
- [ ] Call `Imgproc.getPerspectiveTransform(src, dst)`
- [ ] Apply `Imgproc.warpPerspective()` to generate BEV
- [ ] Handle edge cases: invalid points, degenerate transforms

### 3.3 BEV Output
- [ ] Save BEV as high-quality JPEG/PNG
- [ ] Display BEV in preview with row overlay
- [ ] Allow user to adjust/re-capture
│   │   │   ├── model/         # Domain models (Field, Row, Path, Mission)
│   │   │   ├── repository/    # Repository interfaces
│   │   │   └── usecase/       # UseCases
│   │   ├── presentation/      # UI Layer
│   │   │   ├── camera/        # Camera preview & capture
│   │   │   ├── corner/        # Corner selection UI
│   │   │   ├── bev/           # BEV display & path preview
│   │   │   ├── mission/       # Mission config & send
│   │   │   └── main/          # Main navigation
│   │   ├── core/              # Shared utilities
│   │   │   ├── opencv/        # OpenCV helpers
│   │   │   ├── camera/        # Camera helpers
│   │   │   └── network/       # Network helpers
│   │   └── di/                # Dependency Injection (Koin)
│   └── assets/                # OpenCV native libs (if needed)
```
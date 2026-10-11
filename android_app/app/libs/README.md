# OpenCV AAR

Place the OpenCV Android SDK's `opencv.aar` in this directory.

1. Download the OpenCV SDK for Android from https://opencv.org/releases/
2. Unzip the archive
3. Copy `sdk/java/opencv.aar` into this `libs/` folder
4. The build.gradle.kts already references `files("libs/opencv.aar")`

After adding the AAR, rebuild the project to pull in the native `.so` libraries.

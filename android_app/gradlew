#!/bin/sh

#
# Android Gradle build wrapper
# Delegates to the system gradle or downloads the distribution.
#

APP_HOME="$( cd "${0%/*}" && pwd )"

# If no local gradle, use system gradle
if command -v gradle > /dev/null 2>&1; then
    exec gradle "$@"
else
    echo "ERROR: gradle not found on PATH. Install it or use the full wrapper." >&2
    exit 1
fi

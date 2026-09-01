#!/bin/sh
# Waits for the Blender render to finish, then encodes frames to MP4.
cd "$(dirname "$0")"
while pgrep -f 'blender -b.*animate_rover_run' > /dev/null; do sleep 10; done
ffmpeg -y -framerate 24 -i anim_frames/frame_%04d.png \
  -c:v libx264 -pix_fmt yuv420p -crf 20 rover_weeding_anim.mp4
echo "MP4_DONE: $(pwd)/rover_weeding_anim.mp4"

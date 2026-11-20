# Video Kit — laser-weeding rover

Everything needed to produce a video about this project, arranged in edit
order. This kit lives OUTSIDE the git repo (heavy media, disk-space reasons);
the paper, code and benchmarks remain in the repo: `weed-laser-robot/` at the
same folder level as this kit.

- `storyboard.md` — scene-by-scene script (~5 min): timing, on-screen text,
  and narration in **both English and Bengali**.
- `assets/` — numbered shots. Read the numbers as your timeline order:
  `10_` field photo, `15_` architecture diagram, `20_` photo->BEV->rows,
  `30_` real mission plan, `40_` tilt benchmark result, `45_` tap-noise
  benchmark, `50_` 60-degree synthetic example, `60_` results card
  (1920x1080 dark card with the measured numbers), `70_` KiCad schematic,
  `80_` 3-DOF arm render, `85_...99_` Blender simulation stills.
- `clips/sim_mission.mp4` — rendered 3-D mission replay (44 s). Use it in
  Scene 7 (preferred over the stills). `sim_mission_preview.gif` is a quick
  preview of the same replay. When you film the built rover, drop that here
  as `clips/rover_real.mp4` — the storyboard already reserves a slot.
- `paper.pdf` — the 6-page IEEE paper this video is based on.

## Regenerating assets (requires the repo checkout)

- Architecture diagram and results card were rendered from committed
  sources (see the repo's "video kit" commit for the render commands).
- Figures come from `weed-laser-robot/docs/paper/figures/` (regenerate with
  `Navigation/benchmarks/make_figures.py` after re-running benchmarks).

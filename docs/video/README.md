# Video Kit — laser-weeding rover

Everything needed to produce a video about this project, arranged in edit order.

- `storyboard.md` — scene-by-scene script (~5 min): timing, on-screen text,
  and narration in **both English and Bengali**.
- `assets/` — numbered shots. Read the numbers as your timeline order:
  `10_` field photo, `15_` architecture diagram, `20_` photo->BEV->rows,
  `30_` real mission plan, `40_` tilt benchmark result, `45_` tap-noise
  benchmark, `50_` 60-degree synthetic example, `60_` results card
  (1920x1080 dark card with the measured numbers), `70_` KiCad schematic,
  `80_` 3-DOF arm render, `85_...99_` Blender simulation stills.
- `clips/` — drop moving footage here (see below).
- `paper.pdf` — the 6-page IEEE paper this video is based on.

## Getting the missing moving footage

The Blender-rendered 3-D mission video is not stored in git (large file).
When the project drive is mounted, copy it in:

    cp /run/media/bayazid/5f064a08-e294-4745-9a41-3920c208ef17/home/sword/Documents/projects/weed-laser-robot/Navigation/sim/outbox/big_field_20261021.mp4 docs/video/clips/sim_mission.mp4

(Scene 7 then uses the clip; the numbered sim stills are the fallback.)

## Regenerating assets

- Architecture diagram and results card were rendered from the committed
  sources; re-render steps are in git history (commit "video kit").
- Figures come from `docs/paper/figures/` (regenerate with
  `Navigation/benchmarks/make_figures.py` after re-running benchmarks).

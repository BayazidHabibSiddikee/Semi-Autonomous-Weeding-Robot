# IEEE Literature Collection — Autonomous River ASV

**Project scope:** An Autonomous Surface Vehicle (ASV) for predefined river-route navigation, static/dynamic obstacle detection and avoidance, and operation under visibility, fatigue, and cost constraints relevant to Bangladesh waterways.

**Prepared:** 2026-08-09

## Important access note

The records below are IEEE papers or IEEE conference/journal records. PDFs are included only when an openly accessible author/preprint copy was found. IEEE Xplore links are included for all records; some may require institutional/personal access. No paywall was bypassed.

## Recommended core papers

### 1. River navigation system using Autonomous Surface Vessel
- **Authors:** Chee Sheng Tan, Mohd Rizal Arshad, Rosmiwati Mohd-Mokhtar
- **Venue/year:** 2016 IEEE International Conference on Underwater System Technology: Theory and Applications (USYS)
- **DOI:** [10.1109/USYS.2016.7893946](https://doi.org/10.1109/USYS.2016.7893946)
- **IEEE record:** https://ieeexplore.ieee.org/document/7893946
- **Why it matters:** Directly addresses riverine ASV navigation using camera-based waterline/river tracking, GPS, data logging, and optical-flow obstacle detection/avoidance.
- **PDF status:** IEEE Xplore record only; public full text was not located during this pass.

### 2. Efficient LiDAR-based In-water Obstacle Detection and Segmentation by Autonomous Surface Vehicles in Aquatic Environments
- **Authors:** Mingi Jeong, Alberto Quattrini Li
- **Venue/year:** 2021 IEEE/RSJ International Conference on Intelligent Robots and Systems (IROS)
- **DOI:** [10.1109/IROS51168.2021.9636028](https://doi.org/10.1109/IROS51168.2021.9636028)
- **IEEE record:** https://ieeexplore.ieee.org/document/9636028
- **Why it matters:** LiDAR segmentation of in-water objects and shorelines; directly useful for static/dynamic obstacle perception in a river.
- **PDF status:** Author-hosted ResearchGate PDF was found but the source was slow/unreliable in this run. Search result/source link: https://www.researchgate.net/profile/Mingi-Jeong-3/publication/357115740_Efficient_LiDAR-based_In-water_Obstacle_Detection_and_Segmentation_by_Autonomous_Surface_Vehicles_in_Aquatic_Environments/links/6371d3a654eb5f547ccec7e3/Efficient-LiDAR-based-In-water-Obstacle-Detection-and-Segmentation-by-Autonomous-Surface-Vehicles-in-Aquatic-Environments.pdf

### 3. Development of a Perception System for an Autonomous Surface Vehicle using Monocular Camera, LIDAR, and Marine RADAR
- **Authors:** Thomas Clunie, Michael J. DeFilippo, Michael Sacarny, Paul Robinette
- **Venue/year:** 2021 IEEE International Conference on Robotics and Automation (ICRA)
- **DOI:** [10.1109/ICRA48506.2021.9561275](https://doi.org/10.1109/ICRA48506.2021.9561275)
- **IEEE record:** https://ieeexplore.ieee.org/document/9561275
- **Why it matters:** Multi-sensor detection, tracking, state estimation, and fusion; strong reference for poor visibility and false-positive reduction.
- **PDF status:** IEEE/ACM record only; public full text was not located during this pass.

### 4. An Obstacle Avoidance Algorithm for Unmanned Surface Vehicle Based on A Star and Velocity-Obstacle Algorithms
- **Venue/year:** IEEE conference paper, 2021 record
- **IEEE record:** https://ieeexplore.ieee.org/document/9734642
- **Why it matters:** Combines global A* planning with velocity-obstacle reasoning, making it relevant to predefined routes plus dynamic-vessel avoidance.
- **PDF status:** IEEE Xplore record only; public full text was not located during this pass.

### 5. Multiple Obstacles Avoidance Path Planning for Unmanned Surface Vehicles
- **Venue/year:** IEEE conference paper, 2024 record
- **IEEE record:** https://ieeexplore.ieee.org/document/10668174
- **Why it matters:** Explicitly addresses waypoint navigation, multiple obstacles, VLP-16 LiDAR, cameras, real-time detection, and environmental mapping.
- **PDF status:** IEEE Xplore record only; public full text was not located during this pass.

### 6. A Water-Obstacle Separation and Refinement Network for Unmanned Surface Vehicles
- **Authors:** Boštjan Bovcon, Matej Kristan
- **Venue/year:** 2020 IEEE International Conference on Robotics and Automation (ICRA)
- **DOI:** [10.1109/ICRA40945.2020.9197194](https://doi.org/10.1109/ICRA40945.2020.9197194)
- **IEEE record:** https://ieeexplore.ieee.org/document/9197194
- **Why it matters:** Vision-based water/obstacle segmentation; IMU information is fused with visual features to improve water-edge and obstacle detection.
- **PDF:** `WaSR_2020.pdf`
- **Public source:** https://prints.vicos.si/publications/files/392

### 7. WaSR—A Water Segmentation and Refinement Maritime Obstacle Detection Network
- **Authors:** Boštjan Bovcon, Matej Kristan
- **Venue/year:** IEEE Transactions on Cybernetics, 2022
- **DOI:** [10.1109/TCYB.2021.3085856](https://doi.org/10.1109/TCYB.2021.3085856)
- **IEEE record:** https://ieeexplore.ieee.org/document/9477208
- **Why it matters:** Journal extension of the WaSR approach; useful for a literature review on water segmentation, obstacle detection, and robust visual perception.
- **PDF status:** IEEE Xplore record only in this run; do not confuse it with the openly hosted ICRA paper above.

### 8. Temporal Context for Robust Maritime Obstacle Detection
- **Authors:** Lojze Žust, Matej Kristan
- **Venue/year:** 2022 IEEE/RSJ International Conference on Intelligent Robots and Systems (IROS)
- **DOI:** [10.1109/IROS47612.2022.9982043](https://doi.org/10.1109/IROS47612.2022.9982043)
- **IEEE record:** https://ieeexplore.ieee.org/document/9982043
- **Open preprint:** https://arxiv.org/abs/2203.05352
- **Why it matters:** Uses temporal context to suppress reflections and sun-glitter false positives; particularly relevant to glare, ripples, and changing illumination on Bangladeshi rivers.
- **PDF:** `Temporal_Context_WaSR-T_2022.pdf`

### 9. COLREG-RRT: An RRT-Based COLREGS-Compliant Motion Planner for Surface Vehicle Navigation
- **Authors:** H.-T. L. Chiang, N. Rackley, L. Tapia
- **Venue/year:** IEEE Robotics and Automation Letters, 2018
- **DOI:** [10.1109/LRA.2018.2807045](https://doi.org/10.1109/LRA.2018.2807045)
- **IEEE record:** https://ieeexplore.ieee.org/document/8281087
- **Why it matters:** Dynamic-obstacle motion planning with COLREGS-aware behavior; useful when the ASV encounters passenger boats, cargo boats, or fishing vessels.
- **PDF:** `COLREG-RRT_2018.pdf`
- **Open author copy:** https://www.cs.unm.edu/tapialab/Publications/55.pdf

## Suggested literature-review structure

1. **River perception and route following:** Tan et al. (2016), river-boundary detection, camera/GPS fusion.
2. **Obstacle perception:** Jeong & Quattrini Li (2021), WaSR, WaSR-T, Clunie et al. (2021).
3. **Global and local planning:** A*, RRT/RRT*, velocity obstacles, COLREGS-aware planning.
4. **Control and execution:** waypoint tracking, LOS guidance, PID/NMPC, actuator/thruster configuration.
5. **Bangladesh deployment gap:** glare, monsoon rain, fog/haze, muddy water, narrow/shifting channels, dense mixed traffic, weak connectivity, GNSS multipath near bridges, and low-cost edge hardware.

## Citation shortlist in IEEE style

[1] C. S. Tan, M. R. Arshad, and R. M. Mohd-Mokhtar, “River navigation system using Autonomous Surface Vessel,” in *2016 IEEE International Conference on Underwater System Technology: Theory and Applications (USYS)*, 2016, doi: 10.1109/USYS.2016.7893946.

[2] M. Jeong and A. Quattrini Li, “Efficient LiDAR-based In-water Obstacle Detection and Segmentation by Autonomous Surface Vehicles in Aquatic Environments,” in *2021 IEEE/RSJ International Conference on Intelligent Robots and Systems (IROS)*, 2021, pp. 5387–5394, doi: 10.1109/IROS51168.2021.9636028.

[3] T. Clunie, M. J. DeFilippo, M. Sacarny, and P. Robinette, “Development of a Perception System for an Autonomous Surface Vehicle using Monocular Camera, LIDAR, and Marine RADAR,” in *2021 IEEE International Conference on Robotics and Automation (ICRA)*, 2021, doi: 10.1109/ICRA48506.2021.9561275.

[4] B. Bovcon and M. Kristan, “A water-obstacle separation and refinement network for unmanned surface vehicles,” in *2020 IEEE International Conference on Robotics and Automation (ICRA)*, 2020, pp. 9470–9476, doi: 10.1109/ICRA40945.2020.9197194.

[5] B. Bovcon and M. Kristan, “WaSR—A Water Segmentation and Refinement Maritime Obstacle Detection Network,” *IEEE Transactions on Cybernetics*, vol. 52, no. 12, pp. 12661–12674, 2022, doi: 10.1109/TCYB.2021.3085856.

[6] L. Žust and M. Kristan, “Temporal Context for Robust Maritime Obstacle Detection,” in *2022 IEEE/RSJ International Conference on Intelligent Robots and Systems (IROS)*, 2022, pp. 6340–6346, doi: 10.1109/IROS47612.2022.9982043.

[7] H.-T. L. Chiang, N. Rackley, and L. Tapia, “COLREG-RRT: An RRT-Based COLREGS-Compliant Motion Planner for Surface Vehicle Navigation,” *IEEE Robotics and Automation Letters*, vol. 3, no. 3, pp. 2024–2031, 2018, doi: 10.1109/LRA.2018.2807045.

## Search provenance

Searches used IEEE Xplore records and public author/preprint pages. Local utilities inspected: `/home/sword/Documents/tools/pdf_downloader.py` and `/home/sword/Documents/tools/knowledge_hub.py`. The downloader's DDG fallback was unavailable because its optional `ddgs` module/Camoufox service was not active, so IEEE records were verified through web search and PDFs were downloaded from openly accessible sources where available.

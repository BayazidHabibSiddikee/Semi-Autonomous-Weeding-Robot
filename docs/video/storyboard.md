# Video Storyboard — "Laser-Weeding Rover"
Target: ~5 minutes, 16:9 (1920x1080) for YouTube. All assets live in `docs/video/assets/`,
numbered in playback order so a simple "slide-in from number order" edit works.

> Optional clip: when the external drive is mounted, add
> `Navigation/sim/outbox/big_field_20261021.mp4` (rendered 3-D mission video)
> to `docs/video/clips/` and use it in Scene 7 — moving footage beats stills.
> If you build/reveal a real rover photo, drop it in as `assets/05_rover_real.jpg`
> and use it in Scenes 1, 2 and 9.

---

## Scene 1 — Hook  (0:00–0:12)
- **Asset:** `95_sim_zap.png` (better: sim video clip zooming on the zap moment)
- **On-screen text:** none (let the visual speak)
- **EN narration:** Everything green in this field is food. What you see flashing is the
  thing killing what isn't — a laser, aimed by a robot I built.
- **বাংলা ন্যারেশন:** মাঠে সবুজ সবখানে ফসলই দরকার। কিন্তু আগাছাও সবুজ!
  এই ঝলকটা দেখুন — আমার বানানো রোবট ওষুধ ছাড়াই লেজার দিয়ে আগাছা মারছে।

## Scene 2 — The problem  (0:12–0:45)
- **Asset:** `10_real_field_photo.jpg` (slow push-in crop)
- **On-screen text:** "Manual weeding: long hours" / "Herbicides: residues, resistance"
- **EN narration:** Farmers spend countless hours pulling weeds, or fall back on
  herbicides that leave residues and breed resistance. Real laser weeding machines
  exist — but they cost as much as a house. So I asked: what is the cheapest machine
  that could honestly do this?
- **বাংলা:** কৃষককে ঘণ্টার পর ঘণ্টা হাতে আগাছা টানতে হয়, অথবা
  ওষুধ মারতে হয় — ক্ষতিকর অবশিষ্ট্য ও রেজিসট্যান্স সহ।
  প্রকৃত লেজার-উইডিং যন্ত্র আছে, কিন্তু দাম আকাশসীমা।
  তাই আমি ভাবলাম — সবচেয়ে সস্তায় কেমন মেশিনে এটা সত্যিই সম্ভব?

## Scene 3 — The idea  (0:45–1:20)
- **Asset:** `15_architecture.png` (animate each block left-to-right)
- **On-screen text:** "One photo. Four taps. The rover does the rest."
- **EN narration:** The entire intelligence input is one smartphone photo. Tap the four
  corners of your field block in the app, and the rover's onboard computer warps the
  photo into a measured top-down map, finds the crop rows, and plans the mission.
- **বাংলা:** পুরো বুদ্ধিটা একটা ফোনের ছবিতে। অ্যাপে মাঠের চার কোণা নাড়িয়ে
  ট্যাপ করুন — রোবটের কম্পিউটার নিজে ছবিটা নরমাল হিসেবে নিয়ে রো সনাক্ত করে
  এবং গোটা অভিযানের প্ল্যান বানায়।

## Scene 4 — See the field  (1:20–2:05)
- **Asset:** `20_pipeline_bev_rows.png`, then `30_mission_plan_real.png`
- **On-screen text:** "(a) photo -> (b) top-down map -> (c) rows found"
- **EN narration:** Here is that exact pipeline on a real field. The skewed photo becomes
  a metric bird's-eye view, the vegetation is segmented, and every crop row is found —
  nine lanes, correct, in this real upload. The rows immediately give a mowing-pattern
  mission the robot can drive.
- **বাংলা:** বাস্তব মাঠে দেখুন — হেলানো ছবি সোজা ম্যাপে পরিণত হয়, গাছ আলাদা হয়,
  প্রতিটি সারি ধরা পড়ে। সারি পেলেই ঘুড়ির মতো আদরের প্যাটার্নে চলার প্ল্যান তৈরি।

## Scene 5 — The hard part  (2:05–2:50)
- **Assets:** `50_example_60deg.png`, then `40_tilt_result.png` (zoom the 50–60 deg dip)
- **On-screen text:** "what if the photo is taken at an angle?"
- **EN narration:** Nobody photographs a field dead-straight from the sky. At high angles
  the far edge of the photo uses ground resolution quickly, and a naive detector starts
  merging rows. My fix is a regularizer: the planter already knows the number of rows
  and (roughly) the pitch — one known fact and messy rows snap clean. With it,
  detection is 100% correct from 0 to 60 degrees.
- **বাংলা:** কেউ মাঠের ছবি ওপর থেকে একেবারে সোজা নেয় না।
  বেশি হেলানো ছবিতে দূরের প্রান্ত অস্পষ্ট হয়ে আগাছা-সারি মিশে যাওয়ার সমস্যা হয়।
  সমাধান: চাষি যতটা সারি লাগিয়েছেন, সেটা জানা থাকে — সেটাকে টেনে
  বাম/ডান সারিগুলো ঠিক অবস্থানে বসে যায়। ফলাফল: ৬০ ডিগ্রি হেলানোতেও ১০০% সঠিক।

## Scene 6 — The measured numbers  (2:50–3:20)
- **Asset:** `60_results_card.png` (reveal row by row)
- **EN narration:** These aren't claims, they're benchmark outputs: 200 runs,
  eight random seeds per condition. One hundred percent exact rows.
  Under eight centimetres error. The whole pipeline in 19.5 milliseconds per field block.
- **বাংলা:** এগুলো দাবি নয় — নম্বর এসেছে পরীক্ষায়: ~২০০ রান।
  ৬০ ডিগ্রি হেলানোতেও ১০০% সঠিক সারি, ৮ সেন্টিমিটারের নিচে ভুল,
  আর পুরো পাইপলাইন ১৯.৫ মিলিসেকেন্ডে।

## Scene 7 — Proving it in 3-D  (3:20–4:05)
- **Assets:** sim clip (or `85_sim_start.png` -> `90_sim_mid.png` -> `95_sim_zap.png` -> `99_sim_end.png`)
- **On-screen text:** "same mission file, same state machine as the hardware"
- **EN narration:** Before any hardware burned anything, every mission was replayed in a
  3-D twin. The simulation reads the same mission file and runs the same state machine
  the rover runs — so what you see rehearsed here is literally the program.
- **বাংলা:** হার্ডওয়্যারে প্রথম ঝলকের আগেই প্রতিটা মিশন থ্রিডি সিমুলেশনে চলে।
  সিমুলেশনে সেই একই মিশন-ফাইল, ঐ একই স্টেট-মেশিন — মানে এখানে যা দেখছেন,
  আসলে রোবটের কাছে সেটাই প্রোগ্রাম।

## Scene 8 — The machine  (4:05–4:35)
- **Assets:** `80_arm_render.png`, then `70_electronics_schematic.png` (quick pan)
- **On-screen text:** "3-DOF arm + laser gimbal" / "37 nets, ERC-verified"
- **EN narration:** Three servos give the arm yaw, shoulder and elbow; the laser head
  hangs at the tip. Every net of the electrical design is drawn, exported and
  checkable — the design is verified, not just drawn.
- **বাংলা:** তিনটা সার্ভো দিয়ে হাতের ঘূর্ণন, কাঁধ ও কনুই — ডগায় লেজার।
  ইলেকট্রনিক ডিজাইনটা কেবল আঁকা নয় — নেটলিস্ট আর ERC দিয়ে যাচাই করা।

## Scene 9 — Outro  (4:35–5:00)
- **Asset:** real rover photo (placeholder) or repeat `20_pipeline_bev_rows.png`
- **On-screen text:** "Full paper + code + benchmarks: github.com/BayazidHabibSiddikee/Semi-Autonomous-Weeding-Robot"
- **EN narration:** Design, paper, benchmarks, and the full electrical schematic are open
  on GitHub. Next episode: the rover meets soil. Subscribe if you want to see it weeding.
- **বাংলা:** পুরো পেপার, কোড, বেঞ্চমার্ক আর সার্কিট-ডিজাইন GitHub-এ খোলা আছে।
  পরের পর্বে — রোবট মাঠে নামবে। ভিডিওটা ভালো লাগলে চ্যানেলটা সাবস্ক্রাইব করে রাখুন।

---

## Edit tips (CapCut / DaVinci / Premiere)
1. Timeline order == asset file-number order; everything is already named in sequence.
2. `20_pipeline_bev_rows.png` and `50_example_60deg.png` are panel triptychs —
   use a slow left-to-right pan (Ken Burns) so viewers see one panel at a time.
3. Keep speakers' lips out of sync? This is voice-over narration; speak ~2.2 words/sec,
   scene text stays on screen the whole scene.
4. Music: low-tech synth pulse under Scenes 2–5, drop it for the numbers scene,
   bring a fuller pad for Scene 7 (sim) and the outro.
5. Safety: never show a real laser against people/camera; use the sim zap clip for danger shots.

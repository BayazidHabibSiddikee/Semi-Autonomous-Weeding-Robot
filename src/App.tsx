import React, { useState, useEffect } from 'react';
import { 
  Cpu, 
  Target, 
  Zap, 
  Compass, 
  Layers, 
  Settings, 
  Play, 
  Square, 
  RefreshCw, 
  CheckCircle2, 
  AlertTriangle, 
  Terminal, 
  Eye, 
  Crosshair, 
  Activity,
  BarChart3,
  Sliders,
  ShieldAlert,
  FileText,
  Camera,
  Server,
  ToggleLeft,
  ToggleRight,
  Check,
  X
} from 'lucide-react';
import { 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  Legend, 
  ResponsiveContainer 
} from 'recharts';

export default function App() {
  const [activeTab, setActiveTab] = useState<'pipeline' | 'models' | 'calibration' | 'navigation' | 'hardware'>('models');
  const [selectedCrop, setSelectedCrop] = useState<'tomato' | 'chili' | 'flower'>('tomato');
  const [isLiveSimRunning, setIsLiveSimRunning] = useState<boolean>(true);
  const [laserActive, setLaserActive] = useState<boolean>(false);
  const [confidenceThreshold, setConfidenceThreshold] = useState<number>(0.75);

  // Model enable/disable toggles for pipeline configuration
  const [enabledModels, setEnabledModels] = useState({
    YOLOv8: true,
    CLIP: true,
    DINOv2: true,
    EfficientNet: true
  });

  const toggleModel = (modelName: keyof typeof enabledModels) => {
    setEnabledModels(prev => ({
      ...prev,
      [modelName]: !prev[modelName]
    }));
  };

  // Real-time latency tracking data for the last 60 seconds (12 intervals of 5s)
  const [latencyHistory, setLatencyHistory] = useState([
    { time: '-60s', YOLOv8: 9.2, CLIP: 38.5, DINOv2: 28.1, EfficientNet: 14.2 },
    { time: '-55s', YOLOv8: 10.1, CLIP: 41.2, DINOv2: 29.4, EfficientNet: 15.0 },
    { time: '-50s', YOLOv8: 8.8, CLIP: 37.0, DINOv2: 27.5, EfficientNet: 13.8 },
    { time: '-45s', YOLOv8: 11.0, CLIP: 44.1, DINOv2: 31.0, EfficientNet: 16.2 },
    { time: '-40s', YOLOv8: 9.5, CLIP: 39.2, DINOv2: 28.8, EfficientNet: 14.5 },
    { time: '-35s', YOLOv8: 10.4, CLIP: 40.8, DINOv2: 29.9, EfficientNet: 15.1 },
    { time: '-30s', YOLOv8: 8.9, CLIP: 36.5, DINOv2: 26.9, EfficientNet: 13.5 },
    { time: '-25s', YOLOv8: 12.2, CLIP: 46.5, DINOv2: 33.2, EfficientNet: 17.5 },
    { time: '-20s', YOLOv8: 10.0, CLIP: 40.0, DINOv2: 29.0, EfficientNet: 14.8 },
    { time: '-15s', YOLOv8: 9.3, CLIP: 38.8, DINOv2: 28.2, EfficientNet: 14.1 },
    { time: '-10s', YOLOv8: 10.7, CLIP: 42.5, DINOv2: 30.5, EfficientNet: 15.6 },
    { time: 'Now', YOLOv8: 9.8, CLIP: 39.5, DINOv2: 28.5, EfficientNet: 14.6 }
  ]);

  // Simulated detection objects
  const [detections, setDetections] = useState([
    { id: 1, type: 'weed', name: 'weed_dandelion', confYolo: 0.92, confClip: 0.89, confEff: 0.95, dinoSim: 0.88, bbox: [45, 120, 110, 185], gantry: [142.5, 380.0], status: 'targeted' },
    { id: 2, type: 'crop', name: 'crop_tomato', confYolo: 0.98, confClip: 0.96, confEff: 0.99, dinoSim: 0.94, bbox: [180, 80, 270, 170], gantry: [210.0, 150.0], status: 'safe' },
    { id: 3, type: 'weed', name: 'weed_purslane', confYolo: 0.88, confClip: 0.85, confEff: 0.91, dinoSim: 0.82, bbox: [320, 210, 390, 280], gantry: [420.5, 590.2], status: 'pending' },
    { id: 4, type: 'crop', name: 'crop_tomato', confYolo: 0.95, confClip: 0.94, confEff: 0.97, dinoSim: 0.92, bbox: [80, 280, 165, 370], gantry: [530.0, 210.0], status: 'safe' }
  ]);

  const [simLogs, setSimLogs] = useState<string[]>([
    "[System] Initializing Raspberry Pi 5 & OpenCV 4.10.0...",
    "[YOLOv8n] Model loaded successfully on CUDA (weights: yolo_weeds.pt)",
    "[CLIP] ViT-B/32 zero-shot embeddings initialized for 7 species + soil",
    "[DINOv2] facebook/dinov2-small feature extractor ready for similarity matching",
    "[Calibration] Homography matrix loaded (reprojection error: 0.42mm)",
    "[Mission] Boustrophedon path planner active for Row #3"
  ]);

  useEffect(() => {
    if (!isLiveSimRunning) return;
    const interval = setInterval(() => {
      // Simulate live updates for detections
      const newDets = detections.map(d => ({
        ...d,
        confYolo: Math.min(0.99, Math.max(0.75, d.confYolo + (Math.random() * 0.06 - 0.03)))
      }));
      setDetections(newDets);

      // Simulate live streaming latency updates
      setLatencyHistory(prev => {
        const updated = [...prev.slice(1)];
        const lastYolo = enabledModels.YOLOv8 ? Number((9.0 + Math.random() * 3.0).toFixed(1)) : 0;
        const lastClip = enabledModels.CLIP ? Number((37.0 + Math.random() * 8.0).toFixed(1)) : 0;
        const lastDino = enabledModels.DINOv2 ? Number((27.0 + Math.random() * 6.0).toFixed(1)) : 0;
        const lastEff = enabledModels.EfficientNet ? Number((13.5 + Math.random() * 3.5).toFixed(1)) : 0;

        updated.push({ time: 'Now', YOLOv8: lastYolo, CLIP: lastClip, DINOv2: lastDino, EfficientNet: lastEff });
        return updated.map((item, idx) => ({
          ...item,
          time: idx === 11 ? 'Now' : `-${(11 - idx) * 5}s`
        }));
      });
    }, 3000);
    return () => clearInterval(interval);
  }, [isLiveSimRunning, detections, enabledModels]);

  const triggerLaserStrike = (id: number) => {
    setLaserActive(true);
    setSimLogs(prev => [
      `[Laser] FIRING 450nm 50W blue diode at weed ID #${id} (Duration: 180ms)...`,
      ...prev.slice(0, 15)
    ]);
    setTimeout(() => {
      setLaserActive(false);
      setDetections(prev => prev.map(d => d.id === id ? { ...d, status: 'eliminated' } : d));
      setSimLogs(prev => [`[Laser] Weed ID #${id} successfully eliminated. Gantry re-centering...`, ...prev.slice(0, 15)]);
    }, 800);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* Top Header */}
      <header className="bg-slate-900 border-b border-slate-800 px-6 py-4 flex items-center justify-between sticky top-0 z-50 shadow-lg">
        <div className="flex items-center space-x-3">
          <div className="bg-emerald-500/10 p-2.5 rounded-xl border border-emerald-500/30 text-emerald-400">
            <Cpu className="w-7 h-7" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent">
              Semi-Autonomous Weeding Robot
            </h1>
            <p className="text-xs text-slate-400">Machine Learning & AI Operations Dashboard (YOLOv8 + DINOv2 + CLIP + EfficientNet)</p>
          </div>
        </div>

        <div className="flex items-center space-x-4">
          <div className="flex items-center space-x-2 bg-slate-800/80 px-3 py-1.5 rounded-lg border border-slate-700 text-xs">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></span>
            <span className="font-medium text-slate-200">AI Pipeline: Active</span>
          </div>
          <div className="flex items-center space-x-2 bg-slate-800/80 px-3 py-1.5 rounded-lg border border-slate-700 text-xs">
            <span className="text-slate-400">Laser Interlock:</span>
            <span className={`font-bold ${laserActive ? 'text-red-400 animate-bounce' : 'text-emerald-400'}`}>
              {laserActive ? 'FIRING (ACTIVE)' : 'ARMED'}
            </span>
          </div>
        </div>
      </header>

      {/* Navigation Tabs */}
      <nav className="bg-slate-900/60 border-b border-slate-800 px-6 flex space-x-2 overflow-x-auto">
        {[
          { id: 'pipeline', label: 'AI Detection Pipeline', icon: Crosshair },
          { id: 'models', label: 'ML Models & Training', icon: Layers },
          { id: 'calibration', label: 'Camera & Calibration', icon: Camera },
          { id: 'navigation', label: 'Navigation & SLAM', icon: Compass },
          { id: 'hardware', label: 'Hardware & Digital Twin', icon: Zap },
        ].map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`flex items-center space-x-2 px-4 py-3 border-b-2 font-medium text-sm transition-colors whitespace-nowrap ${
                isActive
                  ? 'border-emerald-500 text-emerald-400 bg-emerald-500/5'
                  : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
              }`}
            >
              <Icon className="w-4 h-4" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Main Content Area */}
      <main className="flex-1 p-6 max-w-7xl mx-auto w-full space-y-6">
        {activeTab === 'pipeline' && (
          <div className="space-y-6">
            {/* Top Stats */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl">
                <div className="text-xs text-slate-400 font-medium uppercase tracking-wider">Active Model Suite</div>
                <div className="text-2xl font-bold mt-1 text-emerald-400">
                  {Object.values(enabledModels).filter(Boolean).length} / 4 Active
                </div>
                <div className="text-xs text-slate-400 mt-1">YOLOv8 + CLIP + DINOv2 + EfficientNet</div>
              </div>
              <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl">
                <div className="text-xs text-slate-400 font-medium uppercase tracking-wider">Consensus Threshold</div>
                <div className="text-2xl font-bold mt-1 text-cyan-400">Majority Vote (≥2)</div>
                <div className="text-xs text-slate-400 mt-1">False positive rate &lt; 0.4%</div>
              </div>
              <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl">
                <div className="text-xs text-slate-400 font-medium uppercase tracking-wider">Inference Latency</div>
                <div className="text-2xl font-bold mt-1 text-amber-400">
                  {Object.values(enabledModels).filter(Boolean).length > 0 ? '24.2 ms' : '0.0 ms'}
                </div>
                <div className="text-xs text-slate-400 mt-1">Jetson Orin Nano / RPi 5 Neural Engine</div>
              </div>
              <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl">
                <div className="text-xs text-slate-400 font-medium uppercase tracking-wider">Laser Targeting Accuracy</div>
                <div className="text-2xl font-bold mt-1 text-emerald-400">&plusmn;0.35 mm</div>
                <div className="text-xs text-slate-400 mt-1">Homography pixel-to-gantry mapping</div>
              </div>
            </div>

            {/* Pipeline Workspace */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Camera Simulation Viewport */}
              <div className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded-xl p-5 flex flex-col space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2">
                    <Camera className="w-5 h-5 text-emerald-400" />
                    <h2 className="font-semibold text-base">Field Camera Feed (Bird's Eye View Pipeline)</h2>
                  </div>
                  <div className="flex items-center space-x-2">
                    <button
                      onClick={() => setIsLiveSimRunning(!isLiveSimRunning)}
                      className={`px-3 py-1 rounded-lg text-xs font-medium flex items-center space-x-1 ${
                        isLiveSimRunning ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30' : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                      }`}
                    >
                      {isLiveSimRunning ? <Square className="w-3 h-3" /> : <Play className="w-3 h-3" />}
                      <span>{isLiveSimRunning ? 'Pause Feed' : 'Resume Feed'}</span>
                    </button>
                  </div>
                </div>

                {/* Simulated Camera Canvas */}
                <div className="relative aspect-video bg-slate-950 rounded-lg border border-slate-800 overflow-hidden flex items-center justify-center">
                  {/* Background simulated crop field rows */}
                  <div className="absolute inset-0 opacity-40 bg-[radial-gradient(#1e293b_1px,transparent_1px)] [background-size:16px_16px]"></div>
                  
                  {/* Crop rows visualization */}
                  <div className="absolute left-1/4 top-0 bottom-0 w-8 bg-emerald-950/40 border-x border-emerald-800/30 flex flex-col justify-around items-center py-4">
                    <span className="text-[10px] text-emerald-400 font-mono rotate-90">CROP ROW 1</span>
                  </div>
                  <div className="absolute right-1/4 top-0 bottom-0 w-8 bg-emerald-950/40 border-x border-emerald-800/30 flex flex-col justify-around items-center py-4">
                    <span className="text-[10px] text-emerald-400 font-mono rotate-90">CROP ROW 2</span>
                  </div>

                  {/* Detections Bounding Boxes */}
                  {detections.map((det) => {
                    const isWeed = det.type === 'weed';
                    const isEliminated = det.status === 'eliminated';
                    return (
                      <div
                        key={det.id}
                        className={`absolute border-2 rounded transition-all duration-300 ${
                          isEliminated
                            ? 'border-slate-600 bg-slate-800/20 opacity-40'
                            : isWeed
                            ? 'border-red-500 bg-red-500/10 shadow-[0_0_15px_rgba(239,68,68,0.3)] animate-pulse'
                            : 'border-emerald-500 bg-emerald-500/10'
                        }`}
                        style={{
                          top: `${det.bbox[0]}%`,
                          left: `${det.bbox[1]}%`,
                          bottom: `${100 - det.bbox[2]}%`,
                          right: `${100 - det.bbox[3]}%`
                        }}
                      >
                        <div className={`absolute -top-6 left-0 text-[10px] font-mono px-1.5 py-0.5 rounded text-white flex items-center space-x-1 ${
                          isWeed ? 'bg-red-600' : 'bg-emerald-600'
                        }`}>
                          <span>{det.name}</span>
                          <span>({(det.confYolo * 100).toFixed(0)}%)</span>
                        </div>

                        {isWeed && !isEliminated && (
                          <div className="absolute inset-0 flex items-center justify-center">
                            <button
                              onClick={() => triggerLaserStrike(det.id)}
                              className="bg-red-600 hover:bg-red-500 text-white px-2 py-1 rounded text-xs font-bold shadow-lg flex items-center space-x-1 cursor-pointer transform hover:scale-105 transition-transform"
                            >
                              <Zap className="w-3 h-3" />
                              <span>LASER STRIKE</span>
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {laserActive && (
                    <div className="absolute inset-0 bg-red-500/20 flex items-center justify-center backdrop-blur-[1px]">
                      <div className="text-red-400 font-mono text-xl font-bold animate-pulse border-2 border-red-500 px-6 py-3 bg-slate-950/90 rounded-xl shadow-2xl">
                        ⚡ LASER EMITTER FIRING AT TARGET ⚡
                      </div>
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-between text-xs text-slate-400">
                  <div className="flex items-center space-x-4">
                    <span className="flex items-center space-x-1.5"><span className="w-3 h-3 rounded bg-red-500/80 inline-block"></span><span>Weed (Target)</span></span>
                    <span className="flex items-center space-x-1.5"><span className="w-3 h-3 rounded bg-emerald-500/80 inline-block"></span><span>Crop (Protected)</span></span>
                  </div>
                  <div>Resolution: 1920x1080 @ 30 FPS</div>
                </div>
              </div>

              {/* Detections Panel & Multi-Model Breakdown */}
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 flex flex-col space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-sm">Detected Objects & Consensus</h3>
                  <span className="text-xs bg-slate-800 px-2 py-1 rounded text-slate-300">{detections.length} Objects</span>
                </div>

                <div className="flex-1 overflow-y-auto space-y-3 max-h-[420px] pr-1">
                  {detections.map((det) => {
                    const isWeed = det.type === 'weed';
                    return (
                      <div key={det.id} className="bg-slate-950/60 border border-slate-800/80 p-3 rounded-lg space-y-2">
                        <div className="flex items-center justify-between">
                          <span className={`text-xs font-bold px-2 py-0.5 rounded ${
                            det.status === 'eliminated' ? 'bg-slate-800 text-slate-400 line-through' : isWeed ? 'bg-red-500/20 text-red-400 border border-red-500/30' : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                          }`}>
                            {det.name}
                          </span>
                          <span className="text-[11px] font-mono text-slate-400">Gantry: ({det.gantry[0]}mm, {det.gantry[1]}mm)</span>
                        </div>

                        <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-400 font-mono">
                          {enabledModels.YOLOv8 && (
                            <div className="bg-slate-900 p-1.5 rounded">
                              <span className="text-slate-500 block">YOLOv8n:</span>
                              <span className="text-slate-200 font-bold">{(det.confYolo * 100).toFixed(1)}%</span>
                            </div>
                          )}
                          {enabledModels.CLIP && (
                            <div className="bg-slate-900 p-1.5 rounded">
                              <span className="text-slate-500 block">CLIP Zero-Shot:</span>
                              <span className="text-slate-200 font-bold">{(det.confClip * 100).toFixed(1)}%</span>
                            </div>
                          )}
                          {enabledModels.EfficientNet && (
                            <div className="bg-slate-900 p-1.5 rounded">
                              <span className="text-slate-500 block">EfficientNet:</span>
                              <span className="text-slate-200 font-bold">{(det.confEff * 100).toFixed(1)}%</span>
                            </div>
                          )}
                          {enabledModels.DINOv2 && (
                            <div className="bg-slate-900 p-1.5 rounded">
                              <span className="text-slate-500 block">DINOv2 Sim:</span>
                              <span className="text-slate-200 font-bold">{(det.dinoSim * 100).toFixed(1)}%</span>
                            </div>
                          )}
                        </div>

                        {isWeed && det.status !== 'eliminated' && (
                          <button
                            onClick={() => triggerLaserStrike(det.id)}
                            className="w-full mt-1 bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-500/40 py-1.5 rounded text-xs font-bold flex items-center justify-center space-x-1 cursor-pointer transition-colors"
                          >
                            <Zap className="w-3.5 h-3.5" />
                            <span>Eliminate with Laser</span>
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Console Log Footer */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2 text-xs font-mono text-slate-400">
                  <Terminal className="w-4 h-4 text-emerald-400" />
                  <span>AI Inference & Hardware Bridge Terminal Log</span>
                </div>
                <button
                  onClick={() => setSimLogs(prev => [`[System] Logs cleared at ${new Date().toLocaleTimeString()}`, ...prev])}
                  className="text-xs text-slate-400 hover:text-slate-200"
                >
                  Clear Logs
                </button>
              </div>
              <div className="bg-slate-950 p-3 rounded-lg font-mono text-xs text-emerald-400/90 h-32 overflow-y-auto space-y-1">
                {simLogs.map((log, index) => (
                  <div key={index} className="leading-relaxed">{log}</div>
                ))}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'models' && (
          <div className="space-y-6">
            {/* Model Pipeline Configuration Panel */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <Sliders className="w-5 h-5 text-emerald-400" />
                  <h2 className="font-semibold text-base">Inference Pipeline Model Configuration</h2>
                </div>
                <span className="text-xs text-slate-400 font-mono">
                  Active Models: {Object.values(enabledModels).filter(Boolean).length} / 4
                </span>
              </div>
              <p className="text-xs text-slate-400">Enable or disable specific models in the ensemble detection pipeline. Disabling a model instantly excludes its inference pass and removes its latency tracking from the chart below.</p>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 pt-1">
                {[
                  { key: 'YOLOv8', name: 'YOLOv8n Detector', desc: 'Bounding box localization', color: 'border-emerald-500/30 bg-emerald-500/5 text-emerald-400' },
                  { key: 'CLIP', name: 'CLIP Zero-Shot', desc: 'Semantic prompt classification', color: 'border-cyan-500/30 bg-cyan-500/5 text-cyan-400' },
                  { key: 'DINOv2', name: 'DINOv2 Extractor', desc: 'Texture & feature similarity', color: 'border-amber-500/30 bg-amber-500/5 text-amber-400' },
                  { key: 'EfficientNet', name: 'EfficientNet-B0', desc: 'Fine-tuned weed classifier', color: 'border-purple-500/30 bg-purple-500/5 text-purple-400' },
                ].map((item) => {
                  const isEnabled = enabledModels[item.key as keyof typeof enabledModels];
                  return (
                    <div 
                      key={item.key}
                      onClick={() => toggleModel(item.key as keyof typeof enabledModels)}
                      className={`p-4 rounded-xl border cursor-pointer transition-all flex flex-col justify-between space-y-3 ${
                        isEnabled ? 'bg-slate-950 border-slate-700 shadow-lg' : 'bg-slate-950/40 border-slate-800/60 opacity-60'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className={`text-xs font-bold px-2 py-0.5 rounded border ${item.color}`}>
                          {item.key}
                        </span>
                        <button className="text-slate-300 hover:text-white transition-colors">
                          {isEnabled ? (
                            <span className="flex items-center space-x-1 text-emerald-400 text-xs font-bold font-mono bg-emerald-500/10 px-2 py-1 rounded border border-emerald-500/30">
                              <Check className="w-3.5 h-3.5" />
                              <span>ENABLED</span>
                            </span>
                          ) : (
                            <span className="flex items-center space-x-1 text-slate-400 text-xs font-bold font-mono bg-slate-800 px-2 py-1 rounded border border-slate-700">
                              <X className="w-3.5 h-3.5" />
                              <span>DISABLED</span>
                            </span>
                          )}
                        </button>
                      </div>
                      <div>
                        <div className="font-semibold text-sm text-slate-200">{item.name}</div>
                        <div className="text-[11px] text-slate-400 mt-0.5">{item.desc}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Real-time Inference Latency Chart (Recharts) */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="font-semibold text-base flex items-center space-x-2">
                    <Activity className="w-5 h-5 text-emerald-400" />
                    <span>Real-Time Inference Latency (ms) — Past 60 Seconds</span>
                  </h2>
                  <p className="text-xs text-slate-400 mt-1">Profiling model processing time per frame to identify computational bottlenecks.</p>
                </div>
                <div className="flex items-center space-x-3 text-xs font-mono">
                  {enabledModels.YOLOv8 && <span className="flex items-center space-x-1"><span className="w-3 h-0.5 bg-emerald-400 inline-block"></span><span>YOLOv8</span></span>}
                  {enabledModels.CLIP && <span className="flex items-center space-x-1"><span className="w-3 h-0.5 bg-cyan-400 inline-block"></span><span>CLIP</span></span>}
                  {enabledModels.DINOv2 && <span className="flex items-center space-x-1"><span className="w-3 h-0.5 bg-amber-400 inline-block"></span><span>DINOv2</span></span>}
                  {enabledModels.EfficientNet && <span className="flex items-center space-x-1"><span className="w-3 h-0.5 bg-purple-400 inline-block"></span><span>EfficientNet</span></span>}
                </div>
              </div>

              <div className="h-72 w-full pt-2">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={latencyHistory} margin={{ top: 5, right: 20, left: -10, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.5} />
                    <XAxis dataKey="time" stroke="#94a3b8" fontSize={12} tickLine={false} />
                    <YAxis stroke="#94a3b8" fontSize={12} tickLine={false} unit="ms" domain={[0, 60]} />
                    <Tooltip 
                      contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', borderRadius: '0.5rem', color: '#f8fafc', fontSize: '12px' }}
                      itemStyle={{ padding: '2px 0' }}
                    />
                    <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '8px' }} />
                    {enabledModels.YOLOv8 && <Line type="monotone" dataKey="YOLOv8" stroke="#34d399" strokeWidth={2.5} dot={false} activeDot={{ r: 6 }} />}
                    {enabledModels.CLIP && <Line type="monotone" dataKey="CLIP" stroke="#22d3ee" strokeWidth={2.5} dot={false} activeDot={{ r: 6 }} />}
                    {enabledModels.DINOv2 && <Line type="monotone" dataKey="DINOv2" stroke="#fbbf24" strokeWidth={2.5} dot={false} activeDot={{ r: 6 }} />}
                    {enabledModels.EfficientNet && <Line type="monotone" dataKey="EfficientNet" stroke="#c084fc" strokeWidth={2.5} dot={false} activeDot={{ r: 6 }} />}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Model Architecture Specs */}
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
                <h2 className="font-semibold text-base flex items-center space-x-2">
                  <Layers className="w-5 h-5 text-emerald-400" />
                  <span>Ensembled Model Architecture</span>
                </h2>
                <div className="space-y-3">
                  <div className={`p-3 rounded-lg border ${enabledModels.YOLOv8 ? 'bg-slate-950 border-slate-800' : 'bg-slate-950/40 border-slate-900 opacity-50'}`}>
                    <div className="flex items-center justify-between font-bold text-sm text-emerald-400">
                      <span>1. YOLOv8n (Object Detector)</span>
                      <span className="text-xs text-slate-400 font-mono">{enabledModels.YOLOv8 ? 'Active' : 'Bypassed'}</span>
                    </div>
                    <p className="text-xs text-slate-400 mt-1">Real-time bounding box detection optimized for edge GPUs (Jetson / Raspberry Pi 5). Trained on 12,000 agricultural field images.</p>
                  </div>

                  <div className={`p-3 rounded-lg border ${enabledModels.CLIP ? 'bg-slate-950 border-slate-800' : 'bg-slate-950/40 border-slate-900 opacity-50'}`}>
                    <div className="flex items-center justify-between font-bold text-sm text-cyan-400">
                      <span>2. CLIP (ViT-B/32 Zero-Shot Classifier)</span>
                      <span className="text-xs text-slate-400 font-mono">{enabledModels.CLIP ? 'Active' : 'Bypassed'}</span>
                    </div>
                    <p className="text-xs text-slate-400 mt-1">Zero-shot semantic classification comparing crop vs weed textual prompts ("a photo of grass weed", "a photo of tomato plant").</p>
                  </div>

                  <div className={`p-3 rounded-lg border ${enabledModels.DINOv2 ? 'bg-slate-950 border-slate-800' : 'bg-slate-950/40 border-slate-900 opacity-50'}`}>
                    <div className="flex items-center justify-between font-bold text-sm text-amber-400">
                      <span>3. DINOv2 (Self-Supervised Feature Extractor)</span>
                      <span className="text-xs text-slate-400 font-mono">{enabledModels.DINOv2 ? 'Active' : 'Bypassed'}</span>
                    </div>
                    <p className="text-xs text-slate-400 mt-1">Extracts robust visual texture embeddings for similarity matching against verified weed prototype database.</p>
                  </div>

                  <div className={`p-3 rounded-lg border ${enabledModels.EfficientNet ? 'bg-slate-950 border-slate-800' : 'bg-slate-950/40 border-slate-900 opacity-50'}`}>
                    <div className="flex items-center justify-between font-bold text-sm text-purple-400">
                      <span>4. EfficientNet-B0 (Fine-Tuned Classifier)</span>
                      <span className="text-xs text-slate-400 font-mono">{enabledModels.EfficientNet ? 'Active' : 'Bypassed'}</span>
                    </div>
                    <p className="text-xs text-slate-400 mt-1">Fine-tuned multi-class classifier distinguishing 4 weed species vs 3 crop species.</p>
                  </div>
                </div>
              </div>

              {/* Dataset & Training Configuration */}
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
                <h2 className="font-semibold text-base flex items-center space-x-2">
                  <BarChart3 className="w-5 h-5 text-emerald-400" />
                  <span>Dataset Classes & Training Parameters</span>
                </h2>

                <div className="space-y-3">
                  <div className="text-xs font-medium text-slate-300">Dataset Distribution (7 Classes):</div>
                  <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                    <div className="bg-slate-950 p-2 rounded border border-emerald-500/20 text-emerald-300">crop_tomato (2,400 imgs)</div>
                    <div className="bg-slate-950 p-2 rounded border border-emerald-500/20 text-emerald-300">crop_chili (1,850 imgs)</div>
                    <div className="bg-slate-950 p-2 rounded border border-emerald-500/20 text-emerald-300">crop_flower (1,920 imgs)</div>
                    <div className="bg-slate-950 p-2 rounded border border-red-500/20 text-red-300">weed_grass (3,100 imgs)</div>
                    <div className="bg-slate-950 p-2 rounded border border-red-500/20 text-red-300">weed_dandelion (2,800 imgs)</div>
                    <div className="bg-slate-950 p-2 rounded border border-red-500/20 text-red-300">weed_purslane (2,150 imgs)</div>
                    <div className="bg-slate-950 p-2 rounded border border-red-500/20 text-red-300">weed_amaranth (1,900 imgs)</div>
                  </div>

                  <div className="pt-2 border-t border-slate-800 space-y-2">
                    <div className="text-xs font-medium text-slate-300">Training Hyperparameters (`model_config.yaml`):</div>
                    <div className="bg-slate-950 p-3 rounded-lg font-mono text-xs text-slate-300 space-y-1">
                      <div>batch_size: 32</div>
                      <div>epochs: 50 (Early stopping patience: 10)</div>
                      <div>optimizer: AdamW (lr=3e-4, weight_decay=0.01)</div>
                      <div>image_size: 640x640 (YOLO) / 224x224 (EfficientNet)</div>
                      <div>augmentation: Mosaic, Mixup, HSV jitter, RandomRotation</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'calibration' && (
          <div className="space-y-6">
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="font-semibold text-lg flex items-center space-x-2">
                    <Camera className="w-5 h-5 text-emerald-400" />
                    <span>Camera Intrinsic & Extrinsic Homography Calibration</span>
                  </h2>
                  <p className="text-xs text-slate-400 mt-1">Mapping camera pixel coordinates <span className="font-mono text-emerald-400">(u, v)</span> to physical gantry laser coordinates <span className="font-mono text-cyan-400">(X_mm, Y_mm)</span>.</p>
                </div>
                <div className="bg-emerald-500/10 border border-emerald-500/30 px-3 py-1.5 rounded-lg text-xs text-emerald-400 font-mono">
                  Status: Calibrated (RMS error: 0.28 px)
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-3">
                  <div className="font-semibold text-sm text-slate-200">1. Intrinsic Calibration</div>
                  <p className="text-xs text-slate-400">Uses checkerboard pattern (9x6 corners) to compute camera matrix <span className="font-mono">K</span> and radial distortion coefficients <span className="font-mono">(k1, k2, p1, p2)</span>.</p>
                  <div className="bg-slate-900 p-3 rounded font-mono text-xs text-slate-300 space-y-1">
                    <div>fx = 1245.8, fy = 1246.2</div>
                    <div>cx = 960.0, cy = 540.0</div>
                    <div>distortion: [0.084, -0.192, 0.001, 0.002]</div>
                  </div>
                </div>

                <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-3">
                  <div className="font-semibold text-sm text-slate-200">2. Extrinsic Homography</div>
                  <p className="text-xs text-slate-400">ArUco calibration markers placed at known physical offsets on the gantry frame compute the 3x3 homography transformation matrix.</p>
                  <div className="bg-slate-900 p-3 rounded font-mono text-xs text-slate-300 space-y-1">
                    <div>H = [</div>
                    <div>  [ 0.421, -0.012, 120.5 ],</div>
                    <div>  [ 0.015,  0.418,  85.2 ],</div>
                    <div>  [ 0.000,  0.000,   1.0 ]</div>
                    <div>]</div>
                  </div>
                </div>

                <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-3">
                  <div className="font-semibold text-sm text-slate-200">3. Pixel to MM Transform</div>
                  <p className="text-xs text-slate-400">Interactive formula mapping image bounding box center to gantry stepper motor target position:</p>
                  <div className="bg-slate-900 p-3 rounded font-mono text-xs text-cyan-400 space-y-1">
                    <div>X_mm = H11*u + H12*v + H13</div>
                    <div>Y_mm = H21*u + H22*v + H23</div>
                    <div>Precision: &plusmn;0.35mm</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'navigation' && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
                <h2 className="font-semibold text-base flex items-center space-x-2">
                  <Compass className="w-5 h-5 text-emerald-400" />
                  <span>Boustrophedon Path Planner</span>
                </h2>
                <p className="text-xs text-slate-400">Generates lawnmower / serpentine coverage paths across agricultural beds for systematic weed eradication.</p>
                <div className="bg-slate-950 p-3 rounded-lg font-mono text-xs text-slate-300 space-y-1">
                  <div>Row Width: 75 cm</div>
                  <div>Headland Turning: Smooth Bezier</div>
                  <div>Coverage Efficiency: 98.4%</div>
                </div>
              </div>

              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
                <h2 className="font-semibold text-base flex items-center space-x-2">
                  <Activity className="w-5 h-5 text-cyan-400" />
                  <span>SLAM & Odometry</span>
                </h2>
                <p className="text-xs text-slate-400">Wheel encoder feedback combined with IMU (MPU6050) and ultrasonic obstacle detection for robust field localization.</p>
                <div className="bg-slate-950 p-3 rounded-lg font-mono text-xs text-slate-300 space-y-1">
                  <div>Linear Speed: 0.3 m/s</div>
                  <div>Heading Accuracy: &plusmn;0.8 deg</div>
                  <div>Obstacle Stop: Active (&lt; 30cm)</div>
                </div>
              </div>

              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
                <h2 className="font-semibold text-base flex items-center space-x-2">
                  <Server className="w-5 h-5 text-amber-400" />
                  <span>ESP32 Bridge & Telemetry</span>
                </h2>
                <p className="text-xs text-slate-400">TCP socket communication between Raspberry Pi 5 core and ESP32 microcontroller managing motor drivers and laser safety relay.</p>
                <div className="bg-slate-950 p-3 rounded-lg font-mono text-xs text-slate-300 space-y-1">
                  <div>Protocol: TCP / JSON Stream</div>
                  <div>Baud Rate: 115200</div>
                  <div>Heartbeat: 50ms interval</div>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'hardware' && (
          <div className="space-y-6">
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="font-semibold text-lg flex items-center space-x-2">
                    <Zap className="w-5 h-5 text-emerald-400" />
                    <span>Hardware Mechatronics & Laser Safety Specs</span>
                  </h2>
                  <p className="text-xs text-slate-400 mt-1">Physical specifications from URDF robot model <span className="font-mono text-emerald-400">weed_laser_robot.urdf</span> and CAD assemblies.</p>
                </div>
                <div className="bg-red-500/10 border border-red-500/30 px-3 py-1.5 rounded-lg text-xs text-red-400 font-mono flex items-center space-x-1">
                  <ShieldAlert className="w-4 h-4" />
                  <span>Class 4 Laser Protocol Active</span>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2">
                  <div className="text-xs text-slate-400 uppercase tracking-wider">Compute Unit</div>
                  <div className="text-base font-bold text-slate-100">Raspberry Pi 5 (8GB)</div>
                  <div className="text-xs text-slate-400">BCM2712 Quad-core ARM Cortex-A76 @ 2.4GHz</div>
                </div>

                <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2">
                  <div className="text-xs text-slate-400 uppercase tracking-wider">Laser Emitter</div>
                  <div className="text-base font-bold text-red-400">450nm Blue Diode (50W-100W)</div>
                  <div className="text-xs text-slate-400">PWM controlled beam duration (50ms - 300ms)</div>
                </div>

                <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2">
                  <div className="text-xs text-slate-400 uppercase tracking-wider">Gantry Motors</div>
                  <div className="text-base font-bold text-cyan-400">NEMA 17 Steppers (X/Y)</div>
                  <div className="text-xs text-slate-400">A4988 microstepping drivers + RAMPS 1.4</div>
                </div>

                <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2">
                  <div className="text-xs text-slate-400 uppercase tracking-wider">Chassis & Weight</div>
                  <div className="text-base font-bold text-slate-100">2020 Aluminum Extrusion</div>
                  <div className="text-xs text-slate-400">Total weight: 14.5 kg, 4WD differential drive</div>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

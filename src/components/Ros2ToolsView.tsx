import React, { useState } from 'react';
import { Terminal, ShieldAlert, Send, FileCode2, CheckCircle2, XCircle } from 'lucide-react';
import { ROS2_TOOLS, WORKSPACE_SNIPPETS, Ros2ToolDef } from '../data/ros2Artifacts';

interface Props {
  estopActive: boolean;
  onLogEvent: (msg: string) => void;
}

interface DispatchTrace {
  id: number;
  timestamp: string;
  toolName: string;
  accepted: boolean;
  summary: string;
  payload: string;
}

const ARCH_LAYERS = [
  {
    name: 'AI / Mission Commander',
    detail: 'Natural language · Bounded tool calling · Multi-row task planning (Zero direct PWM access)',
  },
  {
    name: 'ROS 2 Mission Supervisor',
    detail: 'FieldBoundaryGuard validation · Sensor health & recovery gating · Nav2 & RowNavigator Action clients',
  },
  {
    name: 'Nav2 + Crop-Row Visual AI',
    detail: 'RegulatedPurePursuit · SmacPlanner2D · ExG+Otsu Visual Servoing · Collision Monitor (/cmd_vel_safe)',
  },
  {
    name: 'Single-Bus Motor & Sensor Interface',
    detail: 'Shared ESP32Bridge (/dev/ttyUSB0) · Closed-loop 50 Hz PID · FieldLocalizer (Encoders + BNO055 + RTK)',
  },
  {
    name: 'Physical Rover Platform',
    detail: '4 coupled DC geared wheels (64 CPR encoders) · Forward Nav Cam · VL53L0X/LiDAR · Modular Treatment Hook (Detached)',
  },
];

export const Ros2ToolsView: React.FC<Props> = ({ estopActive, onLogEvent }) => {
  const [selectedTool, setSelectedTool] = useState<Ros2ToolDef>(ROS2_TOOLS[0]);
  const [paramJson, setParamJson] = useState<string>(JSON.stringify(ROS2_TOOLS[0].defaultParams, null, 2));
  const [sensorsHealthy, setSensorsHealthy] = useState<boolean>(true);
  const [treatmentHookAttached, setTreatmentHookAttached] = useState<boolean>(false);
  const [traces, setTraces] = useState<DispatchTrace[]>([
    {
      id: 1,
      timestamp: 'Init',
      toolName: 'get_robot_status',
      accepted: true,
      summary: 'Mission Supervisor online · FieldLocalizer Nominal · 9 bounded tools registered · Treatment decoupled.',
      payload: '{"state": "READY", "current_row": 1, "sensor_status": "CLEAR", "estop_ok": true, "treatment_hook": null}',
    },
  ]);

  const [activeSnippetKey, setActiveSnippetKey] = useState<string>('state_machine');

  const handleSelectTool = (tool: Ros2ToolDef) => {
    setSelectedTool(tool);
    setParamJson(JSON.stringify(tool.defaultParams, null, 2));
  };

  const dispatchToSupervisor = () => {
    const now = new Date().toLocaleTimeString();
    let parsed: Record<string, any> = {};
    try {
      parsed = JSON.parse(paramJson);
    } catch {
      const errTrace: DispatchTrace = {
        id: Date.now(),
        timestamp: now,
        toolName: selectedTool.name,
        accepted: false,
        summary: 'REJECTED: Invalid JSON parameter payload.',
        payload: '{"accepted": false, "error": "JSON_PARSE_ERROR"}',
      };
      setTraces((prev) => [errTrace, ...prev]);
      return;
    }

    let accepted = true;
    let summary = '';
    let resultObj: Record<string, unknown> = {};

    if (selectedTool.category === 'Forbidden Test' || selectedTool.name.startsWith('motor_pwm')) {
      accepted = false;
      summary = 'POLICY VIOLATION: AI Mission Commander is forbidden from writing motor PWM or bypassing E-stop.';
      resultObj = { accepted: false, error: 'POLICY_VIOLATION_DIRECT_PWM_DENIED' };
    } else if (
      estopActive &&
      selectedTool.name !== 'get_robot_status' &&
      selectedTool.name !== 'pause_and_checkpoint'
    ) {
      accepted = false;
      summary = 'HARDWARE E-STOP ENGAGED (GPIO 13): Supervisor blocked motion/action goal until physical relay resets.';
      resultObj = { accepted: false, error: 'HARDWARE_ESTOP_ENGAGED' };
    } else if (selectedTool.name === 'start_navigation_mission') {
      const sRow = Number(parsed.start_row ?? 1);
      const eRow = Number(parsed.end_row ?? 1);
      const spd = Number(parsed.speed_limit_mps ?? 0.15);
      const enableHook = Boolean(parsed.enable_treatment_hook);

      if (sRow < 1 || eRow > 10 || sRow > eRow) {
        accepted = false;
        summary = `BOUNDARY ERROR: Row range [${sRow}..${eRow}] outside field_01 bounds (1..10).`;
        resultObj = { accepted: false, error: 'INVALID_ROW_RANGE' };
      } else if (spd <= 0 || spd > 0.3) {
        accepted = false;
        summary = `SAFETY LIMIT: speed_limit_mps=${spd} exceeds safe maximum (0.30 m/s).`;
        resultObj = { accepted: false, error: 'SPEED_LIMIT_EXCEEDED' };
      } else if (!sensorsHealthy) {
        accepted = false;
        summary = 'SENSOR HEALTH GATE (NAV-05): Obstacle sensor, encoders, and IMU must be healthy before motion.';
        resultObj = { accepted: false, error: 'SENSOR_HEALTH_FAILED' };
      } else if (enableHook && !treatmentHookAttached) {
        accepted = false;
        summary = 'MODULAR HOOK DETACHED: Navigation-only mode active; attach Flame/Grinder module to enable treatment hook.';
        resultObj = { accepted: false, error: 'TREATMENT_HOOK_NOT_ATTACHED' };
      } else {
        summary = `ACCEPTED -> ExecuteNavigationMission (Rows ${sRow}..${eRow} @ ${spd} m/s, Treatment Hook: ${enableHook ? 'ARMED' : 'DETACHED'}).`;
        resultObj = {
          accepted: true,
          ros2_action: '/execute_navigation_mission',
          rows: Array.from({ length: eRow - sRow + 1 }, (_, i) => sRow + i),
          speed_limit_mps: spd,
          treatment_hook_enabled: enableHook,
        };
      }
    } else if (selectedTool.name === 'recover_from_fault') {
      if (!sensorsHealthy) {
        accepted = false;
        summary = 'RECOVERY BLOCKED (NAV-10): Obstacle sensor still reporting -1 SENSOR_FAULT.';
        resultObj = { accepted: false, error: 'SENSOR_STILL_FAULTED' };
      } else {
        summary = `ACCEPTED -> Explicit recover() applied landmark pose (${parsed.relocalize_x_cm}, ${parsed.relocalize_y_cm}) cm.`;
        resultObj = {
          accepted: true,
          state: 'NAVIGATING',
          slip_residual_cm: 0.0,
          relocalized_pose: [parsed.relocalize_x_cm, parsed.relocalize_y_cm, parsed.relocalize_yaw_deg],
        };
      }
    } else if (selectedTool.name === 'get_robot_status') {
      summary = 'SERVICE RESPONSE -> GetRobotStatus returned live pose, sensor health & coverage snapshot.';
      resultObj = {
        accepted: true,
        state: estopActive ? 'ESTOP_HALTED' : sensorsHealthy ? 'READY' : 'FAULT',
        sensors_healthy: sensorsHealthy,
        hardware_estop_ok: !estopActive,
        treatment_hook_attached: treatmentHookAttached,
      };
    } else if (selectedTool.name === 'pause_and_checkpoint') {
      summary = 'SERVICE RESPONSE -> PauseMission stopped motors and flushed atomic mission_checkpoint.json (NAV-12).';
      resultObj = { accepted: true, cmd_vel: [0, 0], checkpoint_saved: true };
    } else {
      if (!sensorsHealthy) {
        accepted = false;
        summary = `SENSOR HEALTH GATE: Blocked ${selectedTool.ros2Interface} while obstacle/localization sensors faulted.`;
        resultObj = { accepted: false, error: 'SENSOR_HEALTH_FAILED' };
      } else {
        summary = `ACCEPTED -> Dispatched ${selectedTool.ros2Interface} goal via ROS 2 Mission Supervisor.`;
        resultObj = { accepted: true, interface: selectedTool.ros2Interface, goal: parsed };
      }
    }

    const trace: DispatchTrace = {
      id: Date.now(),
      timestamp: now,
      toolName: selectedTool.name,
      accepted,
      summary,
      payload: JSON.stringify(resultObj, null, 2),
    };
    setTraces((prev) => [trace, ...prev.slice(0, 7)]);
    onLogEvent(`[ROS 2 Supervisor] ${selectedTool.name}: ${summary}`);
  };

  const activeSnippet = WORKSPACE_SNIPPETS[activeSnippetKey] || WORKSPACE_SNIPPETS.state_machine;

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-emerald-900/10 pb-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-slate-900">
            Navigation Architecture, Supervisor Tools &amp; Production Code
          </h2>
          <p className="text-xs text-slate-600 mt-1">
            Decoupled Navigation Stack (Navigation/src/ + ros2_ws/src/) · Nav2 Standard Actions · Explicit Fault Recovery
          </p>
        </div>
        <div className="text-xs font-mono text-slate-600">
          Verified Modules: <span className="text-emerald-700 font-semibold">Navigation/src/</span> +{' '}
          <span className="text-emerald-700 font-semibold">ros2_ws/src/</span>
        </div>
      </div>

      {/* 1. Layered Architecture with Independent Hardware Safety Override Rail */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-slate-900">
          01. Separation of Intelligence, Motion Control &amp; Hardware Safety
        </h3>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
          <div className="lg:col-span-9 space-y-2">
            {ARCH_LAYERS.map((layer, idx) => (
              <div
                key={layer.name}
                className="bg-white border border-emerald-900/10 rounded-lg px-4 py-3 flex flex-wrap items-center justify-between gap-2"
              >
                <div className="flex items-center gap-3">
                  <span className="font-mono text-xs text-emerald-700 font-semibold tabular-nums">L{idx + 1}</span>
                  <span className="text-sm font-semibold text-slate-900">{layer.name}</span>
                </div>
                <span className="text-xs text-slate-600">{layer.detail}</span>
              </div>
            ))}
          </div>

          <div className="lg:col-span-3 bg-white border border-rose-200 rounded-lg p-4 flex flex-col justify-between gap-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-rose-700">
                <ShieldAlert className="w-4 h-4 shrink-0" />
                <span className="text-xs font-semibold">Hardware Safety Override</span>
              </div>
              <p className="text-xs text-slate-700 leading-relaxed">
                Independent physical emergency-stop relay (GPIO 13 sense) cuts motor rail power directly regardless of RPi 5, ROS 2, or AI state.
              </p>
              <p className="text-xs text-slate-500 leading-relaxed">
                250 ms ESP32 serial watchdog forces immediate motor halt on host hang or cable disconnect.
              </p>
            </div>
            <div className="pt-3 border-t border-rose-100 text-xs font-mono">
              <div className={estopActive ? 'text-rose-700 font-semibold' : 'text-emerald-700 font-semibold'}>
                {estopActive ? '✖ E-STOP OPEN (HALTED)' : '● E-STOP LOOP CLOSED'}
              </div>
              <div className={sensorsHealthy ? 'text-emerald-700 mt-1' : 'text-rose-700 mt-1 font-semibold'}>
                {sensorsHealthy ? '● OBSTACLE SENSOR VALID' : '✖ SENSOR_FAULT (-1)'}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 2. Interactive ROS 2 AI Tool-Calling Sandbox */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-slate-900">
            02. Mission Supervisor Tool-Call Validator
          </h3>
          <div className="flex flex-wrap items-center gap-4 text-xs">
            <label className="flex items-center gap-2 text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={sensorsHealthy}
                onChange={(e) => setSensorsHealthy(e.target.checked)}
                className="accent-emerald-600"
              />
              <span>Sensors Healthy (Encoders + IMU + Obstacle)</span>
            </label>
            <label className="flex items-center gap-2 text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={treatmentHookAttached}
                onChange={(e) => setTreatmentHookAttached(e.target.checked)}
                className="accent-emerald-600"
              />
              <span>Modular Treatment Hook Attached (Flame/Grinder)</span>
            </label>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch">
          <div className="lg:col-span-4 bg-white border border-emerald-900/10 rounded-lg divide-y divide-emerald-900/10 max-h-[420px] overflow-y-auto">
            {ROS2_TOOLS.map((tool) => {
              const active = selectedTool.name === tool.name;
              const isForbidden = tool.category === 'Forbidden Test';
              return (
                <button
                  key={tool.name}
                  onClick={() => handleSelectTool(tool)}
                  className={`w-full text-left px-4 py-3 transition-colors cursor-pointer ${
                    active ? 'bg-emerald-50' : 'hover:bg-[#F8FBF9]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`text-xs font-mono font-semibold ${
                        isForbidden ? 'text-rose-700' : active ? 'text-emerald-800' : 'text-slate-900'
                      }`}
                    >
                      {tool.name}
                    </span>
                    <span className="text-[11px] font-mono text-slate-500">{tool.category}</span>
                  </div>
                  <div className="text-[11px] font-mono text-slate-500 mt-0.5 truncate">
                    {tool.ros2Interface}
                  </div>
                </button>
              );
            })}
          </div>

          <div className="lg:col-span-4 bg-white border border-emerald-900/10 rounded-lg p-4 flex flex-col justify-between gap-4">
            <div className="space-y-3">
              <div>
                <div className="text-xs font-mono text-emerald-700 font-medium">{selectedTool.ros2Interface}</div>
                <div className="text-sm font-semibold text-slate-900 mt-0.5">{selectedTool.name}</div>
                <p className="text-xs text-slate-600 mt-1 leading-relaxed">{selectedTool.description}</p>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-mono text-slate-600 block">Tool Parameters (JSON)</label>
                <textarea
                  value={paramJson}
                  onChange={(e) => setParamJson(e.target.value)}
                  rows={8}
                  className="w-full bg-[#F8FBF9] border border-emerald-900/15 rounded p-3 font-mono text-xs text-slate-800 focus:outline-none focus:border-emerald-600"
                />
              </div>
            </div>

            <button
              onClick={dispatchToSupervisor}
              className="w-full py-2.5 px-4 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-xs flex items-center justify-center gap-2 transition-colors cursor-pointer"
            >
              <Send className="w-3.5 h-3.5" />
              <span>Validate &amp; Dispatch to Supervisor</span>
            </button>
          </div>

          <div className="lg:col-span-4 bg-white border border-emerald-900/10 rounded-lg p-4 flex flex-col gap-3">
            <div className="flex items-center gap-2 text-xs font-mono text-slate-700">
              <Terminal className="w-4 h-4 text-emerald-600" />
              <span>Supervisor Validation Trace</span>
            </div>
            <div className="flex-1 overflow-y-auto space-y-3 max-h-[350px] pr-1">
              {traces.map((tr) => (
                <div
                  key={tr.id}
                  className="bg-[#F8FBF9] border border-emerald-900/10 rounded p-3 space-y-2 text-xs"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono font-semibold text-slate-900">{tr.toolName}</span>
                    <span
                      className={`font-mono text-[11px] flex items-center gap-1 font-semibold ${
                        tr.accepted ? 'text-emerald-700' : 'text-rose-700'
                      }`}
                    >
                      {tr.accepted ? (
                        <CheckCircle2 className="w-3.5 h-3.5" />
                      ) : (
                        <XCircle className="w-3.5 h-3.5" />
                      )}
                      {tr.accepted ? 'ACCEPTED' : 'BLOCKED'}
                    </span>
                  </div>
                  <p className="text-slate-600 leading-relaxed">{tr.summary}</p>
                  <pre className="text-[11px] font-mono text-emerald-900 overflow-x-auto pt-1 border-t border-emerald-900/10">
                    {tr.payload}
                  </pre>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* 3. Production Navigation & ROS 2 Code Explorer */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <FileCode2 className="w-4 h-4 text-emerald-600" />
            <h3 className="text-sm font-semibold text-slate-900">
              03. Production Navigation &amp; ROS 2 Artifacts
            </h3>
          </div>
          <div className="flex items-center gap-1 p-1 bg-[#EDF5F0] border border-emerald-900/10 rounded-lg overflow-x-auto">
            {[
              { key: 'state_machine', label: 'Fail-Safe SM' },
              { key: 'localizer', label: 'FieldLocalizer' },
              { key: 'esp32', label: 'ESP32 50Hz PID' },
              { key: 'boundary', label: 'BoundaryGuard' },
              { key: 'urdf', label: 'URDF + ros2_control' },
              { key: 'nav2', label: 'Nav2 Collision' },
            ].map((item) => (
              <button
                key={item.key}
                onClick={() => setActiveSnippetKey(item.key)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  activeSnippetKey === item.key
                    ? 'bg-white text-emerald-800 border border-emerald-200 font-semibold'
                    : 'text-slate-600 hover:text-emerald-800 border border-transparent'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="bg-white border border-emerald-900/10 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-emerald-900/10 bg-[#F4F8F5] flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-mono text-emerald-800 font-semibold">{activeSnippet.path}</span>
            <span className="text-xs text-slate-600">{activeSnippet.summary}</span>
          </div>
          <pre className="p-4 text-xs font-mono text-slate-800 bg-[#F8FBF9] overflow-x-auto leading-relaxed">
            {activeSnippet.code}
          </pre>
        </div>
      </section>
    </div>
  );
};

import React, { useCallback, useEffect, useState } from 'react';
import { OctagonAlert, RotateCcw, Terminal } from 'lucide-react';
import { NavigationWorkbench } from './components/NavigationWorkbench';
import { HardwareAuditView } from './components/HardwareAuditView';
import { Ros2ToolsView } from './components/Ros2ToolsView';
import { WeedVisionView } from './components/WeedVisionView';
import { MobileCameraPublisher } from './components/MobileCameraPublisher';
import { SimplaBotView } from './components/SimplaBotView';
import { Rover3DGame } from './components/Rover3DGame';

type TabId = 'game' | 'navigation' | 'simpla_bot' | 'hardware' | 'ros2' | 'vision' | 'calibration';
type RobotLinkMode = 'sim_only' | 'pi_live' | 'pi_auth_error' | 'pi_unreachable';

const NAV_ITEMS: Array<{ id: TabId; label: string }> = [
  { id: 'game', label: '3D Rover Game' },
  { id: 'navigation', label: 'Navigation' },
  { id: 'simpla_bot', label: 'Simpla Bot' },
  { id: 'hardware', label: 'Sector Audit' },
  { id: 'ros2', label: 'ROS 2 Tools' },
  { id: 'vision', label: 'Weed Vision' },
];

export default function App() {
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('mode') === 'camera-publisher') {
    return <MobileCameraPublisher initialRoom={urlParams.get('room') || 'rover-01'} />;
  }

  const [activeTab, setActiveTab] = useState<TabId>('game');
  const [estopActive, setEstopActive] = useState<boolean>(false);
  const [estopBusy, setEstopBusy] = useState<boolean>(false);
  const [robotLinkMode, setRobotLinkMode] = useState<RobotLinkMode>('sim_only');
  const [eventLog, setEventLog] = useState<string[]>([
    '[System] Checking Raspberry Pi robot controller link (/api/robot/status)...',
    '[Safety] Browser Software E-Stop dispatches POST /api/robot/stop when Pi is connected; it is NOT a replacement for the physical GPIO 13 power cutoff switch.',
    '[3D Game] Interactive agricultural rover assembly & field mission ready.',
  ]);

  const appendLog = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString();
    setEventLog((prev) => [`[${ts}] ${msg}`, ...prev.slice(0, 19)]);
  }, []);

  useEffect(() => {
    let active = true;
    const pollRobotStatus = async (isInitial: boolean) => {
      try {
        const res = await fetch('/api/robot/status');
        const ct = res.headers.get('content-type') || '';
        if (!res.ok || !ct.includes('application/json')) {
          if (active) setRobotLinkMode('sim_only');
          return;
        }
        const data = await res.json();
        if (!active) return;
        const nextMode: RobotLinkMode =
          data.mode === 'pi_live'
            ? 'pi_live'
            : data.mode === 'pi_auth_error'
            ? 'pi_auth_error'
            : data.configured
            ? 'pi_unreachable'
            : 'sim_only';
        setRobotLinkMode(nextMode);
        if (isInitial) {
          if (nextMode === 'pi_live') {
            appendLog('[RobotLink] Connected to live Raspberry Pi controller via /api/robot/* proxy.');
          } else if (nextMode === 'pi_auth_error') {
            appendLog(`[RobotLink] Pi authentication rejected (${data.detail || 'HTTP 401'}). Check PI_API_TOKEN on Pi and server.`);
          } else if (nextMode === 'pi_unreachable') {
            appendLog(`[RobotLink] PI_ROBOT_URL configured but unreachable (${data.detail || 'timeout'}) — simulation mode only.`);
          } else {
            appendLog('[RobotLink] Running in Simulation-Only mode (PI_ROBOT_URL not set on server). Dashboard commands will not move physical hardware.');
          }
        }
      } catch {
        if (active) setRobotLinkMode('sim_only');
      }
    };

    void pollRobotStatus(true);
    const id = window.setInterval(() => void pollRobotStatus(false), 10000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [appendLog]);

  const toggleEstop = async () => {
    if (estopBusy) return;
    setEstopBusy(true);

    if (!estopActive) {
      setEstopActive(true);
      try {
        const res = await fetch('/api/robot/stop', { method: 'POST' });
        const ct = res.headers.get('content-type') || '';
        const data = ct.includes('application/json') ? await res.json().catch(() => ({})) : {};
        if (res.ok && data.ackVerified) {
          appendLog(
            `[SAFETY] Software E-Stop ACK verified by Pi/ESP32 (${data.esp32Response || 'OK:ESTOP_LATCHED'}${
              data.simulated ? ', Pi simulator' : ', live UART'
            }). Physical GPIO 13 cutoff switch remains primary safety rail.`
          );
        } else {
          appendLog(
            `[SAFETY] UI Simulation Halted ONLY — ${
              data.detail || 'No physical Pi/ESP32 stop ACK verified'
            }. Browser button is NOT a physical emergency stop.`
          );
        }
      } catch {
        appendLog(
          '[SAFETY] UI Simulation Halted ONLY — Failed to reach /api/robot/stop. Use the physical GPIO 13 E-stop switch to cut motor power.'
        );
      } finally {
        setEstopBusy(false);
      }
      return;
    }

    if (robotLinkMode === 'pi_live') {
      try {
        const res = await fetch('/api/robot/recover', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operator_confirmed: true }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.recovered) {
          setEstopActive(false);
          appendLog(
            `[SAFETY] Operator recovery verified by Pi/ESP32 (state=${data.state || 'PAUSED'}). Explicit mission resume still required.`
          );
        } else {
          appendLog(
            `[SAFETY] Hardware recovery REJECTED by Pi (${data.reason || `HTTP ${res.status}`}). Check physical GPIO 13 E-stop switch and sensors.`
          );
        }
      } catch {
        appendLog('[SAFETY] Recovery request failed — Pi controller unreachable.');
      } finally {
        setEstopBusy(false);
      }
      return;
    }

    setEstopActive(false);
    appendLog('[SAFETY] Local UI simulation halt cleared (no physical Pi/ESP32 connected).');
    setEstopBusy(false);
  };

  return (
    <div className="min-h-screen bg-[#F7FAF8] text-slate-900 flex flex-col">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="sticky top-0 z-50 bg-white border-b border-emerald-900/10 px-6 h-14 flex items-center justify-between gap-8">
        {/* Zone 1: Single-line brand wordmark */}
        <button
          onClick={() => setActiveTab('game')}
          className="text-base font-semibold tracking-tight text-emerald-950 whitespace-nowrap shrink-0 cursor-pointer"
        >
          AgriRover 3D
        </button>

        {/* Zone 2: Clean single-line navigation links */}
        <nav className="flex items-center gap-6 overflow-x-auto">
          {NAV_ITEMS.map((item) => {
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={`text-sm font-medium transition-colors whitespace-nowrap shrink-0 py-1 border-b-2 cursor-pointer ${
                  active
                    ? 'text-emerald-700 border-emerald-600'
                    : 'text-slate-600 border-transparent hover:text-emerald-800'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </nav>

        {/* Zone 3: 1 primary action (Software E-Stop) */}
        <div className="shrink-0">
          <button
            onClick={() => void toggleEstop()}
            disabled={estopBusy}
            title="Sends POST /api/robot/stop to the Raspberry Pi when connected, and latches the 3D rover GPIO 13 E-stop."
            className={`px-4 py-1.5 rounded-md text-xs font-semibold transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 cursor-pointer disabled:opacity-60 ${
              estopActive
                ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
                : 'bg-rose-600 hover:bg-rose-700 text-white'
            }`}
          >
            {estopActive ? (
              <>
                <RotateCcw className="w-3.5 h-3.5" />
                <span>{robotLinkMode === 'pi_live' ? 'Recover Stop' : 'Clear E-Stop'}</span>
              </>
            ) : (
              <>
                <OctagonAlert className="w-3.5 h-3.5" />
                <span>Software E-Stop</span>
              </>
            )}
          </button>
        </div>
      </header>

      {/* Main Content */}
      {activeTab === 'game' ? (
        <main className="flex-1 w-full">
          <Rover3DGame estopActive={estopActive} onLogEvent={appendLog} />
        </main>
      ) : (
        <main className="flex-1 w-full max-w-[1440px] mx-auto px-6 py-6 space-y-6">
          {activeTab === 'navigation' && (
            <NavigationWorkbench estopActive={estopActive} onLogEvent={appendLog} />
          )}
          {activeTab === 'simpla_bot' && (
            <SimplaBotView estopActive={estopActive} onLogEvent={appendLog} />
          )}
          {activeTab === 'hardware' && <HardwareAuditView />}
          {activeTab === 'ros2' && (
            <Ros2ToolsView estopActive={estopActive} onLogEvent={appendLog} />
          )}
          {activeTab === 'vision' && (
            <WeedVisionView mode="vision" estopActive={estopActive} onLogEvent={appendLog} />
          )}
          {activeTab === 'calibration' && (
            <WeedVisionView mode="calibration" estopActive={estopActive} onLogEvent={appendLog} />
          )}

          {/* Shared Engineering Event Console */}
          <section className="bg-white border border-emerald-900/10 rounded-lg p-4 space-y-2.5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 text-xs font-mono text-slate-700">
                <Terminal className="w-4 h-4 text-emerald-600" />
                <span>Mission &amp; Hardware Event Log</span>
                <span
                  className={`px-2 py-0.5 rounded text-[11px] font-semibold border ${
                    robotLinkMode === 'pi_live'
                      ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                      : robotLinkMode === 'pi_auth_error'
                      ? 'bg-rose-50 text-rose-700 border-rose-200'
                      : robotLinkMode === 'pi_unreachable'
                      ? 'bg-amber-50 text-amber-800 border-amber-200'
                      : 'bg-slate-100 text-slate-600 border-slate-200'
                  }`}
                >
                  {robotLinkMode === 'pi_live'
                    ? 'PI LIVE'
                    : robotLinkMode === 'pi_auth_error'
                    ? 'PI AUTH ERROR'
                    : robotLinkMode === 'pi_unreachable'
                    ? 'PI UNREACHABLE'
                    : 'SIM ONLY'}
                </span>
              </div>
              <button
                onClick={() => setEventLog([`[${new Date().toLocaleTimeString()}] [Log] Cleared.`])}
                className="text-xs text-slate-500 hover:text-emerald-700 cursor-pointer"
              >
                Clear
              </button>
            </div>
            <div className="bg-[#F4F8F5] border border-emerald-900/10 rounded p-3 h-28 overflow-y-auto font-mono text-xs text-slate-700 space-y-1">
              {eventLog.map((line, i) => (
                <div key={i} className="leading-relaxed">
                  {line}
                </div>
              ))}
            </div>
          </section>
        </main>
      )}
    </div>
  );
}

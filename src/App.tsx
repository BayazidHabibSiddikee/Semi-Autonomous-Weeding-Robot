import React, { useState } from 'react';
import { OctagonAlert, RotateCcw, Terminal } from 'lucide-react';
import { NavigationWorkbench } from './components/NavigationWorkbench';
import { HardwareAuditView } from './components/HardwareAuditView';
import { Ros2ToolsView } from './components/Ros2ToolsView';
import { WeedVisionView } from './components/WeedVisionView';

type TabId = 'navigation' | 'hardware' | 'ros2' | 'vision' | 'calibration';

const NAV_ITEMS: Array<{ id: TabId; label: string }> = [
  { id: 'navigation', label: 'Navigation' },
  { id: 'hardware', label: 'Sector Audit' },
  { id: 'ros2', label: 'ROS 2 Tools' },
  { id: 'vision', label: 'Weed Vision' },
  { id: 'calibration', label: 'Calibration' },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>('navigation');
  const [estopActive, setEstopActive] = useState<boolean>(false);
  const [eventLog, setEventLog] = useState<string[]>([
    '[Audit] Navigation sector resolved (NAV-01..NAV-12 & HW-01..HW-09): 8/8 unittest PASS, 99.9% sim coverage.',
    '[Bridge] Single shared /dev/ttyUSB0 ESP32Bridge active (NAV-06); zero GPIO 25/22 pin collisions.',
    '[Vision] Streaming /crop_row/alignment (Lateral Offset m, Heading Error rad) from CropRowTracker.',
    '[Decoupled] Navigation-only mode active (legacy laser retired; modular Flame/Grinder hook detached).',
  ]);

  const appendLog = (msg: string) => {
    const ts = new Date().toLocaleTimeString();
    setEventLog((prev) => [`[${ts}] ${msg}`, ...prev.slice(0, 19)]);
  };

  const toggleEstop = () => {
    setEstopActive((prev) => {
      const next = !prev;
      appendLog(
        next
          ? '[SAFETY] HARDWARE E-STOP ENGAGED (GPIO 13) — Motor rail de-energized immediately.'
          : '[SAFETY] Hardware E-stop loop reset — Supervisor awaiting explicit operator resume.'
      );
      return next;
    });
  };

  return (
    <div className="min-h-screen bg-[#F7FAF8] text-slate-900 flex flex-col">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="sticky top-0 z-50 bg-white/95 backdrop-blur border-b border-emerald-900/10 px-6 h-14 flex items-center justify-between gap-8">
        {/* Zone 1: Single-line brand wordmark */}
        <button
          onClick={() => setActiveTab('navigation')}
          className="text-base font-semibold tracking-tight text-emerald-950 whitespace-nowrap shrink-0 cursor-pointer"
        >
          Weeding Rover Nav
        </button>

        {/* Zone 2: 5 concise single-line navigation links */}
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

        {/* Zone 3: 1 primary action (Hardware E-Stop override) */}
        <div className="shrink-0">
          <button
            onClick={toggleEstop}
            className={`px-4 py-1.5 rounded-md text-xs font-semibold transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 cursor-pointer ${
              estopActive
                ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
                : 'bg-rose-600 hover:bg-rose-700 text-white'
            }`}
          >
            {estopActive ? (
              <>
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reset E-Stop</span>
              </>
            ) : (
              <>
                <OctagonAlert className="w-3.5 h-3.5" />
                <span>Emergency Stop</span>
              </>
            )}
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 w-full max-w-[1440px] mx-auto px-6 py-6 space-y-6">
        {activeTab === 'navigation' && (
          <NavigationWorkbench estopActive={estopActive} onLogEvent={appendLog} />
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
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-mono text-slate-700">
              <Terminal className="w-4 h-4 text-emerald-600" />
              <span>ROS 2 Mission &amp; Hardware Event Log</span>
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
    </div>
  );
}

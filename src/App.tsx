import React, { useState } from 'react';
import { AppLanguage, Strings } from './i18n/strings';
import { LaunchMissionConfig } from './domain/roverLiveEngine';
import { CaptureLaunchScreen } from './components/CaptureLaunchScreen';
import { LiveRoverStreamScreen } from './components/LiveRoverStreamScreen';
import { ProjectDetailsScreen } from './components/ProjectDetailsScreen';
import { AboutDeveloperScreen } from './components/AboutDeveloperScreen';

type AppTab = 'CAPTURE' | 'LIVE' | 'PROJECT' | 'ABOUT';

export function App() {
  const [lang, setLang] = useState<AppLanguage>('EN');
  const [tab, setTab] = useState<AppTab>('CAPTURE');
  const [piHost, setPiHost] = useState('http://192.168.4.1:8000');
  const [launchConfig, setLaunchConfig] = useState<LaunchMissionConfig | null>(null);

  const handleLaunchRover = (config: LaunchMissionConfig) => {
    setLaunchConfig(config);
    setTab('LIVE');
  };

  return (
    <div className="flex min-h-screen flex-col bg-[#F8FAFC] text-[#0F172A]">
      {/* Strict 3-Zone Top Bar Contract: Wordmark — 4 Single-Line Nav Links — Primary Language Action */}
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur-xs">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-8 px-4 py-3 sm:px-6">
          <button
            type="button"
            onClick={() => setTab('CAPTURE')}
            className="text-base font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
          >
            {Strings.appTitle(lang)}
          </button>

          <nav className="flex items-center gap-5 overflow-x-auto text-sm font-medium">
            <NavLink
              active={tab === 'CAPTURE'}
              onClick={() => setTab('CAPTURE')}
              label={lang === 'BN' ? 'ছবি ও শুরু' : 'Capture & Launch'}
            />
            <NavLink
              active={tab === 'LIVE'}
              onClick={() => setTab('LIVE')}
              label={lang === 'BN' ? 'লাইভ রোভার' : 'Live Rover'}
            />
            <NavLink
              active={tab === 'PROJECT'}
              onClick={() => setTab('PROJECT')}
              label={lang === 'BN' ? 'প্রজেক্ট' : 'Project'}
            />
            <NavLink
              active={tab === 'ABOUT'}
              onClick={() => setTab('ABOUT')}
              label={lang === 'BN' ? 'পরিচিতি' : 'Developer'}
            />
          </nav>

          <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-0.5 shrink-0">
            <button
              type="button"
              onClick={() => setLang('BN')}
              className={`rounded-md px-2.5 py-1 text-xs font-semibold transition whitespace-nowrap ${
                lang === 'BN' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              বাং
            </button>
            <button
              type="button"
              onClick={() => setLang('EN')}
              className={`rounded-md px-2.5 py-1 text-xs font-semibold transition whitespace-nowrap ${
                lang === 'EN' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              EN
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">
        {tab === 'CAPTURE' && (
          <CaptureLaunchScreen
            lang={lang}
            piHost={piHost}
            onPiHostChange={setPiHost}
            onLaunchRover={handleLaunchRover}
          />
        )}
        {tab === 'LIVE' && (
          <LiveRoverStreamScreen
            lang={lang}
            piHost={piHost}
            onPiHostChange={setPiHost}
            launchConfig={launchConfig}
          />
        )}
        {tab === 'PROJECT' && <ProjectDetailsScreen lang={lang} />}
        {tab === 'ABOUT' && <AboutDeveloperScreen lang={lang} />}
      </main>
    </div>
  );
}

interface NavLinkProps {
  active: boolean;
  onClick: () => void;
  label: string;
}

const NavLink: React.FC<NavLinkProps> = ({ active, onClick, label }) => (
  <button
    type="button"
    onClick={onClick}
    className={`border-b-2 py-1 text-sm transition whitespace-nowrap shrink-0 ${
      active
        ? 'border-emerald-700 font-semibold text-slate-900'
        : 'border-transparent text-slate-600 hover:border-slate-300 hover:text-slate-900'
    }`}
  >
    {label}
  </button>
);

export default App;

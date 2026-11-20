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
  const [apiToken, setApiToken] = useState('');
  const [launchConfig, setLaunchConfig] = useState<LaunchMissionConfig | null>(null);

  const handleLaunchRover = (config: LaunchMissionConfig) => {
    setLaunchConfig(config);
    setTab('LIVE');
  };

  const toggleLanguage = () => {
    setLang((prev) => (prev === 'EN' ? 'BN' : 'EN'));
  };

  return (
    <div className="flex min-h-screen flex-col bg-[#F8FAFC] text-[#0F172A]">
      {/* Strict 3-Zone Top Bar: Wordmark — 4 Concise Single-Line Nav Links — 1 Primary Action */}
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-8 px-4 sm:px-6">
          <button
            type="button"
            onClick={() => setTab('CAPTURE')}
            className="text-base font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
          >
            {Strings.appTitle(lang)}
          </button>

          <nav
            aria-label="Primary navigation"
            className="flex items-center gap-6 text-sm font-medium min-w-0"
          >
            <NavLink
              active={tab === 'CAPTURE'}
              onClick={() => setTab('CAPTURE')}
              label={lang === 'BN' ? 'লঞ্চ' : 'Launch'}
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
              label={lang === 'BN' ? 'পরিচিতি' : 'About'}
            />
          </nav>

          <button
            type="button"
            onClick={toggleLanguage}
            aria-label="Switch language"
            className="rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-slate-800 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
          >
            {lang === 'EN' ? 'বাংলা' : 'English'}
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">
        {tab === 'CAPTURE' && (
          <CaptureLaunchScreen
            lang={lang}
            piHost={piHost}
            onPiHostChange={setPiHost}
            apiToken={apiToken}
            onApiTokenChange={setApiToken}
            onLaunchRover={handleLaunchRover}
          />
        )}
        {tab === 'LIVE' && (
          <LiveRoverStreamScreen
            lang={lang}
            piHost={piHost}
            onPiHostChange={setPiHost}
            apiToken={apiToken}
            onApiTokenChange={setApiToken}
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
    className={`border-b-2 py-1 text-sm transition whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 ${
      active
        ? 'border-emerald-700 font-semibold text-slate-900'
        : 'border-transparent text-slate-600 hover:border-slate-300 hover:text-slate-900'
    }`}
  >
    {label}
  </button>
);

export default App;

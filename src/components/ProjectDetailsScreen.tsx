import React, { useState } from 'react';
import { Film, X } from 'lucide-react';
import { AppLanguage } from '../i18n/strings';
import { Chassis3DViewer } from './Chassis3DViewer';

interface Props {
  lang: AppLanguage;
}

export const ProjectDetailsScreen: React.FC<Props> = ({ lang }) => {
  const isBn = lang === 'BN';
  const [activeVideo, setActiveVideo] = useState<'mission' | 'blender' | null>(null);

  const specs = isBn
    ? [
        ['কম্পিউটার', 'Raspberry Pi 5 (প্রধান ব্রেইন ও অ্যালগরিদম প্রসেসিং)'],
        ['ক্যামেরা', 'USB ডাউনওয়ার্ড-ফেসিং ক্যামেরা (আগাছা ও সারির X/Y লোকেশন)'],
        ['উচ্চতা সেন্সর', 'VL53L0X ToF সেন্সর (Z দূরত্বের যথার্থতা নিশ্চিতকরণ)'],
        ['কন্ট্রোলার', 'ESP32 (USB সিরিয়াল দিয়ে মোটর, সার্ভো ও লেজার ড্রাইভ)'],
        ['মোটর ড্রাইভ', 'L298N এইচ-ব্রিজ ও ডিসি গিয়ার মোটর (বাম ও ডান চাকা)'],
        ['গিম্বল', '২x SG90 প্যান-টিল্ট মাইক্রো সার্ভো (লেজার নিশানা)'],
        ['সুরক্ষা ব্যবস্থা', 'GPIO ই-স্টপ বাটন এবং হার্ডওয়্যার ইন্টারলক সুইচ'],
      ]
    : [
        ['Main Computer', 'Raspberry Pi 5 (Python State Machine & Vision)'],
        ['Vision Sensor', 'Down-facing USB Camera (Weed & Row X/Y Localization)'],
        ['Distance Sensor', 'VL53L0X ToF sensor (Z-distance confirmation)'],
        ['Microcontroller', 'ESP32 via USB Serial (Motor, Servo & Laser execution)'],
        ['Motor Driver', 'L298N Dual H-Bridge + DC Gear Motors'],
        ['Targeting Gimbal', '2x SG90 Pan/Tilt Servos for Laser Aiming'],
        ['Safety Systems', 'Hardware E-Stop button and optical safety interlocks'],
      ];

  return (
    <div className="space-y-4">
      {/* Header Card */}
      <section className="rounded-2xl bg-[#A5D6A7] p-5 text-[#1B5E20]">
        <h2 className="text-lg font-bold">
          {isBn ? 'প্রজেক্ট পরিকল্পনা ও রোবট আর্কিটেকচার' : 'Project Architecture & Overview'}
        </h2>
        <p className="mt-1 text-sm">
          {isBn
            ? 'সেমি-অটোনোমাস লেজার উইডিং রোবট: দৃষ্টিভিত্তিক শনাক্তকরণ ও প্যান-টিল্ট লেজার ইলিমিনেশন সিস্টেম।'
            : 'Semi-Autonomous Weeding Robot: Vision-based detection, homography BEV mapping, and pan-tilt laser elimination.'}
        </p>
      </section>

      {/* 3D Chassis Viewer */}
      <Chassis3DViewer lang={lang} />

      {/* Demo Videos */}
      <section className="space-y-3 rounded-2xl border border-[#DCE5D7] bg-white p-4 shadow-xs">
        <div className="flex items-center gap-2">
          <Film className="h-4 w-4 text-[#2E7D32]" />
          <h3 className="text-base font-bold text-[#1C1D1A]">
            {isBn ? 'সিমুলেশন ও ডেমো ভিডিও (Demo Videos)' : 'Simulation & Demo Videos'}
          </h3>
        </div>

        {activeVideo ? (
          <div className="overflow-hidden rounded-xl bg-black">
            <video
              key={activeVideo}
              src={
                activeVideo === 'mission'
                  ? '/media/field_sim_mission.mp4'
                  : '/media/rover_weeding_anim.mp4'
              }
              controls
              autoPlay
              loop
              playsInline
              className="max-h-[340px] w-full object-contain"
            />
          </div>
        ) : (
          <div className="relative h-[220px] overflow-hidden rounded-xl">
            <img
              src="/media/field_sim_mission_thumb.jpg"
              alt="Simulator Mission Preview"
              className="h-full w-full object-cover"
            />
            <div className="absolute inset-0 flex items-center justify-center bg-black/45 p-4 text-center">
              <span className="text-sm font-semibold text-white">
                {isBn
                  ? 'ভিডিও চালাতে নিচের যেকোনো বাটনে ক্লিক করুন'
                  : 'Select either demo video below to play'}
              </span>
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setActiveVideo('mission')}
            className={`flex-1 rounded-lg px-3 py-2 text-xs font-bold transition ${
              activeVideo === 'mission'
                ? 'bg-[#2E7D32] text-white'
                : 'border border-[#2E7D32] text-[#2E7D32] hover:bg-[#2E7D32]/10'
            }`}
          >
            {isBn ? '১. ফিল্ড মিশন সিম' : '1. Field Sim Mission'}
          </button>
          <button
            type="button"
            onClick={() => setActiveVideo('blender')}
            className={`flex-1 rounded-lg px-3 py-2 text-xs font-bold transition ${
              activeVideo === 'blender'
                ? 'bg-[#2E7D32] text-white'
                : 'border border-[#2E7D32] text-[#2E7D32] hover:bg-[#2E7D32]/10'
            }`}
          >
            {isBn ? '২. ৩ডি অ্যানিমেশন' : '2. 3D Blender Anim'}
          </button>
          {activeVideo && (
            <button
              type="button"
              onClick={() => setActiveVideo(null)}
              className="inline-flex items-center gap-1 rounded-lg border border-[#C6D3C1] px-3 py-2 text-xs font-semibold text-[#43483F] hover:bg-[#E2E7DD]/60"
            >
              <X className="h-3.5 w-3.5" />
              {isBn ? 'বন্ধ করুন' : 'Close'}
            </button>
          )}
        </div>
      </section>

      {/* Two Generations */}
      <section className="space-y-3 rounded-2xl border border-[#DCE5D7] bg-white p-4 shadow-xs">
        <h3 className="text-base font-bold text-[#1C1D1A]">
          {isBn
            ? 'রোবট বিবর্তন (Two Generations in One Repo)'
            : 'Robot Architecture Evolution'}
        </h3>
        <p className="text-sm text-[#1C1D1A]">
          {isBn
            ? '১. প্রথম প্রজন্ম (Project-RIPRA / Weed_Detection): রেইলের উপর গ্যান্ট্রি (Gantry on rails)। ক্যামেরা আগাছা চিহ্নিত করে এবং X/Y অক্ষে সরে ৩ সেমি দূর থেকে লেজার ফায়ার করে।'
            : '1. Gen 1 (Project-RIPRA / Gantry): Gantry on rails with G-code steppers. Camera detects weeds, gantry moves in X/Y, fixed laser fires at 3cm.'}
        </p>
        <hr className="border-[#E2E7DD]" />
        <p className="text-sm text-[#1C1D1A]">
          {isBn
            ? '২. বর্তমান প্রজন্ম (Navigation/ Wheeled Rover): চাকাযুক্ত স্বয়ংক্রিয় রোভার যা ফসলের সারির মাঝে চলে। এটি Stop → Scan → Aim → Fire → Move চক্রে কাজ করে। এতে আছে প্যান-টিল্ট লেজার গিম্বল এবং দূরত্বের সত্যতা নিশ্চিতকরণে আল্ট্রাসনিক/ToF সেন্সর।'
            : '2. Gen 2 (Navigation/ Wheeled Rover): Autonomous wheeled rover operating in a Stop → Scan → Aim → Fire → Move loop, pan-tilt gimbal targeting, and VL53L0X ToF / Ultrasonic distance confirmation.'}
        </p>
      </section>

      {/* Hardware Stack */}
      <section className="space-y-2 rounded-2xl border border-[#DCE5D7] bg-white p-4 shadow-xs">
        <h3 className="text-base font-bold text-[#1C1D1A]">
          {isBn ? 'হার্ডওয়্যার স্ট্যাক (Target Hardware)' : 'Target Hardware Stack'}
        </h3>
        <div className="divide-y divide-[#E2E7DD]">
          {specs.map(([k, v]) => (
            <div key={k} className="grid grid-cols-1 gap-1 py-2 text-xs sm:grid-cols-3">
              <div className="font-bold text-[#1C1D1A]">{k}</div>
              <div className="text-[#43483F] sm:col-span-2">{v}</div>
            </div>
          ))}
        </div>
      </section>

      {/* State Machine Cycle */}
      <section className="space-y-2 rounded-2xl border border-[#DCE5D7] bg-white p-4 shadow-xs">
        <h3 className="text-base font-bold text-[#1C1D1A]">
          {isBn ? 'রোবটের স্টেট মেশিন সাইকেল' : 'Rover State Machine Cycle'}
        </h3>
        <p className="text-sm text-[#43483F]">
          {isBn
            ? 'IDLE ──► FORWARD ──► STOP ──► SCAN (ক্যামেরা ছবি তোলে) ──► AIM (প্যান-টিল্ট গিম্বল নিশানায় যায়) ──► FIRE (ToF নিশ্চিত করে লেজার ফায়ার হয়) ──► সারির শেষে ROTATE এবং পরবর্তী সারিতে প্রবেশ।'
            : 'IDLE ──► FORWARD ──► STOP ──► SCAN (Camera frame) ──► AIM (Pan-tilt to weed coordinates) ──► FIRE (ToF confirms Z, laser activates) ──► Repeat for frame ──► ROTATE at row end.'}
        </p>
      </section>
    </div>
  );
};

import React from 'react';
import { ExternalLink } from 'lucide-react';
import { AppLanguage } from '../i18n/strings';

interface Props {
  lang: AppLanguage;
}

export const AboutDeveloperScreen: React.FC<Props> = ({ lang }) => {
  const isBn = lang === 'BN';
  const githubUrl = 'https://github.com/BayazidHabibSiddikee/Semi-Autonomous-Weeding-Robot';

  const techItems = [
    ['Mobile', 'Kotlin, Jetpack Compose, OpenCV 4.10.0, Koin DI'],
    ['Computer Vision', 'Homography Matrix, ExG + HSV Green Segmentation, Contour Extraction'],
    ['Path Planning', 'Boustrophedon Coverage, Headland Turns, Metric Waypoint Sequencing'],
    ['Hardware', 'Raspberry Pi 5, ESP32, VL53L0X ToF, L298N, Pan/Tilt Servos, Laser Diode'],
    ['Simulation', 'Python Virtual Field Simulator, Web Canvas Twin & Blender 3D Rig'],
  ];

  return (
    <div className="space-y-4">
      {/* Profile Card */}
      <section className="flex flex-col items-center rounded-2xl bg-[#A5D6A7] p-6 text-center text-[#1B5E20]">
        <img
          src="/media/developer_photo.jpg"
          alt="Bayazid Habib Siddikee"
          className="h-24 w-24 rounded-full border-4 border-[#2E7D32] object-cover shadow-xs"
        />
        <h2 className="mt-3 text-lg font-bold">Bayazid Habib Siddikee</h2>
        <p className="text-sm font-medium opacity-90">
          Mechatronics Engineering (MTE), Rajshahi University of Engineering &amp; Technology (RUET)
        </p>
        <p className="mt-0.5 text-xs opacity-80">2208053.mte.ruet@gmail.com</p>
      </section>

      {/* Motivation */}
      <section className="space-y-2.5 rounded-2xl border border-[#DCE5D7] bg-white p-4 shadow-xs">
        <h3 className="text-base font-bold text-[#2E7D32]">
          {isBn ? 'আমি কেন এই প্রজেক্টটি করছি? (Why I am Doing This)' : 'Motivation & Vision'}
        </h3>
        <p className="text-sm text-[#1C1D1A]">
          {isBn
            ? 'কৃষিক্ষেত্রে রাসায়নিক আগাছানাশক (Chemical Herbicides) পরিবেশের মাটি, ভূগর্ভস্থ পানি এবং মানুষের খাদ্যে বিষক্রিয়া ছড়াচ্ছে। অন্যদিকে কায়িক শ্রমে আগাছা নিড়ানো অত্যন্ত ব্যয়বহুল ও ধীরগতির।'
            : 'Chemical herbicides pollute soil, ground water, and crop yield, while manual weeding is prohibitively labor-intensive and expensive.'}
        </p>
        <p className="text-sm text-[#1C1D1A]">
          {isBn
            ? 'এই সমস্যার টেকসই সমাধানে মেকাট্রনিক্স ও কম্পিউটার ভিশনের সমন্বয়ে এই সেমি-অটোনোমাস লেজার উইডিং রোবট তৈরি করা হচ্ছে। স্মার্টফোন দিয়ে উপর থেকে সাধারণ ছবি তুলেই জমির সার্বিক পথ নির্ধারণ করা এবং রোবটের নিখুঁত লেজার রশ্মির সাহায্যে রাসায়নিকমুক্ত, পরিবেশবান্ধব উপায়ে প্রতিটি ক্ষতিকর আগাছা ধ্বংস করাই এই গবেষণার মূল লক্ষ্য।'
            : 'This project bridges Mechatronics, Computer Vision, and Embedded Robotics to create a sustainable, zero-chemical alternative: an autonomous rover that drives crop rows and vaporizes unwanted weeds using concentrated laser optics.'}
        </p>
      </section>

      {/* Repository */}
      <section className="space-y-2.5 rounded-2xl border border-[#DCE5D7] bg-white p-4 shadow-xs">
        <h3 className="text-base font-bold text-[#1C1D1A]">
          {isBn ? 'গিটহাব ওপেন সোর্স রিপোজিটরি' : 'Open-Source Repository'}
        </h3>
        <div className="text-sm font-semibold text-[#1C1D1A]">Semi-Autonomous-Weeding-Robot</div>
        <p className="text-xs text-[#43483F]">
          {isBn
            ? 'সম্পূর্ণ ওপেন-সোর্স কোডবেস: রোবটের স্টেট মেশিন, ESP32 ফার্মওয়্যার, ব্লেন্ডার ৩ডি অ্যানিমেশন, সিমুলেটর এবং অ্যান্ড্রয়েড BEV মিশন প্ল্যানার অ্যাপ।'
            : 'Full open-source codebase containing rover navigation, ESP32 firmware, Blender 3D simulation, and the Android Kotlin BEV planner app.'}
        </p>
        <a
          href={githubUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#2E7D32] px-4 py-2.5 text-xs font-bold text-white hover:bg-[#1B5E20]"
        >
          <ExternalLink className="h-4 w-4" />
          {isBn ? 'গিটহাবে দেখুন (View on GitHub)' : 'Open GitHub Repository'}
        </a>
      </section>

      {/* Tech Stack */}
      <section className="space-y-2 rounded-2xl border border-[#DCE5D7] bg-white p-4 shadow-xs">
        <h3 className="text-base font-bold text-[#1C1D1A]">
          {isBn ? 'প্রযুক্তিগত বৈশিষ্ট্য (Tech Stack)' : 'Technical Stack'}
        </h3>
        <div className="divide-y divide-[#E2E7DD]">
          {techItems.map(([title, desc]) => (
            <div key={title} className="grid grid-cols-1 gap-1 py-2 text-xs sm:grid-cols-3">
              <div className="font-bold text-[#1C1D1A]">{title}</div>
              <div className="text-[#43483F] sm:col-span-2">{desc}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};

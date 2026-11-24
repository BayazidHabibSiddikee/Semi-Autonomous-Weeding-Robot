package com.weedlaser.bev.presentation

import androidx.compose.runtime.compositionLocalOf

enum class AppLanguage {
    EN, BN
}

val LocalAppLanguage = compositionLocalOf { AppLanguage.BN }

object Strings {
    // Top Bar & Navigation
    fun appTitle(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "নিড়ানি রোবট"
        AppLanguage.EN -> "Weeding Robot"
    }

    fun appSubtitle(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "স্বয়ংক্রিয় আগাছা দমন রোভার"
        AppLanguage.EN -> "Semi-Autonomous Weeding Robot"
    }

    fun navLaunch(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "শুরু করুন"
        AppLanguage.EN -> "Launch"
    }

    fun navLive(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "লাইভ রোভার"
        AppLanguage.EN -> "Live Feed"
    }

    fun navProject(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "প্রজেক্ট বিবরণী"
        AppLanguage.EN -> "Project"
    }

    fun navAbout(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "পরিচিতি"
        AppLanguage.EN -> "About"
    }

    // Connection & Hotspot Controls
    fun piIpLabel(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "রাস্পবেরি পাই IP"
        AppLanguage.EN -> "Raspberry Pi IP"
    }

    fun piPortLabel(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "পোর্ট"
        AppLanguage.EN -> "Port"
    }

    fun apiTokenLabel(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "Pi নিরাপত্তা টোকেন (Bearer Token)"
        AppLanguage.EN -> "Pi Security Token (Bearer)"
    }

    fun bindWifiButton(lang: AppLanguage, bound: Boolean) = when (lang) {
        AppLanguage.BN -> if (bound) "Pi Wi-Fi যুক্ত" else "Pi Wi-Fi বাইন্ড"
        AppLanguage.EN -> if (bound) "Pi Wi-Fi Bound" else "Bind Pi Wi-Fi"
    }

    fun discoverPiButton(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "Pi খুঁজুন"
        AppLanguage.EN -> "Discover Pi"
    }

    // Launch Screen — Zero-Corner BEV + Start/End
    fun step1Header(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "১. জমির ছবি তুলুন ও ২টি বিন্দু নির্বাচন করুন"
        AppLanguage.EN -> "1. Snap Field Photo & Tap Start / End"
    }

    fun snapPhoto(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "ছবি তুলুন"
        AppLanguage.EN -> "Snap Photo"
    }

    fun pickPhoto(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "গ্যালারি"
        AppLanguage.EN -> "Pick Photo"
    }

    fun reuploadToPi(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "Pi-তে আবার পাঠান"
        AppLanguage.EN -> "Upload to Pi"
    }

    fun emptyMapHint(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "১টি জমির ছবি তুলুন — Pi স্বয়ংক্রিয়ভাবে সীমানা কেটে টপ-ডাউন BEV ম্যাপ তৈরি করবে"
        AppLanguage.EN -> "Snap 1 field photo — Pi auto-warps boundaries into a top-down BEV map"
    }

    fun tapStartMode(lang: AppLanguage, active: Boolean) = when (lang) {
        AppLanguage.BN -> if (active) "• শুরু বিন্দু ট্যাপ করুন" else "শুরু বিন্দু (Start)"
        AppLanguage.EN -> if (active) "• Tap Start Point" else "Set Start"
    }

    fun tapEndMode(lang: AppLanguage, active: Boolean) = when (lang) {
        AppLanguage.BN -> if (active) "• শেষ বিন্দু ট্যাপ করুন" else "শেষ বিন্দু (End)"
        AppLanguage.EN -> if (active) "• Tap End Point" else "Set End"
    }

    fun clearEnd(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "মুছুন"
        AppLanguage.EN -> "Clear"
    }

    fun bevCoordinateLegend(lang: AppLanguage, isPiBev: Boolean) = when (lang) {
        AppLanguage.BN -> if (isPiBev) {
            "Pi টপ-ডাউন BEV ম্যাপ · সবুজ = শুরু (Start) · লাল = শেষ (End, ঐচ্ছিক)"
        } else {
            "লোকাল BEV প্রিভিউ (অফলাইন) · শুরু করতে Pi হটস্পটে ছবি আপলোড করুন"
        }
        AppLanguage.EN -> if (isPiBev) {
            "Pi Top-Down BEV Map · Green = Start · Red = End (optional)"
        } else {
            "Local BEV preview (offline) · Upload to Pi hotspot before launching"
        }
    }

    fun tapToPlaceStartHint(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "ম্যাপের যেকোনো ফুরো (হলুদ রেখা)-র মুখে ট্যাপ করে রোবটের শুরুর অবস্থান দিন"
        AppLanguage.EN -> "Tap on a furrow entrance (yellow line) to place the Rover Start pin"
    }

    fun relayNavOnly(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "শুধু নেভিগেশন (নিরাপদ)"
        AppLanguage.EN -> "Nav Only (Safe)"
    }

    fun relayGrinder(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "রিলে ১: গ্রাইন্ডার"
        AppLanguage.EN -> "Relay 1: Grinder"
    }

    fun relayFlame(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "রিলে ২: ফ্লেম"
        AppLanguage.EN -> "Relay 2: Flame"
    }

    fun relayDual(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "ডুয়াল রিলে"
        AppLanguage.EN -> "Dual Relay"
    }

    fun treatmentInterlockHint(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "ট্রিটমেন্ট মোড চালু করতে Pi-তে যাচাইকৃত YOLO মডেল ও হোমোগ্রাফি ক্যালিব্রেশন প্রয়োজন।"
        AppLanguage.EN -> "Treatment modes require verified weed model weights and homography calibration loaded on the Pi."
    }

    fun operatorConfirmLabel(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "আমি নিশ্চিত করছি যে রোভারের আশেপাশে নিরাপদ এবং হার্ডওয়্যার E-STOP হাতের নাগালে আছে।"
        AppLanguage.EN -> "I confirm the path is clear and the physical hardware E-STOP is within reach."
    }

    fun launchMissionButton(lang: AppLanguage, busy: Boolean) = when (lang) {
        AppLanguage.BN -> if (busy) "Pi-তে পাঠানো হচ্ছে..." else "রোভার মিশন চালু করুন (লাইভ দেখুন)"
        AppLanguage.EN -> if (busy) "Starting Mission..." else "Start Rover Mission (Open Live)"
    }

    fun launchDisabledHint(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "মিশন চালু করতে: ১) Pi-তে ছবি আপলোড সম্পন্ন (>=৪৫% আত্মবিশ্বাস ও সারি শনাক্ত), ২) শুরু বিন্দু নির্বাচন এবং ৩) অপারেটর নিরাপত্তা নিশ্চিত করুন।"
        AppLanguage.EN -> "To launch: 1) Upload photo to Pi (>=45% confidence with furrows), 2) tap a Start point on the BEV map, and 3) check operator confirmation."
    }

    // Live Monitor Screen
    fun liveCameraHeader(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "লাইভ রোভার ক্যামেরা (/video_feed)"
        AppLanguage.EN -> "Live Rover Camera (/video_feed)"
    }

    fun liveMapHeader(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "লাইভ জমির ম্যাপ (/map_feed)"
        AppLanguage.EN -> "Live Field Map (/map_feed)"
    }

    fun liveTelemetryHeader(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "ESP32 ও সেন্সর টেলিমেট্রি (/cut_plan)"
        AppLanguage.EN -> "ESP32 & Sensor Telemetry (/cut_plan)"
    }

    fun reconnectStreams(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "ভিডিও পুনরায় সংযোগ"
        AppLanguage.EN -> "Reconnect Feeds"
    }

    fun eStopLabel(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "জরুরি থামুন (E-STOP)"
        AppLanguage.EN -> "EMERGENCY STOP (E-STOP)"
    }

    fun eStopSending(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "থামানোর সংকেত পাঠানো হচ্ছে..."
        AppLanguage.EN -> "SENDING STOP..."
    }

    fun connectedStatus(lang: AppLanguage, host: String, state: String) = when (lang) {
        AppLanguage.BN -> "Pi সংযুক্ত ($host) · অবস্থা: $state"
        AppLanguage.EN -> "Connected to Pi ($host) · State: $state"
    }

    fun offlineStatus(lang: AppLanguage, host: String, detail: String) = when (lang) {
        AppLanguage.BN -> "Pi অফলাইন ($host) · $detail"
        AppLanguage.EN -> "Waiting for Pi ($host) · $detail"
    }

    fun hardwareBenchNotice(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "বেঞ্চ মোড: ফিজিক্যাল ক্যামেরা বা ESP32 সিরিয়াল সংযুক্ত নয়"
        AppLanguage.EN -> "Bench Mode: physical camera or ESP32 UART not attached"
    }
}

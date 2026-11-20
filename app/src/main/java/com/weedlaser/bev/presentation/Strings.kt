package com.weedlaser.bev.presentation

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue

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

    fun navPlanner(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "পথ পরিকল্পনা"
        AppLanguage.EN -> "Path Planner"
    }

    fun navProject(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "প্রজেক্ট বিবরণী ও ভিডিও"
        AppLanguage.EN -> "Project & Demo"
    }

    fun navAbout(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "পরিচিতি ও লক্ষ্য"
        AppLanguage.EN -> "About Developer"
    }

    // Step 1: Photo & Corners
    fun step1Title(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "১. জমির ছবি ও চার কোণা নির্বাচন"
        AppLanguage.EN -> "1. Field Photo & 4 Corners"
    }

    fun pickPhoto(lang: AppLanguage, hasPhoto: Boolean) = when (lang) {
        AppLanguage.BN -> if (!hasPhoto) "ছবি নির্বাচন করুন (Pick Photo)" else "ছবি পরিবর্তন করুন (Change Photo)"
        AppLanguage.EN -> if (!hasPhoto) "Pick Field Photo" else "Change Photo"
    }

    fun noPhotoSelected(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "কোনো ছবি নির্বাচন করা হয়নি। গ্যালারি থেকে ছবি নিন।"
        AppLanguage.EN -> "No photo selected. Please choose a field image from gallery."
    }

    fun dragHandleHint(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "চারটি বৃত্তাকার পিন স্পর্শ করে জমির ৪টি কোণায় টেনে আনুন (TL, TR, BR, BL)"
        AppLanguage.EN -> "Touch and drag the 4 circular handles to field corners (TL, TR, BR, BL)"
    }

    // Step 2: Field Config
    fun step2Title(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "২. জমির পরিমাপ ও বিন্যাস"
        AppLanguage.EN -> "2. Field Dimensions & Configuration"
    }

    fun widthLabel(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "প্রস্থ (Width m)"
        AppLanguage.EN -> "Width (meters)"
    }

    fun lengthLabel(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "দৈর্ঘ্য (Length m)"
        AppLanguage.EN -> "Length (meters)"
    }

    fun totalRowsLabel(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "মোট সারি (Rows)"
        AppLanguage.EN -> "Total Rows"
    }

    fun rowSpacingLabel(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "সারির দূরত্ব (Spacing m)"
        AppLanguage.EN -> "Row Spacing (meters)"
    }

    // Step 3: Generation & Export
    fun generateMission(lang: AppLanguage, isProcessing: Boolean) = when (lang) {
        AppLanguage.BN -> if (isProcessing) "প্রসেসিং চলছে..." else "৩. স্বয়ংক্রিয় পথ পরিকল্পনা তৈরি করুন"
        AppLanguage.EN -> if (isProcessing) "Generating Mission..." else "3. Generate Boustrophedon Mission"
    }

    fun missionReady(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "মিশন প্রস্তুত (Mission Ready)"
        AppLanguage.EN -> "Mission Generated Successfully"
    }

    fun sendToPi(lang: AppLanguage, ip: String) = when (lang) {
        AppLanguage.BN -> "রোবটে পাঠান ($ip)"
        AppLanguage.EN -> "Send to Robot ($ip)"
    }

    fun copyJson(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "মিশন JSON কপি করুন"
        AppLanguage.EN -> "Copy Mission JSON"
    }

    fun jsonCopied(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "মিশন JSON ক্লিপবোর্ডে কপি হয়েছে!"
        AppLanguage.EN -> "Mission JSON copied to clipboard!"
    }

    fun idleHint(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "এখনো কোনো মিশন তৈরি হয়নি। উপরে জমির ছবি নিয়ে ৪টি কোণা চিহ্নিত করুন।"
        AppLanguage.EN -> "No mission yet. Select a field photo and drag the 4 corner handles above."
    }

    fun retry(lang: AppLanguage) = when (lang) {
        AppLanguage.BN -> "পুনরায় চেষ্টা করুন (Retry)"
        AppLanguage.EN -> "Retry"
    }
}

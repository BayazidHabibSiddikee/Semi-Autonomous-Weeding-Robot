package com.weedlaser.bev.presentation

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Divider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
fun AboutDeveloperScreen() {
    val lang = LocalAppLanguage.current
    val context = LocalContext.current
    val isBn = (lang == AppLanguage.BN)

    val githubUrl = "https://github.com/BayazidHabibSiddikee/Semi-Autonomous-Weeding-Robot"
    val developerName = "Bayazid Habib Siddikee"
    val developerEmail = "2208053.mte.ruet@gmail.com"
    val institution = "Rajshahi University of Engineering & Technology (RUET)"
    val department = "Mechatronics Engineering (MTE)"

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        // Profile Card
        Card(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(16.dp),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)
        ) {
            Column(
                modifier = Modifier.padding(20.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Box(
                    modifier = Modifier
                        .size(72.dp)
                        .clip(CircleShape)
                        .background(MaterialTheme.colorScheme.primary),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        "BH",
                        fontSize = 28.sp,
                        fontWeight = FontWeight.Bold,
                        color = Color.White
                    )
                }

                Spacer(Modifier.height(12.dp))

                Text(
                    text = developerName,
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onPrimaryContainer
                )

                Text(
                    text = "$department, $institution",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.85f)
                )

                Text(
                    text = developerEmail,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.75f)
                )
            }
        }

        // Mission & Purpose Card
        Card(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(16.dp)
        ) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    text = if (isBn) "🎯 আমি কেন এই প্রজেক্টটি করছি? (Why I'm Doing This)" else "🎯 Motivation & Vision",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.primary
                )

                Text(
                    text = if (isBn)
                        "কৃষিক্ষেত্রে রাসায়নিক আগাছানাশক (Chemical Herbicides) পরিবেশের মাটি, ভূগর্ভস্থ পানি এবং মানুষের খাদ্যে বিষক্রিয়া ছড়াচ্ছে। অন্যদিকে কায়িক শ্রমে আগাছা নিড়ানো অত্যন্ত ব্যয়বহুল ও ধীরগতির।"
                    else
                        "Chemical herbicides pollute soil, ground water, and crop yield, while manual weeding is prohibitively labor-intensive and expensive.",
                    style = MaterialTheme.typography.bodyMedium
                )

                Text(
                    text = if (isBn)
                        "এই সমস্যার টেকসই সমাধানে মেকাট্রনিক্স ও কম্পিউটার ভিশনের সমন্বয়ে এই সেমি-অটোনোমাস লেজার উইডিং রোবট তৈরি করা হচ্ছে। স্মার্টফোন দিয়ে উপর থেকে সাধারণ ছবি তুলেই জমির সার্বিক পথ নির্ধারণ করা এবং রোবটের নিখুঁত লেজার রশ্মির সাহায্যে রাসায়নিকমুক্ত, পরিবেশবান্ধব উপায়ে প্রতিটি ক্ষতিকর আগাছা ধ্বংস করাই আমার এই গবেষণার মূল লক্ষ্য।"
                    else
                        "This project bridges Mechatronics, Computer Vision, and Embedded Robotics to create a sustainable, zero-chemical alternative: an autonomous rover that drives crop rows and vaporizes unwanted weeds using concentrated laser optics.",
                    style = MaterialTheme.typography.bodyMedium
                )
            }
        }

        // Repository & Source Info
        Card(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(16.dp)
        ) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    text = if (isBn) "📂 গিটহাব ওপেন সোর্স রিপোজিটরি" else "📂 Open-Source Repository",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold
                )

                Text(
                    text = "Semi-Autonomous-Weeding-Robot",
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.SemiBold
                )

                Text(
                    text = if (isBn)
                        "সম্পূর্ণ ওপেন-সোর্স কোডবেস: রোবটের স্টেট মেশিন, ESP32 ফার্মওয়্যার, ব্লেন্ডার ৩ডি অ্যানিমেশন, সিমুলেটর এবং এই অ্যান্ড্রয়েড BEV মিশন প্ল্যানার অ্যাপ।"
                    else
                        "Full open-source codebase containing rover navigation, ESP32 firmware, Blender 3D simulation, and this Android BEV planner app.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )

                Button(
                    onClick = {
                        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(githubUrl))
                        context.startActivity(intent)
                    },
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(if (isBn) "🌐 গিটহাবে দেখুন (View on GitHub)" else "🌐 Open GitHub Repository")
                }
            }
        }

        // Technical Highlights
        Card(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(16.dp)
        ) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    text = if (isBn) "⚡ প্রযুক্তিগত বৈশিষ্ট্য (Tech Stack)" else "⚡ Technical Stack",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold
                )

                val items = listOf(
                    "Mobile" to "Kotlin, Jetpack Compose, OpenCV 4.10.0, Koin DI",
                    "Computer Vision" to "Homography Matrix, HSV Green Segmentation, Contour Extraction",
                    "Path Planning" to "Boustrophedon Coverage, Dubins Turns, Metric Waypoint Sequencing",
                    "Hardware" to "Raspberry Pi 5, ESP32, VL53L0X ToF, L298N, Pan/Tilt Servos, Laser Diode",
                    "Simulation" to "Python Pygame Virtual Field & Blender 3D Rig"
                )

                items.forEach { (title, desc) ->
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Text(title, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(0.35f))
                        Text(desc, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(0.65f))
                    }
                }
            }
        }

        Spacer(Modifier.height(16.dp))
    }
}

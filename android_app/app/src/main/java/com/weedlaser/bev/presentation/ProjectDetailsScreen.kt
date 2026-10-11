package com.weedlaser.bev.presentation

import android.net.Uri
import android.widget.MediaController
import android.widget.VideoView
import androidx.compose.foundation.Image
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Divider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.weedlaser.bev.R

@Composable
fun ProjectDetailsScreen() {
    val lang = LocalAppLanguage.current
    val context = LocalContext.current
    val isBn = (lang == AppLanguage.BN)

    var currentVideoRes by remember { mutableStateOf<Int?>(null) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        // Header Card
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer),
            shape = RoundedCornerShape(16.dp)
        ) {
            Column(Modifier.padding(16.dp)) {
                Text(
                    text = if (isBn) "প্রজেক্ট পরিকল্পনা ও রোবট আর্কিটেকচার" else "Project Architecture & Overview",
                    style = MaterialTheme.typography.titleLarge,
                    color = MaterialTheme.colorScheme.onPrimaryContainer,
                    fontWeight = FontWeight.Bold
                )
                Spacer(Modifier.height(6.dp))
                Text(
                    text = if (isBn)
                        "সেমি-অটোনোমাস লেজার উইডিং রোবট: দৃষ্টিভিত্তিক শনাক্তকরণ ও প্যান-টিল্ট লেজার ইলিমিনেশন সিস্টেম।"
                    else
                        "Semi-Autonomous Weeding Robot: Vision-based detection, homography BEV mapping, and pan-tilt laser elimination.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onPrimaryContainer
                )
            }
        }

        // Demo Videos Section
        Card(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(16.dp),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
        ) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    text = if (isBn) "🎥 সিমুলেশন ও ডেমো ভিডিও (Demo Videos)" else "🎥 Simulation & Demo Videos",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold
                )

                // Video Player Container
                if (currentVideoRes != null) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(240.dp)
                            .clip(RoundedCornerShape(12.dp))
                            .background(Color.Black),
                        contentAlignment = Alignment.Center
                    ) {
                        AndroidView(
                            factory = { ctx ->
                                VideoView(ctx).apply {
                                    val mc = MediaController(ctx)
                                    mc.setAnchorView(this)
                                    setMediaController(mc)
                                    val uri = Uri.parse("android.resource://${ctx.packageName}/${currentVideoRes!!}")
                                    setVideoURI(uri)
                                    setOnPreparedListener { mp ->
                                        mp.isLooping = true
                                        start()
                                    }
                                }
                            },
                            update = { view ->
                                val uri = Uri.parse("android.resource://${context.packageName}/${currentVideoRes!!}")
                                view.setVideoURI(uri)
                                view.start()
                            },
                            modifier = Modifier.fillMaxSize()
                        )
                    }
                } else {
                    // Thumbnail preview
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(200.dp)
                            .clip(RoundedCornerShape(12.dp))
                    ) {
                        Image(
                            painter = painterResource(id = R.drawable.field_sim_mission_thumb),
                            contentDescription = "Simulator Mission Preview",
                            modifier = Modifier.fillMaxSize(),
                            contentScale = ContentScale.Crop
                        )
                        Box(
                            modifier = Modifier
                                .fillMaxSize()
                                .background(Color(0x55000000)),
                            contentAlignment = Alignment.Center
                        ) {
                            Text(
                                if (isBn) "ভিডিও চালাতে নিচের যেকোনো বাটনে ট্যাপ করুন" else "Tap either video button below to play",
                                color = Color.White,
                                style = MaterialTheme.typography.bodyMedium,
                                fontWeight = FontWeight.SemiBold
                            )
                        }
                    }
                }

                // Video selection buttons
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Button(
                        onClick = { currentVideoRes = R.raw.field_sim_mission },
                        modifier = Modifier.weight(1f),
                        colors = if (currentVideoRes == R.raw.field_sim_mission)
                            ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.primary)
                        else
                            ButtonDefaults.outlinedButtonColors()
                    ) {
                        Text(if (isBn) "১. ফিল্ড মিশন সিম" else "1. Field Sim Mission", fontSize = 12.sp)
                    }

                    Button(
                        onClick = { currentVideoRes = R.raw.rover_weeding_anim },
                        modifier = Modifier.weight(1f),
                        colors = if (currentVideoRes == R.raw.rover_weeding_anim)
                            ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.primary)
                        else
                            ButtonDefaults.outlinedButtonColors()
                    ) {
                        Text(if (isBn) "২. ৩ডি অ্যানিমেশন" else "2. 3D Blender Anim", fontSize = 12.sp)
                    }
                }

                if (currentVideoRes != null) {
                    OutlinedButton(
                        onClick = { currentVideoRes = null },
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text(if (isBn) "ভিডিও বন্ধ করুন (Close Video)" else "Close Player")
                    }
                }
            }
        }

        // Two Generations / Architecture Evolution
        Card(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(16.dp)
        ) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    text = if (isBn) "🔄 রোবট বিবর্তন (Two Generations in One Repo)" else "🔄 Robot Architecture Evolution",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold
                )

                Text(
                    text = if (isBn)
                        "১. প্রথম প্রজন্ম (Project-RIPRA / Weed_Detection): রেইলের উপর গ্যান্ট্রি (Gantry on rails)। ক্যামেরা আগাছা চিহ্নিত করে এবং X/Y অক্ষে সরে ৩ সেমি দূর থেকে লেজার ফায়ার করে।"
                    else
                        "1. Gen 1 (Project-RIPRA / Gantry): Gantry on rails with G-code steppers. Camera detects weeds, gantry moves in X/Y, fixed laser fires at 3cm.",
                    style = MaterialTheme.typography.bodyMedium
                )

                Divider()

                Text(
                    text = if (isBn)
                        "২. বর্তমান প্রজন্ম (Navigation/ Wheeled Rover): চাকাযুক্ত স্বয়ংক্রিয় রোভার যা ফসলের সারির মাঝে চলে। এটি 'Stop → Scan → Aim → Fire → Move' চক্রে কাজ করে। এতে আছে প্যান-টিল্ট লেজার গিম্বল এবং দূরত্বের সত্যতা নিশ্চিতকরণে আল্ট্রাসনিক/ToF সেন্সর।"
                    else
                        "2. Gen 2 (Navigation/ Wheeled Rover): Autonomous wheeled rover operating in a Stop → Scan → Aim → Fire → Move loop, pan-tilt gimbal targeting, and VL53L0X ToF / Ultrasonic distance confirmation.",
                    style = MaterialTheme.typography.bodyMedium
                )
            }
        }

        // Hardware Stack & Specs
        Card(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(16.dp)
        ) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    text = if (isBn) "⚙️ হার্ডওয়্যার স্ট্যাক (Target Hardware)" else "⚙️ Target Hardware Stack",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold
                )

                val specs = if (isBn) listOf(
                    "কম্পিউটার" to "Raspberry Pi 5 (প্রধান ব্রেইন ও অ্যালগরিদম প্রসেসিং)",
                    "ক্যামেরা" to "USB ডাউনওয়ার্ড-ফেসিং ক্যামেরা (আগাছা ও সারির X/Y লোকেশন)",
                    "উচ্চতা সেন্সর" to "VL53L0X ToF সেন্সর (Z দূরত্বের যথার্থতা নিশ্চিতকরণ)",
                    "কন্ট্রোলার" to "ESP32 (USB সিরিয়াল দিয়ে মোটর, সার্ভো ও লেজার ড্রাইভ)",
                    "মোটর ড্রাইভ" to "L298N এইচ-ব্রিজ ও ডিসি গিয়ার মোটর (বাম ও ডান চাকা)",
                    "গিম্বল" to "২x SG90 প্যান-টিল্ট মাইক্রো সার্ভো (লেজার নিশানা)",
                    "সুরক্ষা ব্যবস্থা" to "GPIO ই-স্টপ বাটন এবং হার্ডওয়্যার ইন্টারলক সুইচ"
                ) else listOf(
                    "Main Computer" to "Raspberry Pi 5 (Python State Machine & Vision)",
                    "Vision Sensor" to "Down-facing USB Camera (Weed & Row X/Y Localization)",
                    "Distance Sensor" to "VL53L0X ToF sensor (Z-distance confirmation)",
                    "Microcontroller" to "ESP32 via USB Serial (Motor, Servo & Laser execution)",
                    "Motor Driver" to "L298N Dual H-Bridge + DC Gear Motors",
                    "Targeting Gimbal" to "2x SG90 Pan/Tilt Servos for Laser Aiming",
                    "Safety Systems" to "Hardware E-Stop button and optical safety interlocks"
                )

                specs.forEach { (k, v) ->
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Text(k, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(0.35f))
                        Text(v, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(0.65f))
                    }
                }
            }
        }

        // State Machine Loop
        Card(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(16.dp)
        ) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    text = if (isBn) "🔄 রোবটের স্টেট মেশিন সাইকেল" else "🔄 Rover State Machine Cycle",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold
                )
                Text(
                    text = if (isBn)
                        "IDLE ──► FORWARD ──► STOP ──► SCAN (ক্যামেরা ছবি তোলে) ──► AIM (প্যান-টিল্ট গিম্বল নিশানায় যায়) ──► FIRE (ToF নিশ্চিত করে লেজার ফায়ার হয়) ──► সারির শেষে ROTATE এবং পরবর্তী সারিতে প্রবেশ।"
                    else
                        "IDLE ──► FORWARD ──► STOP ──► SCAN (Camera frame) ──► AIM (Pan-tilt to weed coordinates) ──► FIRE (ToF confirms Z, laser activates) ──► Repeat for frame ──► ROTATE at row end.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }

        Spacer(Modifier.height(16.dp))
    }
}

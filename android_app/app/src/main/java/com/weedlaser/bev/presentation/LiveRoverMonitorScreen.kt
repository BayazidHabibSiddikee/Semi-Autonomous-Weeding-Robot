package com.weedlaser.bev.presentation

import android.annotation.SuppressLint
import android.webkit.WebView
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.weedlaser.bev.data.remote.CutPlanTelemetry
import com.weedlaser.bev.data.remote.PiLiveClient
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Live Raspberry Pi FastAPI Stream Screen:
 *   - /video_feed : Live camera + weed stem targets + cut points + chlorosis alerts
 *   - /map_feed   : Live auto-BEV field map with rover pose & weeds
 *   - /cut_plan   : Live polled JSON telemetry (8-way ESP32 drive, MG996R turret -35..+35 deg,
 *                   Dual Relay Grinder/Flame, MaixSense wall distance, 30mm band cut queue)
 */
@Composable
fun LiveRoverMonitorScreen(
    piIp: String,
    piPort: Int,
    onPiIpChanged: (String) -> Unit,
    onPiPortChanged: (String) -> Unit,
) {
    val piClient = remember { PiLiveClient() }
    val scope = rememberCoroutineScope()
    var telemetry by remember { mutableStateOf(CutPlanTelemetry()) }
    var streamConnected by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(piIp, piPort) {
        while (true) {
            piClient.fetchCutPlan(piIp, piPort)
                .onSuccess {
                    telemetry = it
                    streamConnected = true
                    errorMessage = null
                }
                .onFailure { err ->
                    streamConnected = false
                    errorMessage = err.message
                }
            delay(400)
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        // Pi Host Connection + E-STOP bar
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            OutlinedTextField(
                value = piIp,
                onValueChange = onPiIpChanged,
                label = { Text("Pi IP") },
                singleLine = true,
                modifier = Modifier.weight(0.55f),
            )
            OutlinedTextField(
                value = piPort.toString(),
                onValueChange = onPiPortChanged,
                label = { Text("Port") },
                singleLine = true,
                modifier = Modifier.weight(0.25f),
            )
            Button(
                onClick = {
                    scope.launch { piClient.emergencyStop(piIp, piPort) }
                },
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFD32F2F)),
                modifier = Modifier.weight(0.35f).height(56.dp),
            ) {
                Text("E-STOP", color = Color.White, fontWeight = FontWeight.Bold)
            }
        }

        Text(
            text = if (streamConnected) {
                "Connected to Pi http://$piIp:$piPort · State: ${telemetry.state}"
            } else {
                "Waiting for Pi FastAPI stream at http://$piIp:$piPort (${errorMessage ?: "offline"})"
            },
            style = MaterialTheme.typography.bodySmall,
            color = if (streamConnected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
        )

        // Live /video_feed MJPEG stream
        Card(modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(12.dp)) {
            Column(Modifier.padding(10.dp)) {
                Text(
                    "Live Rover Camera (/video_feed)",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                )
                Spacer(Modifier.height(6.dp))
                MjpegStreamView(
                    url = piClient.videoFeedUrl(piIp, piPort),
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(220.dp)
                        .clip(RoundedCornerShape(8.dp)),
                )
            }
        }

        // Live /map_feed MJPEG stream
        Card(modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(12.dp)) {
            Column(Modifier.padding(10.dp)) {
                Text(
                    "Live Field Map (/map_feed)",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                )
                Spacer(Modifier.height(6.dp))
                MjpegStreamView(
                    url = piClient.mapFeedUrl(piIp, piPort),
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(200.dp)
                        .clip(RoundedCornerShape(8.dp)),
                )
            }
        }

        // Live /cut_plan JSON telemetry
        Card(modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(12.dp)) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    "ESP32 & Sensor Telemetry (/cut_plan)",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                )
                Text(
                    text = "Drive: ${telemetry.esp32DriveDeg?.let { "${it}°" } ?: "STOP"}  ·  Heading: ${"%.1f".format(telemetry.headingDeg)}°",
                    fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.bodySmall,
                )
                Text(
                    text = "MaixSense Furrow Offset: ${"%+.1f".format(telemetry.lateralOffsetMm)} mm  ·  Front Wall: ${"%.0f".format(telemetry.wallDistanceMm)} mm",
                    fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.bodySmall,
                )
                Text(
                    text = "MG996R Turret: ${"%+.1f".format(telemetry.turretAngleDeg)}° (-35°..+35°)  ·  Weeds Cut: ${telemetry.weedsEliminated}",
                    fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.bodySmall,
                )
                Text(
                    text = "Relay 1 (Grinder): ${if (telemetry.relay1Grinder) "ON" else "OFF"}  ·  Relay 2 (Thermal Flame): ${if (telemetry.relay2Flame) "ON" else "OFF"}",
                    fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.bodySmall,
                )
                Text(
                    text = "30mm Cut Queue: ${telemetry.cutQueue.size} targets  ·  Bad-Chili 3s Clips: ${telemetry.chlorosisClips.size}",
                    fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun MjpegStreamView(
    url: String,
    modifier: Modifier = Modifier,
) {
    Box(modifier = modifier.background(Color.Black)) {
        AndroidView(
            factory = { ctx ->
                WebView(ctx).apply {
                    settings.loadWithOverviewMode = true
                    settings.useWideViewPort = true
                    setBackgroundColor(android.graphics.Color.BLACK)
                }
            },
            update = { webView ->
                val html = """
                    <html><body style="margin:0;padding:0;background:#000;display:flex;align-items:center;justify-content:center;height:100vh;">
                    <img src="$url" style="max-width:100%;max-height:100%;object-fit:contain;" />
                    </body></html>
                """.trimIndent()
                webView.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
            },
            modifier = Modifier.fillMaxSize(),
        )
    }
}

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
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView

/**
 * Live Raspberry Pi FastAPI Stream Screen:
 *   - /video_feed : Live camera + weed stem targets + cut points + chlorosis alerts
 *   - /map_feed   : Live auto-BEV field map with rover pose & weeds
 *   - /cut_plan   : Live polled JSON telemetry (8-way ESP32 drive, MG996R turret -35..+35 deg,
 *                   Dual Relay Grinder/Flame, MaixSense wall distance, 30mm band cut queue)
 *   - Fixed bottom E-STOP bar pinned outside the scroll container so it is always reachable.
 */
@Composable
fun LiveRoverMonitorScreen(
    viewModel: BeViewModel,
) {
    val lang = LocalAppLanguage.current
    val telemetry = viewModel.telemetry
    val piIp = viewModel.piIp
    val piPortText = viewModel.piPortText
    val portNum = viewModel.effectivePort
    val nonce = viewModel.streamReconnectNonce

    DisposableEffect(Unit) {
        viewModel.startLiveMonitoring()
        onDispose {
            viewModel.stopLiveMonitoring()
        }
    }

    Column(modifier = Modifier.fillMaxSize()) {
        // Scrollable live telemetry & MJPEG feeds
        Column(
            modifier = Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            // Pi Host Connection + Stream Reconnect row
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                OutlinedTextField(
                    value = piIp,
                    onValueChange = viewModel::updatePiIp,
                    label = { Text(Strings.piIpLabel(lang)) },
                    singleLine = true,
                    modifier = Modifier.weight(0.62f),
                )
                OutlinedTextField(
                    value = piPortText,
                    onValueChange = viewModel::updatePiPortText,
                    label = { Text(Strings.piPortLabel(lang)) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    modifier = Modifier.weight(0.38f),
                )
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = if (viewModel.streamConnected) {
                        Strings.connectedStatus(lang, "$piIp:$portNum", telemetry.state)
                    } else {
                        Strings.offlineStatus(lang, "$piIp:$portNum", viewModel.liveError ?: "offline")
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = if (viewModel.streamConnected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
                    modifier = Modifier.weight(1f),
                )
                OutlinedButton(onClick = viewModel::triggerStreamReconnect) {
                    Icon(Icons.Default.Refresh, contentDescription = null)
                    Spacer(Modifier.padding(horizontal = 2.dp))
                    Text(Strings.reconnectStreams(lang))
                }
            }

            // Honest bench-mode hardware indicator when physical camera or ESP32 UART isn't attached
            if (viewModel.streamConnected && telemetry.hardware.simulationMode) {
                Card(
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        text = Strings.hardwareBenchNotice(lang),
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(10.dp),
                    )
                }
            }

            telemetry.faultReason?.let { fault ->
                Card(
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        text = fault,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onErrorContainer,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.padding(10.dp),
                    )
                }
            }

            // Live /video_feed MJPEG stream
            Card(modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(12.dp)) {
                Column(Modifier.padding(10.dp)) {
                    Text(
                        text = Strings.liveCameraHeader(lang),
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.Bold,
                    )
                    Spacer(Modifier.height(6.dp))
                    MjpegStreamView(
                        url = viewModel.piClient.videoFeedUrl(piIp, portNum, nonce),
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
                        text = Strings.liveMapHeader(lang),
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.Bold,
                    )
                    Spacer(Modifier.height(6.dp))
                    MjpegStreamView(
                        url = viewModel.piClient.mapFeedUrl(piIp, portNum, nonce),
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
                        text = Strings.liveTelemetryHeader(lang),
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.Bold,
                    )
                    Text(
                        text = "Drive: ${telemetry.esp32DriveDeg?.let { "${it}°" } ?: "STOP"} (${telemetry.esp32Ack})  ·  Heading: ${"%.1f".format(telemetry.headingDeg)}°",
                        fontFamily = FontFamily.Monospace,
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Text(
                        text = "Furrow Offset: ${"%+.1f".format(telemetry.lateralOffsetMm)} mm  ·  Front Wall: ${"%.0f".format(telemetry.wallDistanceMm)} mm",
                        fontFamily = FontFamily.Monospace,
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Text(
                        text = "MG996R Turret: ${"%+.1f".format(telemetry.turretAngleDeg)}° (-35°..+35°)  ·  Weeds Cut: ${telemetry.weedsEliminated}",
                        fontFamily = FontFamily.Monospace,
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Text(
                        text = "Relay 1 (Grinder): ${if (telemetry.relay1Grinder) "ON" else "OFF"}  ·  Relay 2 (Flame): ${if (telemetry.relay2Flame) "ON" else "OFF"}",
                        fontFamily = FontFamily.Monospace,
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Text(
                        text = "30mm Cut Queue: ${telemetry.cutQueue.size} targets  ·  Bad-Chili 3s Clips: ${telemetry.chlorosisClips.size}",
                        fontFamily = FontFamily.Monospace,
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Text(
                        text = "HW: Cam=${if (telemetry.hardware.cameraAttached) "OK" else "SIM"} · YOLO=${if (telemetry.hardware.yoloLoaded) "OK" else "OFF"} · ESP32=${if (telemetry.hardware.esp32Serial) "UART" else "SIM"}",
                        fontFamily = FontFamily.Monospace,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        }

        // Fixed pinned E-STOP bar (always visible, never scrolls off screen)
        Surface(
            tonalElevation = 6.dp,
            shadowElevation = 8.dp,
            color = MaterialTheme.colorScheme.surface,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 10.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                viewModel.eStopError?.let { err ->
                    Text(
                        text = err,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                        fontWeight = FontWeight.Bold,
                    )
                }
                Button(
                    onClick = viewModel::triggerEmergencyStop,
                    enabled = !viewModel.eStopBusy,
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFD32F2F)),
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(54.dp),
                ) {
                    Icon(Icons.Default.Warning, contentDescription = null, tint = Color.White)
                    Spacer(Modifier.padding(horizontal = 4.dp))
                    Text(
                        text = if (viewModel.eStopBusy) Strings.eStopSending(lang) else Strings.eStopLabel(lang),
                        color = Color.White,
                        fontWeight = FontWeight.Bold,
                    )
                }
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
    val context = LocalContext.current
    val webView = remember(context) {
        WebView(context).apply {
            settings.loadWithOverviewMode = true
            settings.useWideViewPort = true
            setBackgroundColor(android.graphics.Color.BLACK)
        }
    }

    DisposableEffect(webView) {
        onDispose {
            webView.stopLoading()
            webView.loadUrl("about:blank")
            webView.destroy()
        }
    }

    Box(modifier = modifier.background(Color.Black)) {
        AndroidView(
            factory = { webView },
            update = { view ->
                if (view.tag != url) {
                    view.tag = url
                    val safeUrl = url.replace("\"", "")
                    val html = """
                        <html><body style="margin:0;padding:0;background:#000;display:flex;align-items:center;justify-content:center;height:100vh;">
                        <img src="$safeUrl" style="max-width:100%;max-height:100%;object-fit:contain;" />
                        </body></html>
                    """.trimIndent()
                    view.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
                }
            },
            modifier = Modifier.fillMaxSize(),
        )
    }
}

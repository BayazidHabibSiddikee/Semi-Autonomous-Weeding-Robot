package com.weedlaser.bev.presentation

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.foundation.Image
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import com.weedlaser.bev.domain.model.Field
import com.weedlaser.bev.domain.model.PathSegment
import java.io.File

@Composable
internal fun FieldConfigInputs(field: Field, onFieldChanged: (Field) -> Unit) {
    val lang = LocalAppLanguage.current
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = field.widthM.toString(),
                onValueChange = { s ->
                    onFieldChanged(field.copy(widthM = s.toDoubleOrNull() ?: field.widthM))
                },
                label = { Text(Strings.widthLabel(lang)) },
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
            OutlinedTextField(
                value = field.lengthM.toString(),
                onValueChange = { s ->
                    onFieldChanged(field.copy(lengthM = s.toDoubleOrNull() ?: field.lengthM))
                },
                label = { Text(Strings.lengthLabel(lang)) },
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = field.totalRows.toString(),
                onValueChange = { s ->
                    onFieldChanged(field.copy(totalRows = s.toIntOrNull() ?: field.totalRows))
                },
                label = { Text(Strings.totalRowsLabel(lang)) },
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
            OutlinedTextField(
                value = field.rowSpacingM.toString(),
                onValueChange = { s ->
                    onFieldChanged(
                        field.copy(rowSpacingM = s.toDoubleOrNull() ?: field.rowSpacingM)
                    )
                },
                label = { Text(Strings.rowSpacingLabel(lang)) },
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = field.speedMps.toString(),
                    onValueChange = { s ->
                        onFieldChanged(field.copy(speedMps = s.toDoubleOrNull() ?: field.speedMps))
                    },
                    label = { Text("Speed (m/s)") },
                    singleLine = true,
                    modifier = Modifier.weight(1f),
                )
                OutlinedTextField(
                    value = field.laserRangeM.toString(),
                    onValueChange = { s ->
                        onFieldChanged(field.copy(laserRangeM = s.toDoubleOrNull() ?: field.laserRangeM))
                    },
                    label = { Text("Laser (m)") },
                    singleLine = true,
                    modifier = Modifier.weight(1f),
                )
                OutlinedTextField(
                    value = field.weedThreshold.toString(),
                    onValueChange = { s ->
                        onFieldChanged(field.copy(weedThreshold = s.toDoubleOrNull() ?: field.weedThreshold))
                    },
                    label = { Text("Weed %") },
                    singleLine = true,
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

@Composable
internal fun BeSuccessPanel(
    o: BevOutcome.Success,
    piIp: String,
    status: com.weedlaser.bev.domain.model.MissionStatus,
    piResult: com.weedlaser.bev.domain.model.PiImageResponse?,
    piBaseUrl: String?,
    isUploading: Boolean,
    onSendImage: () -> Unit,
    onSend: () -> Unit,
    onCopyJson: () -> Unit,
    simStatus: com.weedlaser.bev.domain.model.Sim3dStatus? = null,
) {
    val lang = LocalAppLanguage.current
    Card(
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.primaryContainer,
        ),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(12.dp)) {
            Text(Strings.missionReady(lang), style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(6.dp))
            val summaryText = if (lang == AppLanguage.BN) {
                "${o.mission.field.totalRows} টি সারি · " +
                        "${o.mission.field.lengthM}মি × ${o.mission.field.widthM}মি · " +
                        "মোট দূরত্ব ≈${"%.1f".format(o.mission.totalDistanceM)}মি · " +
                        "শনাক্তকরণ আত্মবিশ্বাস: ${(o.rows.confidence * 100).toInt()}%"
            } else {
                "${o.mission.field.totalRows} rows · " +
                        "${o.mission.field.lengthM}m × ${o.mission.field.widthM}m · " +
                        "≈${"%.1f".format(o.mission.totalDistanceM)}m total · " +
                        "Confidence: ${(o.rows.confidence * 100).toInt()}%"
            }
            Text(summaryText, style = MaterialTheme.typography.bodySmall)

            if (status.state != "IDLE") {
                Spacer(Modifier.height(6.dp))
                Text(
                    "Mission: ${status.state} · rows ${status.rowsDone}/${status.rowsTotal} · " +
                        "weeds killed ${status.weedsKilled} · remaining ${status.weedsRemaining} · " +
                        "${"%.1f".format(status.distanceM)} m",
                    style = MaterialTheme.typography.bodySmall,
                )
                LinearProgressIndicator(
                    progress = { status.progress },
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 4.dp),
                )
            }
            Spacer(Modifier.height(8.dp))

            // BEV and Path Overlay Preview
            BevPathVisualizer(
                bevPath = o.bevPath,
                outcome = o,
            )

            Spacer(Modifier.height(8.dp))
            // Primary action: hand the photo to the Pi, which does the CV
            // and starts the mission.
            Button(
                onClick = onSendImage,
                enabled = !isUploading,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(if (isUploading) "Uploading to Pi…" else "Send image to Pi (Pi does the CV)")
            }

            if (piResult != null) {
                Spacer(Modifier.height(6.dp))
                val a = piResult.analysis
                Text(
                    if (piResult.accepted) {
                        "Pi plan: ${piResult.rows} rows · ${piResult.waypoints} waypoints · " +
                            "≈${"%.1f".format(piResult.distanceM)} m" +
                            (a?.let { " · veg ${(it.vegetationRatio * 100).toInt()}%" } ?: "")
                    } else {
                        "Pi error: ${piResult.error ?: "unknown"}"
                    },
                    style = MaterialTheme.typography.bodySmall,
                )
                a?.warnings?.forEach { w ->
                    Text("⚠ $w", style = MaterialTheme.typography.bodySmall)
                }
                val base = piBaseUrl
                if (base != null && piResult.overlayUrl.isNotEmpty()) {
                    PiPlanPreview(baseUrl = base, url = piResult.overlayUrl)
                }
            }

            // --- 3D digital twin (Pi renders it right after every upload) ---
            val sim = simStatus
            if (piBaseUrl != null && (piResult?.simStatusUrl != null || sim != null)) {
                Spacer(Modifier.height(8.dp))
                Sim3dPanel(baseUrl = piBaseUrl, status = sim)
            }

            Spacer(Modifier.height(8.dp))
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                OutlinedButton(onClick = onSend, modifier = Modifier.weight(1f)) {
                    Text(Strings.sendToPi(lang, piIp))
                }
                OutlinedButton(
                    onClick = onCopyJson,
                    modifier = Modifier.weight(1f),
                ) {
                    Text(Strings.copyJson(lang))
                }
            }
        }
    }
}

@Composable
private fun BevPathVisualizer(
    bevPath: String,
    outcome: BevOutcome.Success,
) {
    val bitmap = remember(bevPath) {
        val f = File(bevPath)
        if (f.exists()) BitmapFactory.decodeFile(f.absolutePath) else null
    }

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(200.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(Color.Black)
    ) {
        Canvas(modifier = Modifier.matchParentSize()) {
            val imgW = (bitmap?.width ?: 800).toFloat()
            val imgH = (bitmap?.height ?: 600).toFloat()
            val aspect = imgW / imgH
            var drawW = size.width
            var drawH = size.height
            if (drawW / drawH > aspect) drawW = drawH * aspect else drawH = drawW / aspect
            val dx = (size.width - drawW) / 2
            val dy = (size.height - drawH) / 2

            bitmap?.let { b ->
                drawImage(
                    image = b.asImageBitmap(),
                    srcOffset = IntOffset.Zero,
                    srcSize = IntSize(b.width, b.height),
                    dstOffset = IntOffset(dx.toInt(), dy.toInt()),
                    dstSize = IntSize(drawW.toInt(), drawH.toInt()),
                )
            }

            // Draw detected crop rows (vertical yellow dotted lines)
            outcome.rows.rowCentersX.forEach { rowX ->
                val canvasX = (rowX / imgW) * drawW + dx
                drawLine(
                    color = Color.Yellow.copy(alpha = 0.6f),
                    start = Offset(canvasX, dy),
                    end = Offset(canvasX, dy + drawH),
                    strokeWidth = 2f,
                )
            }

            // Draw Boustrophedon path segments (green lines + turn markers)
            val calib = outcome.calibration
            outcome.mission.path.forEach { segment ->
                when (segment) {
                    is PathSegment.FollowRow -> {
                        val startPx = calib.fieldToPixel(segment.startPoint)
                        val endPx = calib.fieldToPixel(segment.endPoint)
                        val sx = (startPx.x / imgW) * drawW + dx
                        val sy = (startPx.y / imgH) * drawH + dy
                        val ex = (endPx.x / imgW) * drawW + dx
                        val ey = (endPx.y / imgH) * drawH + dy

                        drawLine(
                            color = Color.Green,
                            start = Offset(sx, sy),
                            end = Offset(ex, ey),
                            strokeWidth = 3f,
                        )
                        drawCircle(color = Color.Cyan, radius = 4f, center = Offset(sx, sy))
                    }
                    is PathSegment.Turn -> {
                        val startPx = calib.fieldToPixel(segment.startPoint)
                        val endPx = calib.fieldToPixel(segment.endPoint)
                        val sx = (startPx.x / imgW) * drawW + dx
                        val sy = (startPx.y / imgH) * drawH + dy
                        val ex = (endPx.x / imgW) * drawW + dx
                        val ey = (endPx.y / imgH) * drawH + dy

                        drawLine(
                            color = Color.Magenta,
                            start = Offset(sx, sy),
                            end = Offset(ex, ey),
                            strokeWidth = 3f,
                        )
                    }
                }
            }
        }
    }
}

@Composable
internal fun BeErrorPanel(message: String, onRetry: () -> Unit) {
    val lang = LocalAppLanguage.current
    Card(
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.errorContainer,
        ),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(12.dp)) {
            val errPrefix = if (lang == AppLanguage.BN) "ত্রুটি: " else "Error: "
            Text("$errPrefix$message", style = MaterialTheme.typography.bodyMedium)
            Spacer(Modifier.height(8.dp))
            TextButton(onClick = onRetry) { Text(Strings.retry(lang)) }
        }
    }
}

@Composable
internal fun BeIdleHint() {
    val lang = LocalAppLanguage.current
    Text(
        Strings.idleHint(lang),
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}


/**
 * Shows the BEV / plan overlay the Pi produced from the uploaded photo.
 */
@Composable
private fun PiPlanPreview(baseUrl: String, url: String) {
    val bitmap by produceState<Bitmap?>(null, baseUrl, url) {
        value = withContext(Dispatchers.IO) { loadRemoteBitmap("$baseUrl$url") }
    }
    if (bitmap != null) {
        Spacer(Modifier.height(6.dp))
        Text("Pi's top-down view of your field", style = MaterialTheme.typography.bodySmall)
        Image(
            bitmap = bitmap!!.asImageBitmap(),
            contentDescription = "Pi BEV plan",
            modifier = Modifier
                .fillMaxWidth()
                .height(260.dp)
                .clip(RoundedCornerShape(8.dp)),
        )
    }
}

private fun loadRemoteBitmap(url: String): Bitmap? = runCatching {
    val connection = (java.net.URL(url).openConnection() as java.net.HttpURLConnection)
    connection.connectTimeout = 10000
    connection.readTimeout = 30000
    val bytes = connection.inputStream.use { it.readBytes() }
    connection.disconnect()
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
}.getOrNull()

@Composable
internal fun Sim3dPanel(baseUrl: String, status: com.weedlaser.bev.domain.model.Sim3dStatus?) {
    Column(Modifier.fillMaxWidth()) {
        val label = when (status?.state) {
            null -> "3D digital twin: waiting for the Pi…"
            "spec" -> "3D digital twin: building the map from your photo…"
            "render" -> "3D digital twin: rendering ${status.frames} frames (${status.lanes} lanes, ${status.weeds} weeds)…"
            "encode" -> "3D digital twin: encoding the video (${status.killed} weeds zapped)…"
            "done" -> "3D digital twin: (✓) ${status.killed} weeds zapped of ${status.weeds}"
            "error" -> "3D digital twin failed: ${status.error ?: "unknown"}"
            else -> "3D digital twin: ${status.state}"
        }
        Text(label, style = MaterialTheme.typography.bodyMedium)
        Spacer(Modifier.height(6.dp))
        if (status?.state == "done" && status.videoUrl != null) {
            Sim3dVideo(url = "$baseUrl${status.videoUrl}")
        }
    }
}

@Composable
private fun Sim3dVideo(url: String) {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    AndroidView(
        factory = {
            android.widget.VideoView(it).apply {
                val controller = android.widget.MediaController(it)
                controller.setAnchorView(this)
                this.setMediaController(controller)
                setVideoURI(android.net.Uri.parse(url))
                setOnPreparedListener { mp -> mp.isLooping = true; start() }
            }
        },
        modifier = Modifier
            .fillMaxWidth()
            .height(220.dp),
        update = {
            if (it.currentPosition == 0 && !it.isPlaying) {
                try { it.setVideoURI(android.net.Uri.parse(url)); it.start() } catch (_: Exception) {}
            }
        }
    )
    Spacer(Modifier.height(4.dp))
    Text("live 3D simulation video streamed from the Pi", style = MaterialTheme.typography.bodySmall)
}

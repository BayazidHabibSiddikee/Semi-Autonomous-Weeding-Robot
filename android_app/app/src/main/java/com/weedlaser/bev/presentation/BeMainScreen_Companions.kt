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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import kotlin.math.roundToInt
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
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("FIELD DIMENSIONS", style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.primary)
        SliderRow("Field width", "m", 2.0..20.0, 39, field.widthM) { v ->
            onFieldChanged(field.copy(widthM = v)) }
        SliderRow("Field length", "m", 2.0..30.0, 55, field.lengthM) { v ->
            onFieldChanged(field.copy(lengthM = v)) }
        SliderRow("Crop rows", "", 2.0..20.0, 17, field.totalRows.toDouble()) { v ->
            onFieldChanged(field.copy(totalRows = v.toInt())) }
        SliderRow("Row spacing", "m", 0.3..1.5, 23, field.rowSpacingM) { v ->
            onFieldChanged(field.copy(rowSpacingM = v)) }

        Spacer(Modifier.height(4.dp))
        Text("SIMULATION RENDERER", style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.primary)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(
                onClick = { onFieldChanged(field.copy(renderer = "freecad")) },
                colors = if (field.renderer == "freecad")
                    androidx.compose.material3.ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.primary,
                        contentColor = Color.White,
                    ) else androidx.compose.material3.ButtonDefaults.outlinedButtonColors(),
                modifier = Modifier.weight(1f),
            ) { Text("Fast CAD sim") }
            OutlinedButton(
                onClick = { onFieldChanged(field.copy(renderer = "blender")) },
                colors = if (field.renderer == "blender")
                    androidx.compose.material3.ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.primary,
                        contentColor = Color.White,
                    ) else androidx.compose.material3.ButtonDefaults.outlinedButtonColors(),
                modifier = Modifier.weight(1f),
            ) { Text("Photorealistic (slow)") }
        }
        Spacer(Modifier.height(4.dp))
        Text("ROBOT & WEEDING", style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.primary)
        SliderRow("Robot speed", "m/s", 0.2..2.0, 35, field.speedMps) { v ->
            onFieldChanged(field.copy(speedMps = v)) }
        SliderRow("Laser range", "m", 0.1..0.8, 13, field.laserRangeM) { v ->
            onFieldChanged(field.copy(laserRangeM = v)) }
        SliderRow("Weed threshold", "%", 0.0..100.0, 20, field.weedThreshold) { v ->
            onFieldChanged(field.copy(weedThreshold = v)) }

        Spacer(Modifier.height(4.dp))
        Text("ADVANCED", style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        SliderRow("Headland margin", "m", 0.1..1.0, 17, field.headlandMarginM) { v ->
            onFieldChanged(field.copy(headlandMarginM = v)) }
        SliderRow("Max weeds modelled", "", 10.0..120.0, 21, field.maxWeeds) { v ->
            onFieldChanged(field.copy(maxWeeds = v)) }
    }
}

/** Label + material slider + live value display. */
@Composable
private fun SliderRow(
    label: String,
    unit: String,
    range: ClosedFloatingPointRange<Double>,
    steps: Int,
    value: Double,
    onChange: (Double) -> Unit,
) {
    Column {
        val shown = if (value == value.roundToInt().toDouble()) {
            value.roundToInt().toString()
        } else {
            "%.2f".format(value)
        }
        Row {
            Text(label, style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.weight(1f))
            Text(
                "$shown$unit",
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = androidx.compose.ui.text.font.FontWeight.Bold,
            )
        }
        androidx.compose.material3.Slider(
            value = value.toFloat().coerceIn(range.start.toFloat(), range.endInclusive.toFloat()),
            onValueChange = { onChange(it.toDouble()) },
            valueRange = range.start.toFloat()..range.endInclusive.toFloat(),
            steps = steps,
        )
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
internal fun BeErrorPanel(
    message: String,
    canSendAnyway: Boolean = false,
    onRetry: () -> Unit,
    onSendAnyway: (() -> Unit)? = null,
) {
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
            Row {
                TextButton(onClick = onRetry) { Text(Strings.retry(lang)) }
                if (canSendAnyway && onSendAnyway != null) {
                    TextButton(onClick = onSendAnyway) {
                        Text(
                            if (lang == AppLanguage.BN) "রোবটকে পাঠাও"
                            else "Send to rover anyway",
                        )
                    }
                }
            }
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
            "render" -> if (status.frames > 0)
                "3D digital twin: rendering ${status.framesDone}/${status.frames} frames (${status.lanes} lanes, ${status.weeds} weeds)…"
            else
                "3D digital twin: rendering… ${status.framesDone} frames (${status.lanes} lanes, ${status.weeds} weeds) photorealistic render, a few minutes"
            "encode" -> "3D digital twin: encoding the video (${status.killed} weeds zapped)…"
            "done" -> "3D digital twin: (✓) ${status.killed} weeds zapped of ${status.weeds}"
            "error" -> "3D digital twin failed: ${status.error ?: "unknown"}"
            else -> "3D digital twin: ${status.state}"
        }
        Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
            when (status?.state) {
                "spec", "render", "encode" -> {
                    Box(
                        Modifier
                            .size(10.dp)
                            .clip(androidx.compose.foundation.shape.CircleShape)
                            .background(Color(0xFFD32F2F)),
                    )
                    Spacer(Modifier.width(6.dp))
                    Text("LIVE", color = Color(0xFFD32F2F), style = MaterialTheme.typography.labelMedium)
                    Spacer(Modifier.width(8.dp))
                }
                else -> {}
            }
        }
        Text(label, style = MaterialTheme.typography.bodyMedium)
        Spacer(Modifier.height(6.dp))
        if (status?.state == "render" && baseUrl.isNotBlank()) {
            Sim3dLiveView(baseUrl)
        }
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

@Composable
private fun Sim3dLiveView(baseUrl: String) {
    var latest by remember { mutableStateOf<Long>(0L) }
    var bmp by remember { mutableStateOf<android.graphics.Bitmap?>(null) }
    LaunchedEffect(baseUrl) {
        while (true) {
            kotlinx.coroutines.withContext(Dispatchers.IO) {
                runCatching {
                    val t = System.currentTimeMillis()
                    val connection = (java.net.URL("$baseUrl/live.jpg?t=$t")
                        .openConnection() as java.net.HttpURLConnection)
                    connection.connectTimeout = 4000
                    connection.readTimeout = 4000
                    connection.inputStream.use { stream ->
                        val newBmp = android.graphics.BitmapFactory.decodeStream(stream)
                        if (newBmp != null) {
                            latest = t
                            bmp = newBmp
                        }
                    }
                    connection.disconnect()
                }
            }
            kotlinx.coroutines.delay(500L)
        }
    }
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(220.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(Color.Black),
        contentAlignment = androidx.compose.ui.Alignment.Center,
    ) {
        bmp?.let {
            androidx.compose.foundation.Image(
                bitmap = it.asImageBitmap(),
                contentDescription = "live 3D sim from the Pi",
                contentScale = androidx.compose.ui.layout.ContentScale.Fit,
            )
        } ?: Text("connecting to the live feed…", color = Color.White)
    }
    Spacer(Modifier.height(4.dp))
    Text("live: the 3D twin renders faster than the video encodes, so this is what the Pi sees RIGHT NOW", style = MaterialTheme.typography.bodySmall)
}

package com.weedlaser.bev.presentation

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
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.LaunchedEffect
import com.weedlaser.bev.domain.model.Field
import com.weedlaser.bev.domain.model.PathSegment
import com.weedlaser.bev.domain.repository.DiscoveredDevice
import java.io.File

@Composable
internal fun FieldConfigInputs(field: Field, onFieldChanged: (Field) -> Unit) {
    val lang = LocalAppLanguage.current

    var widthText by rememberSaveable { mutableStateOf(field.widthM.toString()) }
    var lengthText by rememberSaveable { mutableStateOf(field.lengthM.toString()) }
    var rowsText by rememberSaveable { mutableStateOf(field.totalRows.toString()) }
    var spacingText by rememberSaveable { mutableStateOf(field.rowSpacingM.toString()) }

    // Sync when persisted field loads asynchronously from SharedPreferences
    LaunchedEffect(field.widthM, field.lengthM, field.totalRows, field.rowSpacingM) {
        if (widthText.toDoubleOrNull() != field.widthM) widthText = field.widthM.toString()
        if (lengthText.toDoubleOrNull() != field.lengthM) lengthText = field.lengthM.toString()
        if (rowsText.toIntOrNull() != field.totalRows) rowsText = field.totalRows.toString()
        if (spacingText.toDoubleOrNull() != field.rowSpacingM) spacingText = field.rowSpacingM.toString()
    }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = widthText,
                onValueChange = { s ->
                    widthText = s
                    val parsed = s.toDoubleOrNull()
                    if (parsed != null && parsed > 0.0) {
                        onFieldChanged(field.copy(widthM = parsed))
                    }
                },
                label = { Text(Strings.widthLabel(lang)) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                modifier = Modifier.weight(1f),
            )
            OutlinedTextField(
                value = lengthText,
                onValueChange = { s ->
                    lengthText = s
                    val parsed = s.toDoubleOrNull()
                    if (parsed != null && parsed > 0.0) {
                        onFieldChanged(field.copy(lengthM = parsed))
                    }
                },
                label = { Text(Strings.lengthLabel(lang)) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                modifier = Modifier.weight(1f),
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = rowsText,
                onValueChange = { s ->
                    rowsText = s
                    val parsed = s.toIntOrNull()
                    if (parsed != null && parsed > 0) {
                        onFieldChanged(field.copy(totalRows = parsed))
                    }
                },
                label = { Text(Strings.totalRowsLabel(lang)) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.weight(1f),
            )
            OutlinedTextField(
                value = spacingText,
                onValueChange = { s ->
                    spacingText = s
                    val parsed = s.toDoubleOrNull()
                    if (parsed != null && parsed > 0.0) {
                        onFieldChanged(field.copy(rowSpacingM = parsed))
                    }
                },
                label = { Text(Strings.rowSpacingLabel(lang)) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                modifier = Modifier.weight(1f),
            )
        }
    }
}

@Composable
internal fun BeSuccessPanel(
    o: BevOutcome.Success,
    piIp: String,
    piPort: String,
    onPiIpChanged: (String) -> Unit,
    onPiPortChanged: (String) -> Unit,
    discoveredDevices: List<DiscoveredDevice>,
    onSelectDevice: (DiscoveredDevice) -> Unit,
    onDiscover: () -> Unit,
    transferState: PiTransferState,
    onTestConnection: () -> Unit,
    onSend: () -> Unit,
    onCopyJson: () -> Unit,
) {
    val lang = LocalAppLanguage.current
    val estMinutes = (o.mission.totalDistanceM / 0.10) / 60.0

    Card(
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.primaryContainer,
        ),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(Strings.missionReady(lang), style = MaterialTheme.typography.titleMedium)

            val summaryText = if (lang == AppLanguage.BN) {
                "${o.mission.field.totalRows} টি সারি (শনাক্ত: ${o.rows.detectedRowCount}) · " +
                    "${o.mission.field.lengthM}মি × ${o.mission.field.widthM}মি · " +
                    "মোট দূরত্ব ≈${"%.1f".format(o.mission.totalDistanceM)}মি · " +
                    "আনুমানিক সময় ≈${"%.1f".format(estMinutes)} মি. · " +
                    "আত্মবিশ্বাস: ${(o.rows.confidence * 100).toInt()}%"
            } else {
                "${o.mission.field.totalRows} rows (detected: ${o.rows.detectedRowCount}) · " +
                    "${o.mission.field.lengthM}m × ${o.mission.field.widthM}m · " +
                    "≈${"%.1f".format(o.mission.totalDistanceM)}m total · " +
                    "Est. ≈${"%.1f".format(estMinutes)} min · " +
                    "Confidence: ${(o.rows.confidence * 100).toInt()}%"
            }
            Text(summaryText, style = MaterialTheme.typography.bodySmall)

            // BEV and Path Overlay Preview
            BevPathVisualizer(
                bevPath = o.bevPath,
                outcome = o,
            )

            // Editable Raspberry Pi target IP & Port
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                OutlinedTextField(
                    value = piIp,
                    onValueChange = onPiIpChanged,
                    label = { Text(Strings.piIpLabel(lang)) },
                    singleLine = true,
                    modifier = Modifier.weight(0.68f),
                )
                OutlinedTextField(
                    value = piPort,
                    onValueChange = onPiPortChanged,
                    label = { Text(Strings.piPortLabel(lang)) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    modifier = Modifier.weight(0.32f),
                )
            }

            if (discoveredDevices.isNotEmpty()) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    discoveredDevices.forEach { dev ->
                        TextButton(onClick = { onSelectDevice(dev) }) {
                            Text("Select ${dev.name} (${dev.ipAddress}:${dev.port})")
                        }
                    }
                }
            }

            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Button(
                    onClick = onSend,
                    enabled = transferState !is PiTransferState.Busy,
                    modifier = Modifier.weight(1f),
                ) {
                    Text(Strings.sendToPi(lang, piIp), maxLines = 1)
                }
                OutlinedButton(
                    onClick = onTestConnection,
                    enabled = transferState !is PiTransferState.Busy,
                    modifier = Modifier.weight(0.75f),
                ) {
                    Text(Strings.testConnection(lang), maxLines = 1)
                }
            }

            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                OutlinedButton(
                    onClick = onDiscover,
                    enabled = transferState !is PiTransferState.Busy,
                    modifier = Modifier.weight(1f),
                ) {
                    Text(if (lang == AppLanguage.BN) "রোবট খুঁজুন" else "Discover Pi", maxLines = 1)
                }
                OutlinedButton(
                    onClick = onCopyJson,
                    modifier = Modifier.weight(1f),
                ) {
                    Text(Strings.copyJson(lang), maxLines = 1)
                }
            }

            when (transferState) {
                is PiTransferState.Busy -> Text(
                    text = if (lang == AppLanguage.BN) "রোবটের সাথে সংযোগ করা হচ্ছে..." else "Communicating with Raspberry Pi...",
                    style = MaterialTheme.typography.bodySmall,
                )
                is PiTransferState.Success -> Text(
                    text = transferState.message,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.primary,
                )
                is PiTransferState.Error -> Text(
                    text = transferState.message,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
                PiTransferState.Idle -> Unit
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

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
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
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
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = field.widthM.toString(),
                onValueChange = { s ->
                    onFieldChanged(field.copy(widthM = s.toDoubleOrNull() ?: field.widthM))
                },
                label = { Text("Width (m)") },
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
            OutlinedTextField(
                value = field.lengthM.toString(),
                onValueChange = { s ->
                    onFieldChanged(field.copy(lengthM = s.toDoubleOrNull() ?: field.lengthM))
                },
                label = { Text("Length (m)") },
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
                label = { Text("Rows") },
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
                label = { Text("Row spacing (m)") },
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
        }
    }
}

@Composable
internal fun BeSuccessPanel(
    o: BevOutcome.Success,
    piIp: String,
    onSend: () -> Unit,
    onCopyJson: () -> Unit,
) {
    Card(
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.primaryContainer,
        ),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(12.dp)) {
            Text("Mission Ready", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(6.dp))
            Text(
                "${o.mission.field.totalRows} rows · " +
                        "${o.mission.field.lengthM}m × ${o.mission.field.widthM}m · " +
                        "≈${"%.1f".format(o.mission.totalDistanceM)}m total · " +
                        "Confidence: ${(o.rows.confidence * 100).toInt()}%",
                style = MaterialTheme.typography.bodySmall,
            )
            Spacer(Modifier.height(8.dp))

            // BEV and Path Overlay Preview
            BevPathVisualizer(
                bevPath = o.bevPath,
                outcome = o,
            )

            Spacer(Modifier.height(8.dp))
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                OutlinedButton(onClick = onSend, modifier = Modifier.weight(1f)) {
                    Text("Send to $piIp")
                }
                OutlinedButton(
                    onClick = onCopyJson,
                    modifier = Modifier.weight(1f),
                ) {
                    Text("Copy JSON")
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
    Card(
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.errorContainer,
        ),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(12.dp)) {
            Text(message, style = MaterialTheme.typography.bodyMedium)
            Spacer(Modifier.height(8.dp))
            TextButton(onClick = onRetry) { Text("Retry") }
        }
    }
}

@Composable
internal fun BeIdleHint() {
    Text(
        "No mission yet. Capture a photo and select the 4 corners.",
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

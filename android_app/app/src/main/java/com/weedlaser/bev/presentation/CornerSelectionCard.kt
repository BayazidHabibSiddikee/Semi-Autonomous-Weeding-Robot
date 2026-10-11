package com.weedlaser.bev.presentation

import android.graphics.BitmapFactory
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.weedlaser.bev.domain.model.FieldCorners
import com.weedlaser.bev.domain.model.ImagePoint
import java.io.File
import kotlin.math.sqrt

private val cornerLabels = listOf("TL", "TR", "BR", "BL")

@Composable
internal fun CornerSelectionCard(
    imagePath: String?,
    corners: FieldCorners?,
    onPickPhotoClick: () -> Unit = {},
    onCornersChanged: (FieldCorners) -> Unit,
) {
    Column {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = onPickPhotoClick) {
                Text(if (imagePath == null) "Take / Pick Photo" else "Change Photo")
            }
        }
        imagePath?.let { p ->
            CornerCanvas(p, corners, onCornersChanged)
        } ?: run {
            Text(
                "No photo selected.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun CornerCanvas(
    path: String,
    corners: FieldCorners?,
    onCornersChanged: (FieldCorners) -> Unit,
) {
    val bitmap = remember(path) {
        val file = File(path)
        if (file.exists()) BitmapFactory.decodeFile(file.absolutePath) else null
    }

    val imgW = (bitmap?.width ?: 800).toFloat()
    val imgH = (bitmap?.height ?: 600).toFloat()

    val currentCorners = remember(corners, imgW, imgH) {
        corners ?: defaultCorners(imgW, imgH)
    }

    var draggedIndex by remember { mutableStateOf<Int?>(null) }
    val measurer = rememberTextMeasurer()

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(320.dp)
            .clip(RoundedCornerShape(8.dp))
    ) {
        Canvas(
            modifier = Modifier
                .matchParentSize()
                .pointerInput(path, currentCorners) {
                    detectDragGestures(
                        onDragStart = { offset ->
                            val aspect = imgW / imgH
                            var drawW = size.width.toFloat()
                            var drawH = size.height.toFloat()
                            if (drawW / drawH > aspect) drawW = drawH * aspect else drawH = drawW / aspect
                            val dx = (size.width - drawW) / 2
                            val dy = (size.height - drawH) / 2

                            val pts = currentCorners.toList()
                            val hitRadius = 50f
                            draggedIndex = pts.indexOfFirst { pt ->
                                val screenX = (pt.x / imgW) * drawW + dx
                                val screenY = (pt.y / imgH) * drawH + dy
                                val dist = sqrt((offset.x - screenX) * (offset.x - screenX) + (offset.y - screenY) * (offset.y - screenY))
                                dist <= hitRadius
                            }.takeIf { it != -1 }
                        },
                        onDrag = { change, dragAmount ->
                            change.consume()
                            val idx = draggedIndex ?: return@detectDragGestures
                            val aspect = imgW / imgH
                            var drawW = size.width.toFloat()
                            var drawH = size.height.toFloat()
                            if (drawW / drawH > aspect) drawW = drawH * aspect else drawH = drawW / aspect

                            val dxImg = (dragAmount.x / drawW) * imgW
                            val dyImg = (dragAmount.y / drawH) * imgH

                            val pts = currentCorners.toList().toMutableList()
                            val old = pts[idx]
                            val newX = (old.x + dxImg).coerceIn(0f, imgW)
                            val newY = (old.y + dyImg).coerceIn(0f, imgH)
                            pts[idx] = ImagePoint(newX, newY)

                            val updated = FieldCorners(pts[0], pts[1], pts[2], pts[3])
                            onCornersChanged(updated)
                        },
                        onDragEnd = { draggedIndex = null },
                        onDragCancel = { draggedIndex = null },
                    )
                }
        ) {
            val aspect = imgW / imgH
            var drawW = size.width
            var drawH = size.height
            if (drawW / drawH > aspect) drawH = drawW / aspect else drawW = drawH * aspect
            val dx = (size.width - drawW) / 2
            val dy = (size.height - drawH) / 2

            bitmap?.let { b ->
                val imageBitmap = b.asImageBitmap()
                drawImage(
                    image = imageBitmap,
                    srcOffset = IntOffset.Zero,
                    srcSize = IntSize(b.width, b.height),
                    dstOffset = IntOffset(dx.toInt(), dy.toInt()),
                    dstSize = IntSize(drawW.toInt(), drawH.toInt()),
                )
            }

            val pts = currentCorners.toList()
            val offsets = pts.map { p ->
                Offset((p.x / imgW) * drawW + dx, (p.y / imgH) * drawH + dy)
            }

            if (offsets.size == 4) {
                drawPath(
                    path = Path().apply {
                        moveTo(offsets[0].x, offsets[0].y)
                        lineTo(offsets[1].x, offsets[1].y)
                        lineTo(offsets[2].x, offsets[2].y)
                        lineTo(offsets[3].x, offsets[3].y)
                        close()
                    },
                    color = Color.Cyan,
                    style = Stroke(width = 3f),
                )
            }

            cornerLabels.forEachIndexed { i, label ->
                val center = offsets.getOrNull(i) ?: return@forEachIndexed
                val isDragged = (i == draggedIndex)
                drawCircle(
                    color = if (isDragged) Color.Yellow else Color.Cyan,
                    radius = if (isDragged) 22f else 18f,
                    center = center,
                    style = Stroke(width = 4f),
                )
                drawCircle(
                    color = Color.White,
                    radius = 8f,
                    center = center,
                )
                drawText(
                    textMeasurer = measurer,
                    text = label,
                    style = TextStyle(fontSize = 13.sp, color = Color.White),
                    topLeft = Offset(center.x - 12f, center.y - 32f),
                )
            }
        }
    }

    Text(
        "Drag the 4 handles to the field corners.",
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

private fun defaultCorners(w: Float, h: Float): FieldCorners = FieldCorners(
    topLeft = ImagePoint(w * 0.1f, h * 0.1f),
    topRight = ImagePoint(w * 0.9f, h * 0.1f),
    bottomRight = ImagePoint(w * 0.9f, h * 0.9f),
    bottomLeft = ImagePoint(w * 0.1f, h * 0.9f),
)
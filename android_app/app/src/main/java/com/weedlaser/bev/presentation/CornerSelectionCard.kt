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
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.text.font.FontWeight
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
    val lang = LocalAppLanguage.current
    Column {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = onPickPhotoClick) {
                Text(Strings.pickPhoto(lang, imagePath != null))
            }
        }
        imagePath?.let { p ->
            CornerCanvas(p, corners, onCornersChanged)
        } ?: run {
            Text(
                Strings.noPhotoSelected(lang),
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
        if (!file.exists()) return@remember null
        try {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(file.absolutePath, bounds)
            val maxPreview = 1400
            var sample = 1
            while ((bounds.outWidth / sample) > maxPreview || (bounds.outHeight / sample) > maxPreview) {
                sample *= 2
            }
            val opts = BitmapFactory.Options().apply {
                inSampleSize = sample
                inPreferredConfig = android.graphics.Bitmap.Config.RGB_565
            }
            BitmapFactory.decodeFile(file.absolutePath, opts)
        } catch (e: Throwable) {
            android.util.Log.e("CornerCanvas", "Failed to decode preview bitmap: ${e.message}", e)
            null
        }
    }

    val imgW = (bitmap?.width ?: 800).toFloat()
    val imgH = (bitmap?.height ?: 600).toFloat()

    val currentCorners = remember(corners, imgW, imgH) {
        corners ?: defaultCorners(imgW, imgH)
    }

    var liveCorners by remember(path) { mutableStateOf(currentCorners) }
    // Sync external updates when not actively dragging
    var draggedIndex by remember { mutableStateOf<Int?>(null) }
    androidx.compose.runtime.LaunchedEffect(corners) {
        if (draggedIndex == null && corners != null) {
            liveCorners = corners
        }
    }

    val latestCornersChanged by androidx.compose.runtime.rememberUpdatedState(onCornersChanged)
    val measurer = rememberTextMeasurer()

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(340.dp)
            .clip(RoundedCornerShape(12.dp))
    ) {
        Canvas(
            modifier = Modifier
                .matchParentSize()
                .pointerInput(path, imgW, imgH) {
                    detectDragGestures(
                        onDragStart = { offset ->
                            val aspect = imgW / imgH
                            var drawW = size.width.toFloat()
                            var drawH = size.height.toFloat()
                            if (drawW / drawH > aspect) drawW = drawH * aspect else drawH = drawW / aspect
                            val dx = (size.width - drawW) / 2
                            val dy = (size.height - drawH) / 2

                            val pts = liveCorners.toList()
                            val hitRadius = 120f // Generous touch target for finger/thumb

                            var closestIdx = -1
                            var minDist = Float.MAX_VALUE
                            pts.forEachIndexed { idx, pt ->
                                val screenX = (pt.x / imgW) * drawW + dx
                                val screenY = (pt.y / imgH) * drawH + dy
                                val dist = sqrt((offset.x - screenX) * (offset.x - screenX) + (offset.y - screenY) * (offset.y - screenY))
                                if (dist <= hitRadius && dist < minDist) {
                                    minDist = dist
                                    closestIdx = idx
                                }
                            }
                            draggedIndex = if (closestIdx != -1) closestIdx else null
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

                            val pts = liveCorners.toList().toMutableList()
                            val old = pts[idx]
                            val newX = (old.x + dxImg).coerceIn(0f, imgW)
                            val newY = (old.y + dyImg).coerceIn(0f, imgH)
                            pts[idx] = ImagePoint(newX, newY)

                            val updated = FieldCorners(pts[0], pts[1], pts[2], pts[3])
                            liveCorners = updated
                            latestCornersChanged(updated)
                        },
                        onDragEnd = {
                            draggedIndex = null
                            latestCornersChanged(liveCorners)
                        },
                        onDragCancel = {
                            draggedIndex = null
                        },
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

            val pts = liveCorners.toList()
            val offsets = pts.map { p ->
                Offset((p.x / imgW) * drawW + dx, (p.y / imgH) * drawH + dy)
            }

            if (offsets.size == 4) {
                // Polygon boundary line
                drawPath(
                    path = Path().apply {
                        moveTo(offsets[0].x, offsets[0].y)
                        lineTo(offsets[1].x, offsets[1].y)
                        lineTo(offsets[2].x, offsets[2].y)
                        lineTo(offsets[3].x, offsets[3].y)
                        close()
                    },
                    color = Color(0xFF00E5FF),
                    style = Stroke(width = 4f),
                )
                // Semi-transparent field fill
                drawPath(
                    path = Path().apply {
                        moveTo(offsets[0].x, offsets[0].y)
                        lineTo(offsets[1].x, offsets[1].y)
                        lineTo(offsets[2].x, offsets[2].y)
                        lineTo(offsets[3].x, offsets[3].y)
                        close()
                    },
                    color = Color(0x2200E5FF),
                )
            }

            cornerLabels.forEachIndexed { i, label ->
                val center = offsets.getOrNull(i) ?: return@forEachIndexed
                val isDragged = (i == draggedIndex)

                // Large touch target halo if dragged or hovered
                if (isDragged) {
                    drawCircle(
                        color = Color(0x55FFEB3B),
                        radius = 42f,
                        center = center,
                    )
                }

                // Outer circle
                drawCircle(
                    color = if (isDragged) Color(0xFFFFEB3B) else Color(0xFF00E5FF),
                    radius = if (isDragged) 24f else 18f,
                    center = center,
                    style = Stroke(width = 5f),
                )
                // Inner center dot
                drawCircle(
                    color = Color.White,
                    radius = if (isDragged) 10f else 7f,
                    center = center,
                )

                // Label badge with safe clamped coordinates inside canvas bounds
                val textLayoutResult = measurer.measure(
                    text = label,
                    style = TextStyle(
                        fontSize = 12.sp,
                        color = Color.Black,
                        fontFamily = BengaliFontFamily,
                        fontWeight = FontWeight.Bold
                    )
                )
                val badgeW = textLayoutResult.size.width + 16f
                val badgeH = textLayoutResult.size.height + 8f

                val badgeLeft = (center.x - badgeW / 2f).coerceIn(4f, size.width - badgeW - 4f)
                val badgeTop = (center.y - 38f).coerceIn(4f, size.height - badgeH - 4f)

                // Rounded badge background
                drawRoundRect(
                    color = if (isDragged) Color(0xFFFFEB3B) else Color(0xCC00E5FF),
                    topLeft = Offset(badgeLeft, badgeTop),
                    size = androidx.compose.ui.geometry.Size(badgeW, badgeH),
                    cornerRadius = androidx.compose.ui.geometry.CornerRadius(6f, 6f)
                )

                drawText(
                    textLayoutResult = textLayoutResult,
                    topLeft = Offset(badgeLeft + 8f, badgeTop + 4f),
                )
            }
        }
    }

    val lang = LocalAppLanguage.current
    Text(
        Strings.dragHandleHint(lang),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(top = 4.dp),
    )
}

private fun defaultCorners(w: Float, h: Float): FieldCorners = FieldCorners(
    topLeft = ImagePoint(w * 0.1f, h * 0.1f),
    topRight = ImagePoint(w * 0.9f, h * 0.1f),
    bottomRight = ImagePoint(w * 0.9f, h * 0.9f),
    bottomLeft = ImagePoint(w * 0.1f, h * 0.9f),
)
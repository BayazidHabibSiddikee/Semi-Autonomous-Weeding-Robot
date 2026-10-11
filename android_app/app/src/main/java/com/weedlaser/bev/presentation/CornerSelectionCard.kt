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
    onDraggingChanged: (Boolean) -> Unit = {},
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
            CornerCanvas(p, corners, onDraggingChanged, onCornersChanged)
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
    onDraggingChanged: (Boolean) -> Unit,
    onCornersChanged: (FieldCorners) -> Unit,
) {
    val fullBounds = remember(path) {
        val file = File(path)
        if (!file.exists()) {
            IntSize(800, 600)
        } else {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(file.absolutePath, bounds)
            IntSize(bounds.outWidth.coerceAtLeast(1), bounds.outHeight.coerceAtLeast(1))
        }
    }
    val fullW = fullBounds.width.toFloat()
    val fullH = fullBounds.height.toFloat()

    val bitmap = remember(path) {
        val file = File(path)
        if (!file.exists()) return@remember null
        try {
            val maxPreview = 1400
            var sample = 1
            while ((fullBounds.width / sample) > maxPreview || (fullBounds.height / sample) > maxPreview) {
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

    val currentCorners = remember(corners, fullW, fullH) {
        corners ?: defaultCorners(fullW, fullH)
    }

    var liveCorners by remember(path) { mutableStateOf(currentCorners) }
    var draggedIndex by remember { mutableStateOf<Int?>(null) }
    androidx.compose.runtime.LaunchedEffect(corners) {
        if (draggedIndex == null && corners != null) {
            liveCorners = corners
        }
    }

    val latestCornersChanged by androidx.compose.runtime.rememberUpdatedState(onCornersChanged)
    val latestDraggingChanged by androidx.compose.runtime.rememberUpdatedState(onDraggingChanged)
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
                .pointerInput(path, fullW, fullH) {
                    awaitPointerEventScope {
                        while (true) {
                            val downEvent = awaitPointerEvent()
                            val down = downEvent.changes.firstOrNull { it.pressed } ?: continue

                            val aspect = fullW / fullH
                            var drawW = size.width.toFloat()
                            var drawH = size.height.toFloat()
                            if (drawW / drawH > aspect) drawW = drawH * aspect else drawH = drawW / aspect
                            val dx = (size.width - drawW) / 2
                            val dy = (size.height - drawH) / 2

                            val pts = liveCorners.toList()
                            val hitRadius = 180f // Generous touch target

                            var closestIdx = -1
                            var minDist = Float.MAX_VALUE
                            pts.forEachIndexed { idx, pt ->
                                val screenX = (pt.x / fullW) * drawW + dx
                                val screenY = (pt.y / fullH) * drawH + dy
                                val dist = kotlin.math.hypot(
                                    (down.position.x - screenX).toDouble(),
                                    (down.position.y - screenY).toDouble()
                                ).toFloat()
                                if (dist <= hitRadius && dist < minDist) {
                                    minDist = dist
                                    closestIdx = idx
                                }
                            }

                            if (closestIdx != -1) {
                                draggedIndex = closestIdx
                                latestDraggingChanged(true)
                                down.consume()

                                val initialScreenX = (pts[closestIdx].x / fullW) * drawW + dx
                                val initialScreenY = (pts[closestIdx].y / fullH) * drawH + dy
                                val touchOffsetX = initialScreenX - down.position.x
                                val touchOffsetY = initialScreenY - down.position.y

                                try {
                                    while (true) {
                                        val moveEvent = awaitPointerEvent()
                                        val change = moveEvent.changes.firstOrNull { it.id == down.id } ?: break
                                        if (!change.pressed) {
                                            change.consume()
                                            break
                                        }
                                        change.consume()

                                        val currentPinScreenX = change.position.x + touchOffsetX
                                        val currentPinScreenY = change.position.y + touchOffsetY
                                        val curImgX = ((currentPinScreenX - dx) / drawW * fullW).coerceIn(0f, fullW)
                                        val curImgY = ((currentPinScreenY - dy) / drawH * fullH).coerceIn(0f, fullH)
                                        val curList = liveCorners.toList().toMutableList()
                                        curList[closestIdx] = ImagePoint(curImgX, curImgY)
                                        val movedCorners = FieldCorners(curList[0], curList[1], curList[2], curList[3])
                                        liveCorners = movedCorners
                                        latestCornersChanged(movedCorners)
                                    }
                                } finally {
                                    draggedIndex = null
                                    latestDraggingChanged(false)
                                }
                            }
                        }
                    }
                }
        ) {
            val aspect = fullW / fullH
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
                Offset((p.x / fullW) * drawW + dx, (p.y / fullH) * drawH + dy)
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
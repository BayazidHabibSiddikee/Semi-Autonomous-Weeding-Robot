package com.weedlaser.bev.presentation

import android.graphics.BitmapFactory
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
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
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import com.weedlaser.bev.data.remote.NormalizedPoint
import java.io.File

/**
 * Zero-corner farmer interface rendering ONLY the warped 2D Top-Down BEV image
 * (downloaded from Pi's GET /bev_image or generated locally when offline) so
 * auto-segmented furrow lines and Start/End taps live in exact BEV coordinates.
 */
@Composable
fun StartEndPointCard(
    bevImagePath: String?,
    isPiBev: Boolean,
    isUploading: Boolean,
    furrowsNx: List<Float>,
    startPoint: NormalizedPoint?,
    endPoint: NormalizedPoint?,
    onTakePhotoClick: () -> Unit,
    onPickPhotoClick: () -> Unit,
    onStartPointChanged: (NormalizedPoint) -> Unit,
    onEndPointChanged: (NormalizedPoint?) -> Unit,
) {
    val lang = LocalAppLanguage.current
    var selectingEnd by remember(bevImagePath) { mutableStateOf(false) }

    val bitmap = remember(bevImagePath) {
        bevImagePath?.let { path ->
            val f = File(path)
            if (f.exists()) BitmapFactory.decodeFile(f.absolutePath) else null
        }
    }

    Column(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Button(
                onClick = onTakePhotoClick,
                enabled = !isUploading,
                modifier = Modifier.weight(1f),
            ) {
                Text(Strings.snapPhoto(lang))
            }
            OutlinedButton(
                onClick = onPickPhotoClick,
                enabled = !isUploading,
                modifier = Modifier.weight(1f),
            ) {
                Text(Strings.pickPhoto(lang))
            }
        }

        Spacer(Modifier.height(10.dp))

        if (isUploading) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(220.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(MaterialTheme.colorScheme.surfaceVariant),
                contentAlignment = Alignment.Center,
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    CircularProgressIndicator()
                    Spacer(Modifier.height(10.dp))
                    Text(
                        text = if (lang == AppLanguage.BN) {
                            "Pi-তে ছবি প্রক্রিয়াকরণ ও BEV ম্যাপ ডাউনলোড হচ্ছে..."
                        } else {
                            "Uploading photo & downloading Pi top-down BEV map..."
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            return
        }

        if (bitmap == null) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(220.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(MaterialTheme.colorScheme.surfaceVariant),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = Strings.emptyMapHint(lang),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(16.dp),
                )
            }
            return
        }

        // Toggle between placing Start vs End point on the top-down BEV map
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedButton(
                onClick = { selectingEnd = false },
                modifier = Modifier.weight(1f),
            ) {
                Text(
                    text = Strings.tapStartMode(lang, active = !selectingEnd),
                    fontWeight = if (!selectingEnd) FontWeight.Bold else FontWeight.Normal,
                    maxLines = 1,
                )
            }
            OutlinedButton(
                onClick = { selectingEnd = true },
                modifier = Modifier.weight(1f),
            ) {
                Text(
                    text = Strings.tapEndMode(lang, active = selectingEnd),
                    fontWeight = if (selectingEnd) FontWeight.Bold else FontWeight.Normal,
                    maxLines = 1,
                )
            }
            if (endPoint != null) {
                TextButton(onClick = { onEndPointChanged(null) }) {
                    Text(Strings.clearEnd(lang))
                }
            }
        }

        Spacer(Modifier.height(8.dp))

        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(280.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(Color.Black)
                .pointerInput(bitmap, selectingEnd) {
                    detectTapGestures { offset ->
                        val w = size.width.toFloat().coerceAtLeast(1f)
                        val h = size.height.toFloat().coerceAtLeast(1f)
                        val imgW = bitmap.width.toFloat()
                        val imgH = bitmap.height.toFloat()
                        val aspect = imgW / imgH
                        var drawW = w
                        var drawH = h
                        if (drawW / drawH > aspect) drawW = drawH * aspect else drawH = drawW / aspect
                        val dx = (w - drawW) / 2f
                        val dy = (h - drawH) / 2f

                        val nx = ((offset.x - dx) / drawW).coerceIn(0.02f, 0.98f)
                        val ny = ((offset.y - dy) / drawH).coerceIn(0.02f, 0.98f)
                        val tapped = NormalizedPoint(nx, ny)
                        if (!selectingEnd) {
                            onStartPointChanged(tapped)
                            selectingEnd = true
                        } else {
                            onEndPointChanged(tapped)
                        }
                    }
                }
        ) {
            Canvas(modifier = Modifier.matchParentSize()) {
                val imgW = bitmap.width.toFloat()
                val imgH = bitmap.height.toFloat()
                val aspect = imgW / imgH
                var drawW = size.width
                var drawH = size.height
                if (drawW / drawH > aspect) drawW = drawH * aspect else drawH = drawW / aspect
                val dx = (size.width - drawW) / 2f
                val dy = (size.height - drawH) / 2f

                drawImage(
                    image = bitmap.asImageBitmap(),
                    srcOffset = IntOffset.Zero,
                    srcSize = IntSize(bitmap.width, bitmap.height),
                    dstOffset = IntOffset(dx.toInt(), dy.toInt()),
                    dstSize = IntSize(drawW.toInt(), drawH.toInt()),
                )

                // Overlay auto-segmented traversable furrows (exact BEV X columns)
                furrowsNx.forEach { fx ->
                    val x = dx + fx * drawW
                    drawLine(
                        color = Color(0xAAFFEB3B),
                        start = Offset(x, dy),
                        end = Offset(x, dy + drawH),
                        strokeWidth = 2.5f,
                    )
                }

                // Draw Start marker (green) once user taps
                startPoint?.let { sp ->
                    val cx = dx + sp.nx * drawW
                    val cy = dy + sp.ny * drawH
                    drawCircle(color = Color(0xFF00E676), radius = 15f, center = Offset(cx, cy))
                    drawCircle(color = Color.White, radius = 5.5f, center = Offset(cx, cy))
                }

                // Draw End marker (red) if placed
                endPoint?.let { ep ->
                    val cx = dx + ep.nx * drawW
                    val cy = dy + ep.ny * drawH
                    drawCircle(color = Color(0xFFFF5252), radius = 15f, center = Offset(cx, cy))
                    drawCircle(color = Color.White, radius = 5.5f, center = Offset(cx, cy))
                }
            }
        }

        Spacer(Modifier.height(6.dp))
        Text(
            text = Strings.bevCoordinateLegend(lang, isPiBev),
            style = MaterialTheme.typography.bodySmall,
            color = if (isPiBev) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
        )
        if (startPoint == null) {
            Spacer(Modifier.height(2.dp))
            Text(
                text = Strings.tapToPlaceStartHint(lang),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

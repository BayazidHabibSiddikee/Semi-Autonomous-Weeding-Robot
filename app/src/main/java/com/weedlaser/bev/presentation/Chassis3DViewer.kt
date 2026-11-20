package com.weedlaser.bev.presentation

import android.content.Context
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.cos
import kotlin.math.sin

class ChassisMeshData(
    val vertices: FloatArray, // x,y,z grouped
    val edges: IntArray,       // pairs of vertex indices for clean wireframe
    val numTriangles: Int
)

suspend fun loadChassisMesh(context: Context): ChassisMeshData? = withContext(Dispatchers.IO) {
    try {
        val inputStream: InputStream = context.assets.open("chassis.bin")
        val bytes = inputStream.readBytes()
        inputStream.close()

        val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        val numVertices = buffer.int
        val numIndices = buffer.int

        val vertices = FloatArray(numVertices * 3)
        for (i in 0 until numVertices * 3) {
            vertices[i] = buffer.float
        }

        val rawIndices = IntArray(numIndices)
        for (i in 0 until numIndices) {
            rawIndices[i] = buffer.int
        }

        // To render a crisp, fast wireframe/solid hybrid, extract unique edges or sample triangles
        // A step of 2 or 3 gives high visual clarity without GPU overdraw
        val edgeList = mutableListOf<Int>()
        for (i in 0 until numIndices step 3) {
            val i0 = rawIndices[i]
            val i1 = rawIndices[i + 1]
            val i2 = rawIndices[i + 2]
            edgeList.add(i0)
            edgeList.add(i1)
            edgeList.add(i1)
            edgeList.add(i2)
            edgeList.add(i2)
            edgeList.add(i0)
        }

        ChassisMeshData(vertices, edgeList.toIntArray(), numIndices / 3)
    } catch (e: Throwable) {
        android.util.Log.e("Chassis3D", "Error loading chassis mesh: ${e.message}", e)
        null
    }
}

@Composable
fun Chassis3DViewerCard() {
    val context = LocalContext.current
    val lang = LocalAppLanguage.current
    val isBn = (lang == AppLanguage.BN)

    var meshData by remember { mutableStateOf<ChassisMeshData?>(null) }
    var isLoading by remember { mutableStateOf(true) }

    // Interactive rotation angles (pitch and yaw in degrees)
    var rotX by remember { mutableFloatStateOf(25f) }
    var rotY by remember { mutableFloatStateOf(45f) }
    var zoomScale by remember { mutableFloatStateOf(1.0f) }

    LaunchedEffect(Unit) {
        meshData = loadChassisMesh(context)
        isLoading = false
    }

    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(Modifier.padding(16.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = if (isBn) "🤖 রোবট চ্যাসিস ৩ডি মডেল (3D Interactive Bot)" else "🤖 3D Robot Chassis (Interactive View)",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold
                    )
                    Text(
                        text = if (isBn) "FreeCAD (weed_robot_chassis.FCStd) থেকে সরাসরি এক্সট্রাক্টকৃত" else "Directly extracted from FreeCAD (.FCStd CAD model)",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                OutlinedButton(
                    onClick = {
                        rotX = 25f
                        rotY = 45f
                        zoomScale = 1.0f
                    }
                ) {
                    Text(if (isBn) "রিসেট" else "Reset", fontSize = 12.sp)
                }
            }

            Spacer(Modifier.height(10.dp))

            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(300.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(Color(0xFF1E281E))
                    .pointerInput(Unit) {
                        detectDragGestures { change, dragAmount ->
                            change.consume()
                            // Smooth interactive 3D orbit
                            rotY = (rotY + dragAmount.x * 0.5f) % 360f
                            rotX = (rotX - dragAmount.y * 0.5f).coerceIn(-85f, 85f)
                        }
                    },
                contentAlignment = Alignment.Center
            ) {
                if (isLoading) {
                    CircularProgressIndicator(color = Color(0xFF00E5FF))
                } else if (meshData == null) {
                    Text(
                        if (isBn) "৩ডি মডেল লোড করা যায়নি" else "Failed to load 3D model",
                        color = Color.White
                    )
                } else {
                    val data = meshData!!
                    Canvas(modifier = Modifier.fillMaxSize()) {
                        val cx = size.width / 2f
                        val cy = size.height / 2f
                        val baseScale = (size.width.coerceAtMost(size.height) * 0.42f) * zoomScale

                        val radX = Math.toRadians(rotX.toDouble()).toFloat()
                        val radY = Math.toRadians(rotY.toDouble()).toFloat()

                        val cosX = cos(radX)
                        val sinX = sin(radX)
                        val cosY = cos(radY)
                        val sinY = sin(radY)

                        val verts = data.vertices
                        val numV = verts.size / 3
                        val projX = FloatArray(numV)
                        val projY = FloatArray(numV)
                        val projZ = FloatArray(numV)

                        // 3D rotation and projection
                        for (i in 0 until numV) {
                            val x0 = verts[i * 3]
                            val y0 = verts[i * 3 + 1]
                            val z0 = verts[i * 3 + 2]

                            // Rotate around Y axis
                            val x1 = x0 * cosY + z0 * sinY
                            val y1 = y0
                            val z1 = -x0 * sinY + z0 * cosY

                            // Rotate around X axis
                            val x2 = x1
                            val y2 = y1 * cosX - z1 * sinX
                            val z2 = y1 * sinX + z1 * cosX

                            // Weak perspective projection
                            val distance = 3.2f
                            val factor = distance / (distance - z2 * 0.65f)

                            projX[i] = cx + x2 * baseScale * factor
                            projY[i] = cy - y2 * baseScale * factor // invert Y for screen space
                            projZ[i] = z2
                        }

                        // Draw grid floor for depth
                        val gridRadius = baseScale * 1.2f
                        for (g in -3..3) {
                            val offset = g * (gridRadius / 3f)
                            drawLine(
                                color = Color(0x2281C784),
                                start = Offset(cx - gridRadius, cy + baseScale * 0.8f + offset * 0.3f),
                                end = Offset(cx + gridRadius, cy + baseScale * 0.8f + offset * 0.3f),
                                strokeWidth = 1f
                            )
                        }

                        // Render structural wireframe lines with depth coloring
                        val edges = data.edges
                        val edgeColorFront = Color(0xFF00E5FF)
                        val edgeColorBack = Color(0xFF00796B)

                        for (e in 0 until edges.size step 2) {
                            val v1 = edges[e]
                            val v2 = edges[e + 1]

                            val avgZ = (projZ[v1] + projZ[v2]) / 2f
                            // Depth-based intensity
                            val alpha = ((avgZ + 1f) / 2f).coerceIn(0.25f, 1f)
                            val lineColor = if (avgZ > 0) edgeColorFront.copy(alpha = alpha) else edgeColorBack.copy(alpha = alpha)

                            drawLine(
                                color = lineColor,
                                start = Offset(projX[v1], projY[v1]),
                                end = Offset(projX[v2], projY[v2]),
                                strokeWidth = if (avgZ > 0.2f) 1.8f else 1.1f
                            )
                        }
                    }
                }

                // Overlay control badge
                Box(
                    modifier = Modifier
                        .align(Alignment.BottomStart)
                        .padding(8.dp)
                        .background(Color(0x99000000), RoundedCornerShape(6.dp))
                        .padding(horizontal = 8.dp, vertical = 4.dp)
                ) {
                    Text(
                        text = if (isBn) "🖐️ আঙুল দিয়ে ঘুরিয়ে দেখুন (360° Orbit)" else "🖐️ Drag to rotate 360°",
                        color = Color.White,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Medium
                    )
                }
            }

            Spacer(Modifier.height(8.dp))

            // Zoom slider
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = if (isBn) "জুম (Zoom):" else "Zoom:",
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(end = 8.dp)
                )
                Slider(
                    value = zoomScale,
                    onValueChange = { zoomScale = it },
                    valueRange = 0.6f..1.8f,
                    colors = SliderDefaults.colors(thumbColor = MaterialTheme.colorScheme.primary),
                    modifier = Modifier.weight(1f)
                )
            }
        }
    }
}

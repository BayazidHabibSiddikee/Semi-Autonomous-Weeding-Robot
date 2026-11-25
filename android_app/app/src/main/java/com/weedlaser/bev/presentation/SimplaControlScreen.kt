package com.weedlaser.bev.presentation

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.weedlaser.bev.data.remote.WifiNetworkBinder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

@Composable
fun SimplaControlScreen() {
    val context = LocalContext.current
    var host by remember { mutableStateOf("10.42.0.1") }
    // Fixed default password/token matching Pi Wi-Fi hotspot ("bayazid" / "12345678")
    var token by remember { mutableStateOf("12345678") }
    var mode by remember { mutableStateOf("manual") }
    var connected by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf(JSONObject()) }
    var liveBitmap by remember { mutableStateOf<Bitmap?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val wifiBinder = remember { WifiNetworkBinder(context) }
    val http = remember {
        OkHttpClient.Builder()
            .connectTimeout(1, TimeUnit.SECONDS)
            .readTimeout(2, TimeUnit.SECONDS)
            .build()
    }
    val jsonType = "application/json".toMediaType()

    suspend fun request(path: String, body: JSONObject? = null): JSONObject = withContext(Dispatchers.IO) {
        val builder = Request.Builder().url("http://$host:8080$path").header("Authorization", "Bearer $token")
        val req = if (body == null) builder.get().build() else builder.post(body.toString().toRequestBody(jsonType)).build()
        http.newCall(req).execute().use { response ->
            val raw = response.body?.string().orEmpty()
            if (!response.isSuccessful) throw IllegalStateException("HTTP ${response.code}: $raw")
            JSONObject(raw)
        }
    }

    suspend fun fetchFrame(): Bitmap? = withContext(Dispatchers.IO) {
        val req = Request.Builder()
            .url("http://$host:8080/api/frame.jpg")
            .header("Authorization", "Bearer $token")
            .get()
            .build()
        http.newCall(req).execute().use { response ->
            if (!response.isSuccessful) return@withContext null
            val bytes = response.body?.bytes() ?: return@withContext null
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        }
    }

    LaunchedEffect(Unit) {
        wifiBinder.bindToWifiHotspot()
    }

    // Status poll loop
    LaunchedEffect(host, token) {
        while (true) {
            if (token.isBlank()) {
                connected = false
                error = "Enter Pi password (default: 12345678)."
            } else {
                runCatching { request("/api/status") }
                    .onSuccess {
                        status = it
                        connected = true
                        mode = it.optString("mode", mode)
                        error = null
                    }
                    .onFailure {
                        connected = false
                        error = it.message
                    }
            }
            delay(500)
        }
    }

    // Live camera + action overlay frame poll loop (~10 FPS)
    LaunchedEffect(host, token, connected) {
        while (true) {
            if (connected && token.isNotBlank()) {
                runCatching { fetchFrame() }
                    .onSuccess { bmp -> if (bmp != null) liveBitmap = bmp }
            }
            delay(100)
        }
    }

    suspend fun driveDir(angle: Int, speed: Int = 28) {
        request("/api/dir", JSONObject().put("angle", angle).put("speed", speed))
    }

    fun setMode(next: String) {
        scope.launch {
            runCatching { request("/api/mode", JSONObject().put("mode", next)) }
                .onSuccess { mode = next; error = null }
                .onFailure { error = it.message }
        }
    }

    fun stop() {
        scope.launch {
            runCatching { request("/api/stop", JSONObject()) }
                .onFailure { error = it.message }
        }
    }

    fun setServo(deg: Int) {
        scope.launch {
            runCatching { request("/api/servo", JSONObject().put("angle_deg", deg.coerceIn(-30, 30))) }
                .onSuccess { error = null }
                .onFailure { error = it.message }
        }
    }

    fun fireArc(action: String, durationMs: Int = 800) {
        scope.launch {
            runCatching {
                request("/api/arc", JSONObject().put("action", action).put("duration_ms", durationMs))
            }
                .onSuccess { error = null }
                .onFailure { error = it.message }
        }
    }

    val esp32Ready = connected && status.optBoolean("esp32_online")
    val liveAction = status.optString("last_action", if (connected) "READY" else "OFFLINE")

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("SIMPLA BOT · 8-WAY", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                Text(
                    text = if (connected) {
                        "Pi connected (Wi-Fi: bayazid) · ESP32 ${if (!status.optBoolean("esp32_responding")) "no heartbeat" else if (status.optBoolean("esp32_estop_ok")) "ready" else "E-stop open"}"
                    } else {
                        "Connect phone Wi-Fi to \"bayazid\" (pass: 12345678)"
                    },
                    color = if (esp32Ready) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            AssistChip(
                onClick = {
                    scope.launch {
                        wifiBinder.bindToWifiHotspot()
                        runCatching { request("/api/status") }
                            .onSuccess { status = it; connected = true; error = null }
                            .onFailure { error = it.message }
                    }
                },
                label = { Text("Bind Wi-Fi") },
            )
        }

        // Live Camera + Action Video Feed Card
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("Live Camera & Action", fontWeight = FontWeight.Bold)
                    Surface(
                        color = if (mode == "autonomous") MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.secondaryContainer,
                        shape = RoundedCornerShape(8.dp),
                    ) {
                        Text(
                            text = liveAction,
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                            style = MaterialTheme.typography.labelMedium,
                            fontWeight = FontWeight.SemiBold,
                        )
                    }
                }
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(210.dp)
                        .clip(RoundedCornerShape(10.dp))
                        .background(Color(0xFF10141A)),
                    contentAlignment = Alignment.Center,
                ) {
                    val bmp = liveBitmap
                    if (bmp != null) {
                        Image(
                            bitmap = bmp.asImageBitmap(),
                            contentDescription = "Live MaixSense Camera Feed",
                            modifier = Modifier.fillMaxSize(),
                            contentScale = ContentScale.Crop,
                        )
                    } else {
                        Text(
                            text = if (connected) "Waiting for Pi camera frame..." else "Connect to Pi hotspot \"bayazid\" to view live feed",
                            color = Color(0xFFB0BEC5),
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                }
            }
        }

        // Auto + Manual Mode Switcher
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = { setMode("manual") },
                enabled = esp32Ready && mode != "manual",
                modifier = Modifier.weight(1f),
            ) { Text("MANUAL") }
            Button(
                onClick = { setMode("autonomous") },
                enabled = esp32Ready && status.optBoolean("camera_online") && mode != "autonomous",
                modifier = Modifier.weight(1f),
            ) { Text("AUTONOMOUS") }
        }

        // 8-Direction Hold-to-Drive D-Pad
        Text("Manual 8-Direction Drive · hold to move", fontWeight = FontWeight.SemiBold)
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(10.dp),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                DirHoldButton("↖", 315, mode, esp32Ready, ::driveDir, ::stop)
                DirHoldButton("▲", 0, mode, esp32Ready, ::driveDir, ::stop)
                DirHoldButton("↗", 45, mode, esp32Ready, ::driveDir, ::stop)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
                DirHoldButton("◀", 270, mode, esp32Ready, ::driveDir, ::stop)
                OutlinedButton(
                    onClick = ::stop,
                    modifier = Modifier.size(72.dp),
                    shape = RoundedCornerShape(16.dp),
                ) { Text("STOP", fontWeight = FontWeight.Bold) }
                DirHoldButton("▶", 90, mode, esp32Ready, ::driveDir, ::stop)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                DirHoldButton("↙", 225, mode, esp32Ready, ::driveDir, ::stop)
                DirHoldButton("▼", 180, mode, esp32Ready, ::driveDir, ::stop)
                DirHoldButton("↘", 135, mode, esp32Ready, ::driveDir, ::stop)
            }
        }

        Button(
            onClick = ::stop,
            colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
            modifier = Modifier.fillMaxWidth().height(50.dp),
        ) {
            Icon(Icons.Default.Warning, contentDescription = null)
            Spacer(Modifier.width(8.dp))
            Text("EMERGENCY SOFTWARE STOP")
        }

        // MG996R Servo (±30° · 50 Hz) + Arc Module Controller
        var servoSlider by remember { mutableFloatStateOf(0f) }
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Turret Servo (MG996R ±30° · 50Hz) & Arc Module", fontWeight = FontWeight.Bold)
                Text("Angle: ${servoSlider.toInt()}° (ESP32: ${status.optInt("servo_deg", 0)}°)")
                Slider(
                    value = servoSlider,
                    onValueChange = { servoSlider = it },
                    onValueChangeFinished = { setServo(servoSlider.toInt()) },
                    valueRange = -30f..30f,
                    steps = 11,
                    enabled = esp32Ready,
                )
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { servoSlider = -30f; setServo(-30) }, enabled = esp32Ready, modifier = Modifier.weight(1f)) { Text("-30°") }
                    OutlinedButton(onClick = { servoSlider = 0f; setServo(0) }, enabled = esp32Ready, modifier = Modifier.weight(1f)) { Text("0°") }
                    OutlinedButton(onClick = { servoSlider = 30f; setServo(30) }, enabled = esp32Ready, modifier = Modifier.weight(1f)) { Text("+30°") }
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = { fireArc("pulse", 800) },
                        enabled = esp32Ready && mode == "manual" && !status.optBoolean("moving"),
                        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.tertiary),
                        modifier = Modifier.weight(1f),
                    ) { Text("ARC PULSE (0.8s)") }
                    OutlinedButton(
                        onClick = { fireArc("off", 0) },
                        enabled = esp32Ready,
                        modifier = Modifier.weight(0.6f),
                    ) { Text("ARC OFF") }
                }
            }
        }

        // Telemetry Card
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Robot Telemetry", fontWeight = FontWeight.Bold)
                Text("Mode: ${mode.uppercase()} · Moving: ${status.optBoolean("moving")} · Heading: ${status.optInt("heading_8way", 0)}°")
                Text("Camera: ${if (status.optBoolean("camera_online")) "Fresh" else "Waiting"} · ESP32: ${if (!status.optBoolean("esp32_responding")) "offline" else if (status.optBoolean("esp32_estop_ok")) "ready" else "E-stop open"}")
                val d = status.optJSONObject("distances_mm")
                Text("Depth L/C/R: ${d?.opt("left") ?: "--"} / ${d?.opt("center") ?: "--"} / ${d?.opt("right") ?: "--"} mm")
                Text("Corner: ${status.optString("corner", "--")} · Weed: ${status.optBoolean("weed_detected")}")
                Text("Travel: ${status.optDouble("distance_mm", 0.0).toInt()} mm · Fault: ${status.optString("fault", "none")}")
            }
        }

        // Pi Hotspot Config (pre-filled with bayazid / 12345678)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(selected = host == "10.42.0.1", onClick = { host = "10.42.0.1" }, label = { Text("10.42.0.1") })
            FilterChip(selected = host == "192.168.4.1", onClick = { host = "192.168.4.1" }, label = { Text("192.168.4.1") })
        }
        OutlinedTextField(value = host, onValueChange = { host = it.trim() }, label = { Text("Pi hotspot IP") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(value = token, onValueChange = { token = it.trim() }, label = { Text("Pi Password / Token (default: 12345678)") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())

        error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
    }
}

@Composable
private fun DirHoldButton(
    label: String,
    angle: Int,
    mode: String,
    connected: Boolean,
    driveDir: suspend (Int, Int) -> Unit,
    stop: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    FilledTonalButton(
        onClick = {},
        enabled = connected && mode == "manual",
        modifier = Modifier.size(72.dp).pointerInput(mode, connected, angle) {
            detectTapGestures(onPress = {
                if (connected && mode == "manual") {
                    val sender = scope.launch {
                        while (true) {
                            runCatching { driveDir(angle, 28) }
                            delay(150)
                        }
                    }
                    try { awaitRelease() } finally { sender.cancel(); stop() }
                }
            })
        },
        shape = RoundedCornerShape(16.dp),
    ) { Text(label, style = MaterialTheme.typography.headlineSmall) }
}

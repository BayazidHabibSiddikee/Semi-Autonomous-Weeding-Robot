package com.weedlaser.bev.presentation

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import androidx.compose.foundation.Canvas
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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
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
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.SocketTimeoutException
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

enum class ControlTransport {
    PI_HUB,
    DIRECT_ESP32,
}

@Composable
fun SimplaControlScreen() {
    val context = LocalContext.current
    var transport by remember { mutableStateOf(ControlTransport.PI_HUB) }
    var host by remember { mutableStateOf("10.42.0.1") }
    var esp32Host by remember { mutableStateOf("192.168.4.1") }
    // Fixed default password/token matching Pi Wi-Fi hotspot ("bayazid" / "12345678")
    var token by remember { mutableStateOf("12345678") }
    var mode by remember { mutableStateOf("autonomous") }
    var showManualControls by remember { mutableStateOf(false) }
    var connected by remember { mutableStateOf(false) }
    var piConnected by remember { mutableStateOf(false) }
    var espConnected by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf(JSONObject()) }
    var espStatus by remember { mutableStateOf(JSONObject()) }
    var liveBitmap by remember { mutableStateOf<Bitmap?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var servoSlider by remember { mutableFloatStateOf(0f) }
    var driveSpeed by remember { mutableIntStateOf(28) }
    var arcDurationMs by remember { mutableIntStateOf(800) }

    val scope = rememberCoroutineScope()
    val wifiBinder = remember { WifiNetworkBinder(context) }
    val http = remember {
        OkHttpClient.Builder()
            .connectTimeout(1, TimeUnit.SECONDS)
            .readTimeout(2, TimeUnit.SECONDS)
            .build()
    }
    val jsonType = "application/json".toMediaType()

    suspend fun requestPi(path: String, body: JSONObject? = null): JSONObject = withContext(Dispatchers.IO) {
        val builder = Request.Builder().url("http://$host:8080$path").header("Authorization", "Bearer $token")
        val req = if (body == null) builder.get().build() else builder.post(body.toString().toRequestBody(jsonType)).build()
        http.newCall(req).execute().use { response ->
            val raw = response.body?.string().orEmpty()
            if (!response.isSuccessful) throw IllegalStateException("HTTP ${response.code}: $raw")
            JSONObject(raw)
        }
    }

    suspend fun requestEsp32Cmd(cmd: String): String = withContext(Dispatchers.IO) {
        val enc = URLEncoder.encode(cmd, "UTF-8")
        val req = Request.Builder().url("http://$esp32Host:8081/cmd?q=$enc").get().build()
        http.newCall(req).execute().use { response ->
            val raw = response.body?.string().orEmpty()
            if (!response.isSuccessful) throw IllegalStateException("ESP32 HTTP ${response.code}: $raw")
            raw
        }
    }

    suspend fun requestEsp32Status(): JSONObject = withContext(Dispatchers.IO) {
        val req = Request.Builder().url("http://$esp32Host:8081/status").get().build()
        http.newCall(req).execute().use { response ->
            val raw = response.body?.string().orEmpty()
            if (!response.isSuccessful) throw IllegalStateException("ESP32 HTTP ${response.code}: $raw")
            JSONObject(raw)
        }
    }

    suspend fun discoverEsp32Ip(): String? = withContext(Dispatchers.IO) {
        var found: String? = null
        val socket = DatagramSocket().apply {
            broadcast = true
            soTimeout = 1000
        }
        try {
            val msg = "DISCOVER_ESP32".toByteArray()
            for (target in listOf("255.255.255.255", "10.42.0.255", "192.168.4.255")) {
                runCatching {
                    socket.send(DatagramPacket(msg, msg.size, InetAddress.getByName(target), 8082))
                }
            }
            val buf = ByteArray(512)
            val pkt = DatagramPacket(buf, buf.size)
            try {
                socket.receive(pkt)
                val txt = String(pkt.data, 0, pkt.length)
                val obj = JSONObject(txt)
                found = obj.optString("ip").takeIf { it.isNotBlank() } ?: pkt.address.hostAddress
            } catch (_: SocketTimeoutException) {
            }
        } finally {
            socket.close()
        }
        found
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

    // Pi Hub status poll loop (independent so ESP32 timeouts never slow down Pi checks)
    LaunchedEffect(transport, host, token) {
        while (true) {
            if (token.isNotBlank()) {
                runCatching { requestPi("/api/status") }
                    .onSuccess {
                        status = it
                        piConnected = true
                        mode = it.optString("mode", mode)
                        val piEspIp = it.optString("esp32_ip", "")
                        if (piEspIp.isNotBlank() && piEspIp != "null" && esp32Host == "192.168.4.1") {
                            esp32Host = piEspIp
                        }
                        if (transport == ControlTransport.PI_HUB) {
                            connected = true
                            error = null
                        }
                    }
                    .onFailure {
                        piConnected = false
                        if (transport == ControlTransport.PI_HUB) {
                            connected = false
                            error = it.message
                        }
                    }
            } else {
                piConnected = false
            }
            delay(500)
        }
    }

    // Direct ESP32 status poll loop (independent)
    LaunchedEffect(transport, esp32Host) {
        while (true) {
            runCatching { requestEsp32Status() }
                .onSuccess {
                    espStatus = it
                    espConnected = true
                    if (transport == ControlTransport.DIRECT_ESP32) {
                        status = it
                        connected = true
                        error = null
                    }
                }
                .onFailure {
                    espConnected = false
                    if (transport == ControlTransport.DIRECT_ESP32) {
                        connected = false
                        error = it.message
                    }
                }
            delay(800)
        }
    }

    // Live camera + action overlay frame poll loop (whenever Pi Hub is connected)
    LaunchedEffect(host, token, piConnected) {
        while (true) {
            if (piConnected && token.isNotBlank()) {
                runCatching { fetchFrame() }
                    .onSuccess { bmp -> if (bmp != null) liveBitmap = bmp }
            }
            delay(120)
        }
    }

    suspend fun driveDir(angle: Int, speed: Int = 28) {
        if (transport == ControlTransport.PI_HUB && piConnected) {
            requestPi("/api/dir", JSONObject().put("angle", angle).put("speed", speed))
        } else {
            requestEsp32Cmd("DIR $angle $speed")
        }
    }

    fun setMode(next: String) {
        if (!piConnected) return
        scope.launch {
            runCatching { requestPi("/api/mode", JSONObject().put("mode", next)) }
                .onSuccess { mode = next; error = null }
                .onFailure { error = it.message }
        }
    }

    fun stop() {
        scope.launch {
            runCatching {
                if (transport == ControlTransport.PI_HUB && piConnected) requestPi("/api/stop", JSONObject())
                else requestEsp32Cmd("STOP")
            }.onFailure { error = it.message }
        }
    }

    fun setServo(deg: Int) {
        val clamped = deg.coerceIn(-30, 30)
        scope.launch {
            runCatching {
                if (transport == ControlTransport.PI_HUB && piConnected) {
                    requestPi("/api/servo", JSONObject().put("angle_deg", clamped))
                } else {
                    requestEsp32Cmd("SERVO $clamped")
                }
            }.onSuccess { error = null }.onFailure { error = it.message }
        }
    }

    fun fireArc(action: String, durationMs: Int = 800) {
        scope.launch {
            runCatching {
                if (transport == ControlTransport.PI_HUB && piConnected) {
                    requestPi("/api/arc", JSONObject().put("action", action).put("duration_ms", durationMs))
                } else {
                    requestEsp32Cmd(if (action == "off") "ARC OFF" else "ARC $durationMs")
                }
            }.onSuccess { error = null }.onFailure { error = it.message }
        }
    }

    val esp32Ready = (piConnected && status.optBoolean("esp32_online")) || espConnected
    val liveAction = if (piConnected) {
        status.optString("last_action", "READY")
    } else if (espConnected) {
        "DIRECT ESP32 · HEADING ${espStatus.optInt("heading", 0)}°"
    } else {
        "OFFLINE"
    }

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
                    text = "Pi: ${if (piConnected) "ONLINE" else "OFFLINE"} · ESP32: ${if (espConnected) "DIRECT ($esp32Host)" else if (piConnected && status.optBoolean("esp32_online")) "VIA PI (${status.optString("esp32_transport", "ok")})" else "OFFLINE"}",
                    color = if (esp32Ready) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            AssistChip(
                onClick = {
                    scope.launch {
                        wifiBinder.bindToWifiHotspot()
                        if (transport == ControlTransport.DIRECT_ESP32) {
                            val ip = discoverEsp32Ip()
                            if (ip != null) esp32Host = ip
                        }
                    }
                },
                label = { Text(if (transport == ControlTransport.DIRECT_ESP32) "Find ESP32" else "Bind Wi-Fi") },
            )
        }

        // Two-Way Connection Selector: Via Pi Hub OR Direct ESP32
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(
                selected = transport == ControlTransport.PI_HUB,
                onClick = { transport = ControlTransport.PI_HUB },
                label = { Text("Via Pi Hub (:8080)") },
                modifier = Modifier.weight(1f),
            )
            FilterChip(
                selected = transport == ControlTransport.DIRECT_ESP32,
                onClick = {
                    transport = ControlTransport.DIRECT_ESP32
                    scope.launch {
                        val ip = discoverEsp32Ip()
                        if (ip != null) esp32Host = ip
                    }
                },
                label = { Text("Direct ESP32 (:8081)") },
                modifier = Modifier.weight(1f),
            )
        }

        // Live Camera + Action Video Feed Card (Pi Hub)
        if (transport == ControlTransport.PI_HUB) {
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
                    // Live Telemetry Strip
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Text(
                            "Model: ${status.optString("model_name", "yolo26n")}",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Text(
                            "Weeds: ${status.optInt("weeds_count", 0)}",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.primary,
                            fontWeight = FontWeight.Bold,
                        )
                        Text(
                            "ESP32: ${status.optString("esp32_transport", "none").uppercase()}",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }

            // Auto + Manual Mode Switcher
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = { setMode("autonomous"); showManualControls = false },
                    enabled = esp32Ready && status.optBoolean("camera_online") && mode != "autonomous",
                    modifier = Modifier.weight(1f),
                ) { Text("AUTONOMOUS") }
                OutlinedButton(
                    onClick = { setMode("manual"); showManualControls = true },
                    enabled = esp32Ready && mode != "manual",
                    modifier = Modifier.weight(1f),
                ) { Text("MANUAL") }
            }

            // Live AI Model & Virtual Rover Simulation Widgets (Default View)
            ModelSimulationWidgets(status = status, mode = mode)

            // Field Photo -> Pi Boustrophedon Map Generator (:8000)
            FieldMapGeneratorCard(
                host = host,
                token = token,
                http = http,
            )
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

        // Physical Controls Toggle (Hidden by default so Autonomous Simulation is primary)
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column {
                Text("Manual Physical Controls", fontWeight = FontWeight.SemiBold)
                Text("8-Way Drive, Servo & Arc Override", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Switch(
                checked = showManualControls,
                onCheckedChange = { showManualControls = it },
            )
        }

        if (showManualControls) {
            // 8-Direction Hold-to-Drive D-Pad + Speed Selector
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("8-Direction Drive · hold to move", fontWeight = FontWeight.SemiBold)
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    listOf(18 to "Slow", 28 to "Med", 35 to "Fast").forEach { (spd, label) ->
                        FilterChip(
                            selected = driveSpeed == spd,
                            onClick = { driveSpeed = spd },
                            label = { Text(label, style = MaterialTheme.typography.labelSmall) },
                        )
                    }
                }
            }
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(10.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    DirHoldButton("↖", 315, driveSpeed, mode, esp32Ready, ::driveDir, ::stop)
                    DirHoldButton("▲", 0, driveSpeed, mode, esp32Ready, ::driveDir, ::stop)
                    DirHoldButton("↗", 45, driveSpeed, mode, esp32Ready, ::driveDir, ::stop)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
                    DirHoldButton("◀", 270, driveSpeed, mode, esp32Ready, ::driveDir, ::stop)
                    OutlinedButton(
                        onClick = ::stop,
                        modifier = Modifier.size(72.dp),
                        shape = RoundedCornerShape(16.dp),
                    ) { Text("STOP", fontWeight = FontWeight.Bold) }
                    DirHoldButton("▶", 90, driveSpeed, mode, esp32Ready, ::driveDir, ::stop)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    DirHoldButton("↙", 225, driveSpeed, mode, esp32Ready, ::driveDir, ::stop)
                    DirHoldButton("▼", 180, driveSpeed, mode, esp32Ready, ::driveDir, ::stop)
                    DirHoldButton("↘", 135, driveSpeed, mode, esp32Ready, ::driveDir, ::stop)
                }
            }

            // MG996R Servo (±30° · 50 Hz) + Arc Module Controller
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
                        listOf(400 to "0.4s", 800 to "0.8s", 1500 to "1.5s").forEach { (ms, lbl) ->
                            FilterChip(
                                selected = arcDurationMs == ms,
                                onClick = { arcDurationMs = ms },
                                label = { Text(lbl) },
                            )
                        }
                    }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(
                            onClick = { fireArc("pulse", arcDurationMs) },
                            enabled = esp32Ready && mode == "manual" && !status.optBoolean("moving"),
                            colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.tertiary),
                            modifier = Modifier.weight(1f),
                        ) { Text("ARC PULSE (${arcDurationMs / 1000f}s)") }
                        OutlinedButton(
                            onClick = { fireArc("off", 0) },
                            enabled = esp32Ready,
                            modifier = Modifier.weight(0.6f),
                        ) { Text("ARC OFF") }
                    }
                }
            }
        }

        // Host Config
        if (transport == ControlTransport.PI_HUB) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(selected = host == "10.42.0.1", onClick = { host = "10.42.0.1" }, label = { Text("10.42.0.1") })
                FilterChip(selected = host == "192.168.4.1", onClick = { host = "192.168.4.1" }, label = { Text("192.168.4.1") })
            }
            OutlinedTextField(value = host, onValueChange = { host = it.trim() }, label = { Text("Pi hotspot IP") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(value = token, onValueChange = { token = it.trim() }, label = { Text("Pi Password / Token (default: 12345678)") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
        } else {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                FilterChip(selected = esp32Host == "192.168.4.1", onClick = { esp32Host = "192.168.4.1" }, label = { Text("AP .4.1") })
                FilterChip(selected = esp32Host == "10.42.0.242", onClick = { esp32Host = "10.42.0.242" }, label = { Text("Pi .0.242") })
                FilterChip(selected = esp32Host == "esp32-rover.local", onClick = { esp32Host = "esp32-rover.local" }, label = { Text("mDNS") })
            }
            OutlinedTextField(value = esp32Host, onValueChange = { esp32Host = it.trim() }, label = { Text("ESP32 Direct IP") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        }

        error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
    }
}

@Composable
private fun DirHoldButton(
    label: String,
    angle: Int,
    speed: Int,
    mode: String,
    connected: Boolean,
    driveDir: suspend (Int, Int) -> Unit,
    stop: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    FilledTonalButton(
        onClick = {},
        enabled = connected && mode == "manual",
        modifier = Modifier.size(72.dp).pointerInput(mode, connected, angle, speed) {
            detectTapGestures(onPress = {
                if (connected && mode == "manual") {
                    val sender = scope.launch {
                        while (true) {
                            runCatching { driveDir(angle, speed) }
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

@Composable
private fun ModelSimulationWidgets(status: JSONObject, mode: String) {
    val cutQueue = status.optJSONArray("cut_queue")
    val weedsCount = status.optInt("weeds_count", cutQueue?.length() ?: 0)
    val dir8Way = status.optInt("dir_8way", 0)
    val servoDeg = status.optInt("servo_deg", 0)
    val modelName = status.optString("model_name", "yolo26n_best.onnx")

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("AI Model & Rover Simulation", fontWeight = FontWeight.Bold)
                Surface(
                    color = MaterialTheme.colorScheme.primaryContainer,
                    shape = RoundedCornerShape(6.dp),
                ) {
                    Text(
                        text = mode.uppercase(),
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.Bold,
                    )
                }
            }

            // Live 2D Radar & Turret Simulation Canvas
            Canvas(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(150.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(Color(0xFF0D131A)),
            ) {
                val cx = size.width / 2f
                val cy = size.height * 0.80f

                // Corridor & range rings
                drawCircle(Color(0xFF1E2D3D), radius = size.height * 0.65f, center = Offset(cx, cy), style = Stroke(1.5f))
                drawCircle(Color(0xFF1E2D3D), radius = size.height * 0.35f, center = Offset(cx, cy), style = Stroke(1.5f))
                drawLine(Color(0xFF263849), Offset(cx - 80f, 0f), Offset(cx - 80f, size.height), 1.5f)
                drawLine(Color(0xFF263849), Offset(cx + 80f, 0f), Offset(cx + 80f, size.height), 1.5f)

                // Rover body
                drawRect(Color(0xFF38BDF8), topLeft = Offset(cx - 22f, cy - 12f), size = androidx.compose.ui.geometry.Size(44f, 24f))

                // 8-way steering vector
                val dirRad = Math.toRadians(dir8Way.toDouble())
                val dx = (kotlin.math.sin(dirRad) * 45.0).toFloat()
                val dy = (-kotlin.math.cos(dirRad) * 45.0).toFloat()
                drawLine(Color(0xFF22C55E), Offset(cx, cy), Offset(cx + dx, cy + dy), strokeWidth = 5f)

                // Turret servo beam (-30..+30 deg)
                val servoRad = Math.toRadians(servoDeg.toDouble())
                val sx = (kotlin.math.sin(servoRad) * 95.0).toFloat()
                val sy = (-kotlin.math.cos(servoRad) * 95.0).toFloat()
                drawLine(Color(0xFFF59E0B), Offset(cx, cy - 10f), Offset(cx + sx, cy - 10f + sy), strokeWidth = 3f)

                // Plot detected weeds from cut_queue
                if (cutQueue != null) {
                    for (i in 0 until cutQueue.length()) {
                        val w = cutQueue.optJSONObject(i) ?: continue
                        val xg = w.optDouble("x_ground_mm", 0.0).toFloat()
                        val yf = w.optDouble("y_forward_mm", 80.0).toFloat()
                        val wx = (cx + xg * 0.55f).coerceIn(12f, size.width - 12f)
                        val wy = (cy - 20f - yf * 0.35f).coerceIn(12f, size.height - 12f)
                        val dotColor = if (i == 0) Color(0xFFEF4444) else Color(0xFFF97316)
                        drawCircle(dotColor, radius = if (i == 0) 9f else 6f, center = Offset(wx, wy))
                    }
                }
            }

            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("Model: $modelName", style = MaterialTheme.typography.labelSmall)
                Text("Steer: ${dir8Way}°", style = MaterialTheme.typography.labelSmall)
                Text("Servo: ${servoDeg}°", style = MaterialTheme.typography.labelSmall)
                Text("Weeds: $weedsCount", style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
            }

            if (cutQueue != null && cutQueue.length() > 0) {
                HorizontalDivider()
                for (i in 0 until minOf(cutQueue.length(), 4)) {
                    val w = cutQueue.optJSONObject(i) ?: continue
                    val rank = w.optInt("order_rank", i + 1)
                    val ang = w.optDouble("turret_deg", 0.0).toInt()
                    val dist = w.optDouble("drive_to_cut_mm", 0.0).toInt()
                    Text(
                        text = "#$rank Weed · Turret: ${ang}° · Dist: ${dist}mm (${if (i == 0) "AIMING" else "QUEUED"})",
                        style = MaterialTheme.typography.bodySmall,
                        color = if (i == 0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            } else {
                Text("Scanning furrow with YOLO26n (crops protected)...", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun FieldMapGeneratorCard(
    host: String,
    token: String,
    http: OkHttpClient,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var bevBitmap by remember { mutableStateOf<Bitmap?>(null) }
    var statusText by remember { mutableStateOf("Send a field photo to Pi (:8000) to generate BEV + Boustrophedon map") }
    var busy by remember { mutableStateOf(false) }
    var pendingCameraUri by remember { mutableStateOf<Uri?>(null) }

    fun uploadUriToPi(uri: Uri) {
        scope.launch {
            busy = true
            statusText = "Uploading field image to Pi (:8000/image)..."
            runCatching {
                val bytes = withContext(Dispatchers.IO) {
                    context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
                        ?: error("Unable to read image")
                }
                val body = MultipartBody.Builder()
                    .setType(MultipartBody.FORM)
                    .addFormDataPart("file", "field.jpg", bytes.toRequestBody("image/jpeg".toMediaType()))
                    .build()
                val req = Request.Builder()
                    .url("http://$host:8000/image")
                    .header("Authorization", "Bearer $token")
                    .post(body)
                    .build()
                val uploadResp = withContext(Dispatchers.IO) {
                    http.newCall(req).execute().use { r ->
                        val raw = r.body?.string().orEmpty()
                        if (!r.isSuccessful) error("HTTP ${r.code}: $raw")
                        raw
                    }
                }
                val bevReq = Request.Builder()
                    .url("http://$host:8000/bev_image")
                    .header("Authorization", "Bearer $token")
                    .get()
                    .build()
                val bmp = withContext(Dispatchers.IO) {
                    http.newCall(bevReq).execute().use { r ->
                        if (!r.isSuccessful) null
                        else r.body?.bytes()?.let { b -> BitmapFactory.decodeByteArray(b, 0, b.size) }
                    }
                }
                Pair(uploadResp, bmp)
            }.onSuccess { (_, bmp) ->
                if (bmp != null) bevBitmap = bmp
                statusText = "Boustrophedon BEV Map generated on Pi!"
                busy = false
            }.onFailure { err ->
                statusText = "Map upload failed: ${err.message}"
                busy = false
            }
        }
    }

    val photoPickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.PickVisualMedia()
    ) { uri -> if (uri != null) uploadUriToPi(uri) }

    val takePictureLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.TakePicture()
    ) { ok -> if (ok) pendingCameraUri?.let { uploadUriToPi(it) } }

    fun launchCamera() {
        runCatching {
            val f = File(context.cacheDir, "field_${System.currentTimeMillis()}.jpg")
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", f)
            pendingCameraUri = uri
            takePictureLauncher.launch(uri)
        }.onFailure {
            Toast.makeText(context, "Camera error: ${it.message}", Toast.LENGTH_SHORT).show()
        }
    }

    val camPermLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission()
    ) { granted -> if (granted) launchCamera() }

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Field Image → Pi Boustrophedon Map", fontWeight = FontWeight.Bold)
            Text(statusText, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = {
                        val granted = androidx.core.content.ContextCompat.checkSelfPermission(
                            context, android.Manifest.permission.CAMERA
                        ) == android.content.pm.PackageManager.PERMISSION_GRANTED
                        if (granted) launchCamera() else camPermLauncher.launch(android.Manifest.permission.CAMERA)
                    },
                    enabled = !busy,
                    modifier = Modifier.weight(1f),
                ) { Text("Snap Field") }
                OutlinedButton(
                    onClick = { photoPickerLauncher.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
                    enabled = !busy,
                    modifier = Modifier.weight(1f),
                ) { Text("Pick Image") }
            }
            bevBitmap?.let { bmp ->
                Image(
                    bitmap = bmp.asImageBitmap(),
                    contentDescription = "Pi Generated Boustrophedon BEV Map",
                    modifier = Modifier.fillMaxWidth().height(180.dp).clip(RoundedCornerShape(8.dp)),
                    contentScale = ContentScale.Fit,
                )
            }
        }
    }
}

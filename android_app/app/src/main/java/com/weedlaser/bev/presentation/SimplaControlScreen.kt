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
    var mode by remember { mutableStateOf("manual") }
    var connected by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf(JSONObject()) }
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

    // Status poll loop (switches automatically between Pi Hub and Direct ESP32)
    LaunchedEffect(transport, host, esp32Host, token) {
        while (true) {
            if (transport == ControlTransport.PI_HUB) {
                if (token.isBlank()) {
                    connected = false
                    error = "Enter Pi password (default: 12345678)."
                } else {
                    runCatching { requestPi("/api/status") }
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
            } else {
                mode = "manual"
                runCatching { requestEsp32Status() }
                    .onSuccess {
                        status = it
                        connected = true
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

    // Live camera + action overlay frame poll loop (when using Pi Hub)
    LaunchedEffect(transport, host, token, connected) {
        while (true) {
            if (transport == ControlTransport.PI_HUB && connected && token.isNotBlank()) {
                runCatching { fetchFrame() }
                    .onSuccess { bmp -> if (bmp != null) liveBitmap = bmp }
            }
            delay(100)
        }
    }

    suspend fun driveDir(angle: Int, speed: Int = 28) {
        if (transport == ControlTransport.PI_HUB) {
            requestPi("/api/dir", JSONObject().put("angle", angle).put("speed", speed))
        } else {
            requestEsp32Cmd("DIR $angle $speed")
        }
    }

    fun setMode(next: String) {
        if (transport != ControlTransport.PI_HUB) return
        scope.launch {
            runCatching { requestPi("/api/mode", JSONObject().put("mode", next)) }
                .onSuccess { mode = next; error = null }
                .onFailure { error = it.message }
        }
    }

    fun stop() {
        scope.launch {
            runCatching {
                if (transport == ControlTransport.PI_HUB) requestPi("/api/stop", JSONObject())
                else requestEsp32Cmd("STOP")
            }.onFailure { error = it.message }
        }
    }

    fun setServo(deg: Int) {
        val clamped = deg.coerceIn(-30, 30)
        scope.launch {
            runCatching {
                if (transport == ControlTransport.PI_HUB) {
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
                if (transport == ControlTransport.PI_HUB) {
                    requestPi("/api/arc", JSONObject().put("action", action).put("duration_ms", durationMs))
                } else {
                    requestEsp32Cmd(if (action == "off") "ARC OFF" else "ARC $durationMs")
                }
            }.onSuccess { error = null }.onFailure { error = it.message }
        }
    }

    val esp32Ready = if (transport == ControlTransport.PI_HUB) {
        connected && status.optBoolean("esp32_online")
    } else {
        connected && status.optInt("estop", 0) == 0
    }
    val liveAction = if (transport == ControlTransport.PI_HUB) {
        status.optString("last_action", if (connected) "READY" else "OFFLINE")
    } else {
        if (connected) "DIRECT ESP32 · HEADING ${status.optInt("heading", 0)}°" else "ESP32 OFFLINE"
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
                    text = if (transport == ControlTransport.PI_HUB) {
                        if (connected) {
                            "Pi connected (bayazid) · ESP32 ${if (!status.optBoolean("esp32_responding")) "no heartbeat" else if (status.optBoolean("esp32_estop_ok")) "ready" else "E-stop open"}"
                        } else {
                            "Connect phone Wi-Fi to \"bayazid\" (pass: 12345678)"
                        }
                    } else {
                        if (connected) "Direct ESP32 connected ($esp32Host:8081)"
                        else "Direct ESP32 offline · tap Find ESP32 or join \"esp32-rover\""
                    },
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
        }

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

package com.weedlaser.bev.presentation

import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
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
    var host by remember { mutableStateOf("10.42.0.1") }
    var mode by remember { mutableStateOf("manual") }
    var connected by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf(JSONObject()) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val http = remember { OkHttpClient.Builder().connectTimeout(1, TimeUnit.SECONDS).readTimeout(2, TimeUnit.SECONDS).build() }
    val jsonType = "application/json".toMediaType()

    suspend fun request(path: String, body: JSONObject? = null): JSONObject = withContext(Dispatchers.IO) {
        val builder = Request.Builder().url("http://$host:8080$path")
        val req = if (body == null) builder.get().build() else builder.post(body.toString().toRequestBody(jsonType)).build()
        http.newCall(req).execute().use { response ->
            val raw = response.body?.string().orEmpty()
            if (!response.isSuccessful) throw IllegalStateException("HTTP ${response.code}: $raw")
            JSONObject(raw)
        }
    }
    LaunchedEffect(host) {
        while (true) {
            runCatching { request("/api/status") }
                .onSuccess { status = it; connected = true; mode = it.optString("mode", mode); error = null }
                .onFailure { connected = false; error = it.message }
            delay(700)
        }
    }
    suspend fun drive(left: Int, right: Int) {
        request("/api/drive", JSONObject().put("left", left).put("right", right))
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

    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("SIMPLA BOT", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                Text(if (connected) "Pi connected · ESP32 ${if (status.optBoolean("esp32_online")) "connected" else "offline"}" else "Pi offline", color = if (connected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error)
            }
            AssistChip(onClick = { scope.launch { runCatching { request("/api/status") }.onSuccess { status=it; connected=true }.onFailure { error=it.message } } }, label = { Text("Refresh") })
        }
        OutlinedTextField(value = host, onValueChange = { host = it.trim() }, label = { Text("Pi hotspot IP") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { setMode("manual") }, enabled = connected && mode != "manual", modifier = Modifier.weight(1f)) { Text("MANUAL") }
            Button(onClick = { setMode("autonomous") }, enabled = connected && mode != "autonomous", modifier = Modifier.weight(1f)) { Text("AUTONOMOUS") }
        }
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Robot status", fontWeight = FontWeight.Bold)
                Text("Mode: ${mode.uppercase()}  ·  Moving: ${status.optBoolean("moving")}")
                Text("Camera: ${if (status.optBoolean("camera_online")) "Online" else "Waiting"}  ·  ESP32: ${if (status.optBoolean("esp32_online")) "USB connected" else "Disconnected"}")
                val d = status.optJSONObject("distances_mm")
                Text("Depth L/C/R: ${d?.opt("left") ?: "--"} / ${d?.opt("center") ?: "--"} / ${d?.opt("right") ?: "--"} mm")
                Text("Corner: ${status.optString("corner", "--")}  ·  Weed: ${status.optBoolean("weed_detected")}")
                Text("Travel estimate: ${status.optDouble("distance_mm", 0.0).toInt()} mm")
                Text("Hub: ${status.optString("version", "--")}  ·  Fault: ${status.optString("fault", "none")}")
                Text("Camera frame age: ${status.opt("last_camera_frame_age_s") ?: "--"} s")
                Text("Tools: disabled / dry-run", color = MaterialTheme.colorScheme.secondary)
            }
        }
        Text("Manual drive · hold a direction", fontWeight = FontWeight.SemiBold)
        Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
            DriveHoldButton("▲", 28, 28, mode, connected, ::drive, ::stop)
            Row(horizontalArrangement = Arrangement.spacedBy(24.dp), verticalAlignment = Alignment.CenterVertically) {
                DriveHoldButton("◀", -22, 22, mode, connected, ::drive, ::stop)
                OutlinedButton(onClick = ::stop, modifier = Modifier.size(88.dp), shape = RoundedCornerShape(18.dp)) { Text("STOP", fontWeight = FontWeight.Bold) }
                DriveHoldButton("▶", 22, -22, mode, connected, ::drive, ::stop)
            }
            DriveHoldButton("▼", -28, -28, mode, connected, ::drive, ::stop)
        }
        Button(onClick = ::stop, colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error), modifier = Modifier.fillMaxWidth().height(52.dp)) {
            Icon(Icons.Default.Warning, contentDescription = null)
            Spacer(Modifier.width(8.dp))
            Text("EMERGENCY SOFTWARE STOP")
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        Text("A physical, hard-wired emergency stop is still required. Do not use the phone stop as the safety disconnect.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
    }
}

@Composable
private fun DriveHoldButton(
    label: String, left: Int, right: Int, mode: String, connected: Boolean,
    drive: suspend (Int, Int) -> Unit, stop: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    FilledTonalButton(
        onClick = {},
        enabled = connected && mode == "manual",
        modifier = Modifier.size(76.dp).pointerInput(mode, connected) {
            detectTapGestures(onPress = {
                if (connected && mode == "manual") {
                    val sender = scope.launch {
                        while (true) {
                            runCatching { drive(left, right) }
                            delay(150)
                        }
                    }
                    try { awaitRelease() } finally { sender.cancel(); stop() }
                }
            })
        },
        shape = RoundedCornerShape(18.dp),
    ) { Text(label, style = MaterialTheme.typography.headlineMedium) }
}

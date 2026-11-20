package com.weedlaser.bev.data.remote

import com.weedlaser.bev.domain.model.Mission
import com.weedlaser.bev.domain.repository.DeviceType
import com.weedlaser.bev.domain.repository.DiscoveredDevice
import com.weedlaser.bev.domain.repository.MissionCommunicationRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.SocketTimeoutException
import java.util.concurrent.TimeUnit

@Serializable
private data class PiAckResponse(
    val ack: Boolean = false,
    val status: String = "",
    val segments: Int = 0,
    val error: String? = null,
)

@Serializable
private data class DiscoveryReply(
    val name: String = "WeedLaser-Pi",
    val port: Int = 8080,
    val type: String = "RASPBERRY_PI",
)

/**
 * HTTP-based [MissionCommunicationRepository] matching Navigation/src/mission_receiver.py.
 *
 * Protocol:
 * - POST http://<ip>:<port>/mission  -> JSON Mission payload, expects HTTP 200 + {"ack": true}
 * - GET  http://<ip>:<port>/health   -> Health check for connection testing
 * - UDP  broadcast "DISCOVER_WEED_ROVER" on port 8081 -> LAN robot discovery
 */
class TcpMissionCommunicationRepository(
    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.SECONDS)
        .writeTimeout(10, TimeUnit.SECONDS)
        .build(),
    private val json: Json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        prettyPrint = true
    }
) : MissionCommunicationRepository {

    private val jsonMediaType = "application/json".toMediaType()

    override suspend fun sendMission(mission: Mission, targetIp: String, port: Int): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                val host = targetIp.trim()
                require(host.isNotEmpty()) { "Raspberry Pi IP address is empty" }
                require(port in 1..65535) { "Invalid port: $port" }

                val payload = json.encodeToString(Mission.serializer(), mission)
                val request = Request.Builder()
                    .url("http://$host:$port/mission")
                    .post(payload.toRequestBody(jsonMediaType))
                    .header("Content-Type", "application/json")
                    .build()

                client.newCall(request).execute().use { response ->
                    val bodyStr = response.body?.string().orEmpty()
                    require(response.isSuccessful) {
                        "Pi returned HTTP ${response.code}${if (bodyStr.isNotBlank()) ": $bodyStr" else ""}"
                    }
                    if (bodyStr.isNotBlank()) {
                        val ack = runCatching { json.decodeFromString(PiAckResponse.serializer(), bodyStr) }.getOrNull()
                        if (ack != null && !ack.ack) {
                            error(ack.error ?: "Pi rejected mission payload (ack=false)")
                        }
                    }
                }
            }
        }

    override suspend fun testConnection(targetIp: String, port: Int): Result<Boolean> =
        withContext(Dispatchers.IO) {
            runCatching {
                val host = targetIp.trim()
                require(host.isNotEmpty()) { "Raspberry Pi IP address is empty" }
                require(port in 1..65535) { "Invalid port: $port" }

                // Prefer HTTP /health endpoint provided by Navigation/src/mission_receiver.py
                val request = Request.Builder()
                    .url("http://$host:$port/health")
                    .get()
                    .build()

                val httpOk = runCatching {
                    client.newCall(request).execute().use { it.isSuccessful }
                }.getOrDefault(false)

                if (httpOk) return@runCatching true

                // Fallback raw TCP reachability check
                val socket = java.net.Socket()
                var ok = false
                try {
                    socket.connect(java.net.InetSocketAddress(host, port), 2500)
                    ok = socket.isConnected
                } finally {
                    socket.close()
                }
                ok
            }
        }

    override suspend fun discoverDevices(): Result<List<DiscoveredDevice>> =
        withContext(Dispatchers.IO) {
            runCatching {
                val found = LinkedHashMap<String, DiscoveredDevice>()

                // 1. UDP broadcast discovery matching Navigation/src/mission_receiver.py
                runCatching {
                    DatagramSocket().use { socket ->
                        socket.broadcast = true
                        socket.soTimeout = 1200
                        val probe = DISCOVERY_MAGIC.toByteArray(Charsets.UTF_8)
                        val packet = DatagramPacket(
                            probe,
                            probe.size,
                            InetAddress.getByName("255.255.255.255"),
                            DISCOVERY_PORT,
                        )
                        socket.send(packet)

                        val buf = ByteArray(1024)
                        val deadline = System.currentTimeMillis() + 1500
                        while (System.currentTimeMillis() < deadline) {
                            val resp = DatagramPacket(buf, buf.size)
                            try {
                                socket.receive(resp)
                                val text = String(resp.data, 0, resp.length, Charsets.UTF_8)
                                val reply = runCatching {
                                    json.decodeFromString(DiscoveryReply.serializer(), text)
                                }.getOrNull() ?: continue
                                val ip = resp.address.hostAddress ?: continue
                                val type = runCatching { DeviceType.valueOf(reply.type) }
                                    .getOrDefault(DeviceType.RASPBERRY_PI)
                                found["$ip:${reply.port}"] = DiscoveredDevice(
                                    name = reply.name,
                                    ipAddress = ip,
                                    port = reply.port,
                                    deviceType = type,
                                )
                            } catch (_: SocketTimeoutException) {
                                break
                            }
                        }
                    }
                }

                // 2. Direct probe of standard Raspberry Pi AP hotspot address
                val defaultIp = "192.168.4.1"
                val defaultPort = 8080
                if (!found.containsKey("$defaultIp:$defaultPort")) {
                    val reachable = runCatching {
                        val req = Request.Builder().url("http://$defaultIp:$defaultPort/health").get().build()
                        client.newCall(req).execute().use { it.isSuccessful }
                    }.getOrDefault(false)
                    if (reachable) {
                        found["$defaultIp:$defaultPort"] = DiscoveredDevice(
                            name = "WeedLaser-Pi (Hotspot)",
                            ipAddress = defaultIp,
                            port = defaultPort,
                            deviceType = DeviceType.RASPBERRY_PI,
                        )
                    }
                }

                found.values.toList()
            }
        }

    companion object {
        const val DISCOVERY_PORT = 8081
        const val DISCOVERY_MAGIC = "DISCOVER_WEED_ROVER"
    }
}

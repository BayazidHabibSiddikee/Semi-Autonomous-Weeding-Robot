package com.weedlaser.bev.data.remote

import com.weedlaser.bev.domain.model.Mission
import com.weedlaser.bev.domain.repository.DiscoveredDevice
import com.weedlaser.bev.domain.repository.MissionCommunicationRepository
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit
import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * HTTP-based [MissionCommunicationRepository].
 *
 * Sends a JSON-encoded [Mission] to a Raspberry Pi HTTP server over Wi-Fi.
 * For a raw TCP protocol, replace the HTTP call with a socket + framing.
 */
class TcpMissionCommunicationRepository(
    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.SECONDS)
        .writeTimeout(10, TimeUnit.SECONDS)
        .build(),
    private val json: Json = Json { ignoreUnknownKeys = true }
) : MissionCommunicationRepository {

    private val jsonMediaType = "application/json".toMediaType()

    override suspend fun sendMission(mission: Mission, targetIp: String, port: Int): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                val payload = json.encodeToString(Mission.serializer(), mission)
                val request = Request.Builder()
                    .url("http://$targetIp:$port/mission")
                    .post(payload.toRequestBody(jsonMediaType))
                    .header("Content-Type", "application/json")
                    .build()

                client.newCall(request).execute().use { response ->
                    require(response.isSuccessful) { "Pi returned HTTP ${response.code}" }
                }
            }
        }

    override suspend fun testConnection(targetIp: String, port: Int): Result<Boolean> =
        withContext(Dispatchers.IO) {
            runCatching {
                val socket = java.net.Socket()
                var ok = false
                try {
                    socket.connect(java.net.InetSocketAddress(targetIp, port), 3000)
                    ok = socket.isConnected
                } finally {
                    socket.close()
                }
                ok
            }
        }

    override suspend fun discoverDevices(): Result<List<DiscoveredDevice>> =
        withContext(Dispatchers.IO) {
            // Placeholder — real implementation would use mDNS / Wi-Fi Direct / SSDP
            Result.success(emptyList())
        }
}


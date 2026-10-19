package com.weedlaser.bev.data.remote

import com.weedlaser.bev.domain.model.MissionStatus
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.SocketTimeoutException
import java.net.URL

/**
 * Finds the Raspberry Pi on the local network and reads its mission status.
 *
 * The phone does not need the Pi's IP address typed in: it broadcasts a short
 * UDP probe, the Pi answers with its address, and the app talks to it over
 * HTTP. Works with a phone hotspot (the Pi joins the hotspot and gets a
 * 192.168.43.x address) as well as plain Wi-Fi.
 */
class PiNetworkClient(
    private val json: Json = Json { ignoreUnknownKeys = true },
) {

    companion object {
        const val DISCOVERY_PORT = 9999
        const val PROBE = "WEEDLASER_DISCOVER"
        const val DEFAULT_MISSION_PORT = 8080
    }

    data class PiInfo(
        val name: String,
        val host: String,
        val port: Int,
    ) {
        val baseUrl: String get() = "http://$host:$port"
    }

    /**
     * Broadcast a discovery probe and wait for the Pi to answer.
     *
     * @param timeoutMs how long to wait for replies
     * @return the Pi's address, or null when nothing answered
     */
    suspend fun discover(timeoutMs: Int = 3000): PiInfo? = withContext(Dispatchers.IO) {
        DatagramSocket().use { socket ->
            socket.broadcast = true
            socket.soTimeout = timeoutMs
            val probe = PROBE.toByteArray()
            val targets = listOf(
                InetAddress.getByName("255.255.255.255"),
                InetAddress.getByName("192.168.43.255"),
                InetAddress.getByName("192.168.0.255"),
            )
            targets.forEach { addr ->
                runCatching { socket.send(DatagramPacket(probe, probe.size, addr, DISCOVERY_PORT)) }
            }

            val buffer = ByteArray(2048)
            val deadline = System.currentTimeMillis() + timeoutMs
            while (System.currentTimeMillis() < deadline) {
                try {
                    val packet = DatagramPacket(buffer, buffer.size)
                    socket.receive(packet)
                    val text = String(packet.data, 0, packet.length)
                    val info = parseInfo(text) ?: continue
                    return@withContext info
                } catch (e: SocketTimeoutException) {
                    break
                } catch (e: Exception) {
                    continue
                }
            }
            null
        }
    }

    private fun parseInfo(payload: String): PiInfo? = runCatching {
        val obj = json.parseToJsonElement(payload).let { it as kotlinx.serialization.json.JsonObject }
        if (obj["service"]?.toString()?.contains("weedlaser") != true) return null
        PiInfo(
            name = obj["name"]?.toString()?.trim('"') ?: "rover-pi",
            host = obj["host"]?.toString()?.trim('"') ?: return null,
            port = obj["port"]?.toString()?.trim('"')?.toIntOrNull() ?: DEFAULT_MISSION_PORT,
        )
    }.getOrNull()

    /**
     * Read the current mission status from the Pi (`GET /status`).
     */
    suspend fun fetchStatus(baseUrl: String): Result<MissionStatus> = withContext(Dispatchers.IO) {
        runCatching {
            val connection = (URL("$baseUrl/status").openConnection() as java.net.HttpURLConnection)
            connection.connectTimeout = 5000
            connection.readTimeout = 5000
            connection.requestMethod = "GET"
            val body = connection.inputStream.bufferedReader().use { it.readText() }
            connection.disconnect()
            json.decodeFromString(MissionStatus.serializer(), body)
        }
    }
}

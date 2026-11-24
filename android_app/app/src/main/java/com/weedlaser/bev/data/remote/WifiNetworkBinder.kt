package com.weedlaser.bev.data.remote

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume

/**
 * Binds the Android app process to the active Wi-Fi transport so HTTP traffic to
 * a no-internet Raspberry Pi hotspot (e.g. 192.168.4.1:8000) is not silently routed
 * over cellular data by Android's default network selection.
 */
class WifiNetworkBinder(private val context: Context) {

    private var activeCallback: ConnectivityManager.NetworkCallback? = null

    suspend fun bindToWifiHotspot(timeoutMs: Long = 3500L): Result<Boolean> {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return Result.failure(IllegalStateException("ConnectivityManager unavailable"))

        // Fast path: check if an active Wi-Fi network already exists
        @Suppress("DEPRECATION")
        val existingWifi = cm.allNetworks.firstOrNull { net ->
            val caps = cm.getNetworkCapabilities(net)
            caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
        }
        if (existingWifi != null) {
            val bound = cm.bindProcessToNetwork(existingWifi)
            return Result.success(bound)
        }

        // Request any Wi-Fi transport without requiring NET_CAPABILITY_INTERNET
        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()

        val found: Network? = withTimeoutOrNull(timeoutMs) {
            suspendCancellableCoroutine { cont ->
                val callback = object : ConnectivityManager.NetworkCallback() {
                    override fun onAvailable(network: Network) {
                        if (cont.isActive) cont.resume(network)
                    }

                    override fun onUnavailable() {
                        if (cont.isActive) cont.resume(null)
                    }
                }
                activeCallback?.let { prev ->
                    runCatching { cm.unregisterNetworkCallback(prev) }
                }
                activeCallback = callback
                try {
                    cm.requestNetwork(request, callback)
                } catch (e: SecurityException) {
                    if (cont.isActive) cont.resume(null)
                }
                cont.invokeOnCancellation {
                    runCatching { cm.unregisterNetworkCallback(callback) }
                }
            }
        }

        return if (found != null) {
            Result.success(cm.bindProcessToNetwork(found))
        } else {
            Result.failure(IllegalStateException("No Wi-Fi hotspot detected. Connect phone Wi-Fi to the Pi AP first."))
        }
    }

    fun releaseBinding() {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        runCatching { cm.bindProcessToNetwork(null) }
        activeCallback?.let { cb ->
            runCatching { cm.unregisterNetworkCallback(cb) }
        }
        activeCallback = null
    }
}

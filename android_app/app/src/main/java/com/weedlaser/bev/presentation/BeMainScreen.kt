package com.weedlaser.bev.presentation

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.weedlaser.bev.domain.model.Field
import com.weedlaser.bev.domain.model.FieldCorners
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.koin.androidx.compose.koinViewModel
import java.io.File
import java.io.FileOutputStream

/**
 * Entry screen for the BEV pipeline.
 * Steps: 1) photo + corners, 2) field config, 3) generate, 4) send / export.
 */
@Composable
fun BeMainScreen(viewModel: BeViewModel = koinViewModel()) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var imagePath by rememberSaveable { mutableStateOf<String?>(null) }
    var corners by remember { mutableStateOf<FieldCorners?>(null) }
    var field by remember {
        mutableStateOf(Field(widthM = 6.0, lengthM = 8.0, totalRows = 10, rowSpacingM = 0.6))
    }
    var piIp by rememberSaveable { mutableStateOf("192.168.4.1") }

    val photoPickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.PickVisualMedia()
    ) { uri: Uri? ->
        if (uri != null) {
            scope.launch {
                val copiedPath = withContext(Dispatchers.IO) {
                    copyUriToInternalFile(context, uri)
                }
                if (copiedPath != null) {
                    imagePath = copiedPath
                    corners = null // reset corners for new photo
                }
            }
        }
    }

    WeedLaserTheme {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                "নিড়ানি রোবট পথ পরিকল্পক",
                style = MaterialTheme.typography.headlineMedium,
                color = MaterialTheme.colorScheme.primary,
            )
            Text(
                "BEV Homography & Path Planner",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Card(modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(12.dp)) {
                Column(Modifier.padding(12.dp)) {
                    Text("১. জমির ছবি ও চার কোণা নির্বাচন", style = MaterialTheme.typography.titleMedium)
                    Spacer(Modifier.height(8.dp))
                    CornerSelectionCard(
                        imagePath = imagePath,
                        corners = corners,
                        onPickPhotoClick = {
                            photoPickerLauncher.launch(
                                PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
                            )
                        },
                        onCornersChanged = { corners = it },
                    )
                }
            }

            Card(modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(12.dp)) {
                Column(Modifier.padding(12.dp)) {
                    Text("২. জমির পরিমাপ ও বিন্যাস", style = MaterialTheme.typography.titleMedium)
                    Spacer(Modifier.height(8.dp))
                    FieldConfigInputs(field) { field = it }
                }
            }

            Button(
                onClick = {
                    val img = imagePath ?: return@Button
                    val c = corners ?: return@Button
                    if (!c.isValid()) return@Button
                    viewModel.processAndGenerate(img, c, field)
                },
                enabled = imagePath != null && corners != null && !viewModel.isProcessing,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    if (viewModel.isProcessing) "প্রসেসিং চলছে (Generating...)" else "৩. স্বয়ংক্রিয় পথ পরিকল্পনা তৈরি করুন",
                    style = MaterialTheme.typography.labelLarge,
                )
            }

            when (val o = viewModel.outcome) {
                is BevOutcome.Success ->
                    BeSuccessPanel(
                        o = o,
                        piIp = piIp,
                        onSend = { viewModel.sendToPi(o.mission, piIp) },
                        onCopyJson = {
                            val jsonStr = viewModel.missionToJson(o.mission)
                            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                            clipboard.setPrimaryClip(ClipData.newPlainText("Mission JSON", jsonStr))
                            Toast.makeText(context, "মিশন JSON ক্লিপবোর্ডে কপি হয়েছে!", Toast.LENGTH_SHORT).show()
                        }
                    )
                is BevOutcome.Error -> BeErrorPanel(o.message, viewModel::reset)
                BevOutcome.Idle -> BeIdleHint()
            }
        }
    }
}

private fun copyUriToInternalFile(context: Context, uri: Uri): String? {
    return try {
        val inputStream = context.contentResolver.openInputStream(uri) ?: return null
        val target = File(context.filesDir, "field_input_${System.currentTimeMillis()}.jpg")
        FileOutputStream(target).use { out ->
            inputStream.copyTo(out)
        }
        target.absolutePath
    } catch (e: Exception) {
        null
    }
}
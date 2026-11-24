package com.weedlaser.bev.di

import com.weedlaser.bev.core.opencv.OpenCVProcessor
import com.weedlaser.bev.core.opencv.RowDetector
import com.weedlaser.bev.data.CameraXRepository
import com.weedlaser.bev.data.OpenCVImageProcessingRepository
import com.weedlaser.bev.data.SharedPreferencesFieldRepository
import com.weedlaser.bev.data.remote.PiLiveClient
import com.weedlaser.bev.data.remote.WifiNetworkBinder
import com.weedlaser.bev.domain.repository.CameraRepository
import com.weedlaser.bev.domain.repository.FieldRepository
import com.weedlaser.bev.domain.repository.ImageProcessingRepository
import com.weedlaser.bev.domain.usecase.BoustrophedonGenerator
import com.weedlaser.bev.domain.usecase.CapturePhotoUseCase
import com.weedlaser.bev.domain.usecase.DetectRowsUseCase
import com.weedlaser.bev.domain.usecase.GenerateBEVUseCase
import com.weedlaser.bev.domain.usecase.GenerateMissionUseCase
import com.weedlaser.bev.domain.usecase.GetFieldUseCase
import com.weedlaser.bev.domain.usecase.SaveFieldUseCase
import com.weedlaser.bev.presentation.BeViewModel
import org.koin.android.ext.koin.androidContext
import org.koin.androidx.viewmodel.dsl.viewModel
import org.koin.dsl.module
import java.io.File

/**
 * Koin DI module wiring PiLiveClient, WifiNetworkBinder, OpenCV/BEV utilities, and BeViewModel.
 */
fun bevAppModule(bevOutputDir: File) = module {
    // Core
    single { OpenCVProcessor() }
    single { RowDetector() }
    single { BoustrophedonGenerator() }

    // Pi HTTP + Wi-Fi hotspot binding
    single { PiLiveClient() }
    single { WifiNetworkBinder(androidContext()) }

    // Data
    single<FieldRepository> { SharedPreferencesFieldRepository(androidContext()) }
    single<ImageProcessingRepository> {
        OpenCVImageProcessingRepository(
            opencv = get(),
            rowDetector = get(),
            generator = get(),
            outputDir = bevOutputDir,
        )
    }
    single<CameraRepository> { CameraXRepository(androidContext(), bevOutputDir) }

    // UseCases
    factory { GetFieldUseCase(get()) }
    factory { SaveFieldUseCase(get()) }
    factory { CapturePhotoUseCase(get()) }
    factory { GenerateBEVUseCase(get()) }
    factory { DetectRowsUseCase(get()) }
    factory { GenerateMissionUseCase(get()) }

    // ViewModel wired directly to PiLiveClient & BEV pipeline
    viewModel {
        BeViewModel(
            piClient = get(),
            wifiBinder = get(),
            openCVProcessor = get(),
            rowDetector = get(),
            bevOutputDir = bevOutputDir,
        )
    }
}
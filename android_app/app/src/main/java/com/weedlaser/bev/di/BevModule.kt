package com.weedlaser.bev.di

import com.weedlaser.bev.core.opencv.FieldAnalyzer
import com.weedlaser.bev.core.opencv.OpenCVProcessor
import com.weedlaser.bev.core.opencv.RowDetector
import com.weedlaser.bev.data.InMemoryFieldRepository
import com.weedlaser.bev.data.OpenCVImageProcessingRepository
import com.weedlaser.bev.data.remote.PiNetworkClient
import com.weedlaser.bev.data.remote.TcpMissionCommunicationRepository
import com.weedlaser.bev.domain.repository.FieldRepository
import com.weedlaser.bev.domain.repository.ImageProcessingRepository
import com.weedlaser.bev.domain.repository.MissionCommunicationRepository
import com.weedlaser.bev.domain.usecase.BoustrophedonGenerator
import com.weedlaser.bev.domain.usecase.CapturePhotoUseCase
import com.weedlaser.bev.domain.usecase.DetectRowsUseCase
import com.weedlaser.bev.domain.usecase.DiscoverPiDevicesUseCase
import com.weedlaser.bev.domain.usecase.GenerateBEVUseCase
import com.weedlaser.bev.domain.usecase.GenerateMissionUseCase
import com.weedlaser.bev.domain.usecase.GetFieldUseCase
import com.weedlaser.bev.domain.usecase.SaveFieldUseCase
import com.weedlaser.bev.domain.usecase.SendMissionUseCase
import com.weedlaser.bev.domain.usecase.TestPiConnectionUseCase
import com.weedlaser.bev.presentation.BeViewModel
import org.koin.androidx.viewmodel.dsl.viewModel
import org.koin.dsl.module
import java.io.File

/**
 * Koin DI module wiring all layers.
 */
fun bevAppModule(bevOutputDir: File) = module {
    // Core
    single { OpenCVProcessor() }
    single { RowDetector() }
    single { FieldAnalyzer() }
    single { BoustrophedonGenerator() }

    // Data
    single<FieldRepository> { InMemoryFieldRepository() }
    single<ImageProcessingRepository> {
        OpenCVImageProcessingRepository(
            opencv = get(),
            rowDetector = get(),
            fieldAnalyzer = get(),
            fieldAnalyzer = get(),
            generator = get(),
            outputDir = bevOutputDir,
        )
    }
    single<MissionCommunicationRepository> { TcpMissionCommunicationRepository() }
    single { PiNetworkClient() }
    single<com.weedlaser.bev.domain.repository.CameraRepository> { com.weedlaser.bev.data.LocalCameraRepository() }

    // UseCases
    factory { GetFieldUseCase(get()) }
    factory { SaveFieldUseCase(get()) }
    factory { CapturePhotoUseCase(get()) }
    factory { GenerateBEVUseCase(get()) }
    factory { DetectRowsUseCase(get()) }
    factory { GenerateMissionUseCase(get()) }
    factory { SendMissionUseCase(get()) }
    factory { TestPiConnectionUseCase(get()) }
    factory { DiscoverPiDevicesUseCase(get()) }

    // ViewModel
    viewModel { BeViewModel(get(), get(), get(), get(), get(), get()) }
}
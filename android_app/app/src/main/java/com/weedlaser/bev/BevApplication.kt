package com.weedlaser.bev

import android.app.Application
import com.weedlaser.bev.di.bevAppModule
import org.koin.android.ext.koin.androidContext
import org.koin.core.context.startKoin

class BevApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        startKoin {
            androidContext(this@BevApplication)
            modules(bevAppModule(filesDir.resolve("bev")))
        }
    }
}

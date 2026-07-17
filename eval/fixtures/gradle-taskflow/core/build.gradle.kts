plugins {
    kotlin("jvm")
}

dependencies {
    implementation(libs.kotlinx.coroutines)
    api("com.google.guava:guava:33.0.0-jre")
}

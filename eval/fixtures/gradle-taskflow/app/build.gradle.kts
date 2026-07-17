plugins {
    kotlin("jvm")
    alias(libs.plugins.shadow)
}

dependencies {
    implementation(project(":core"))
    implementation(libs.commons.text)
}

tasks.register("deploy") {
    dependsOn("build")
}

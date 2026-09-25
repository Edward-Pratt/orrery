
plugins {
    id("com.gtnewhorizons.gtnhconvention")
}

// Version from the nearest mod-v* tag only (docs/adr/0001): "1.3.0" on the tag, "1.3.0-2-g<hash>" after it,
// "-dirty" with uncommitted changes, "0.0.0-<hash>" with no mod tag yet.
val gitDescribe = providers.exec {
    commandLine("git", "describe", "--tags", "--match", "mod-v*", "--dirty", "--always")
    isIgnoreExitValue = true
}.standardOutput.asText.get().trim()
val modVersion = if (gitDescribe.startsWith("mod-v")) gitDescribe.removePrefix("mod-v") else "0.0.0-$gitDescribe"
version = modVersion
extra["modVersion"] = modVersion // read by the gtnh plugin for the jar name and Tags.VERSION

# Apple TV five-minute Homey recovery (ALI-274)

Live Advanced Flow: Apple TV AirPlay Watchdog, `9dd74381-17c3-4296-b796-37b3fa4874cb`.
This operations artifact is deployed separately from the integration app; no app installation is required.

## Policy

- Once per minute, read Homey's cached Apple TV device availability and readiness.
- Explicit unavailable/not-ready observations must span at least five minutes.
- Healthy or unknown observations reset confirmation. Failed reads, backward clocks and gaps over 90 seconds cannot count as uninterrupted failure evidence.
- A paused/idle player is not a connection failure. If Homey still reports a stuck device healthy, this watchdog cannot detect it without additional health telemetry; it does not send probe/playback commands.
- Eligibility persists a 30-minute app-restart cooldown before allowing the native Homey **Restart app** action for `com.basmilius.apple`.
- Restart intent/acceptance is not proof of recovery; a later healthy observation is required.
- The immediate automatic AirPlay-failure restart Flow `552409a3-e8a5-445c-a394-c05e2d557529` is retained but disabled to prevent bypass/duplicate app restarts.
- Manual Flow **Restart Apple TV/Homepod** `82134255-5238-48f3-a30b-b9e1d8c560a3` remains unchanged and enabled.

Polling detects failure on the next minute tick; restart is eligible on the first tick at least five minutes after the first confirmed failure. This is sampled coverage, not proof that no reconnect happened between checks. Restarting the integration can briefly make its HomePod devices unavailable too; physical devices and Homey itself are not rebooted.

## Verification

`node --test operations/apple-tv-watchdog.test.cjs`: nine offline guard tests, no live app/device commands.
Deployment readback confirms one-minute trigger, condition code, native app-only action, enabled=true and broken=false. Original Flow IDs/folder are preserved. The connector requires UUID card keys even for legacy non-UUID keys; the authenticated Homey CLI API was used to retain the existing trigger/watchdog keys.
A private SSD backup of all three original Flow definitions is retained outside Git.
Do not force an outage or run the restart card just to demonstrate it. Natural-outage recovery is a separate runtime acceptance gate.

The old watchdog history contained repeated restart errors followed by a later healthy observation. The native card replaces its scripted restart API call; the exact cause of prior errors was not exposed by that sanitized history.


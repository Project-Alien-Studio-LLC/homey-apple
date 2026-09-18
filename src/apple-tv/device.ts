import { AIRPLAY_SERVICE, AppleTV, COMPANION_LINK_SERVICE, ConnectionRecovery, type DiscoveryResult, type MdnsService, mdnsUnicast, Proto } from '@basmilius/apple-sdk';
import { DiscoverableDevice } from '../base';
import { AirPlayLogic } from '../logic';
import { capabilityToRepeatMode, getAccessoryCredentialsFromDevice, requestConnectionRecovery, SingleFlight } from '../utils';
import type AppleTVDriver from './driver';
import type Homey from 'homey';

const RECONNECT_INTERVAL = 15 * 60 * 1000;
const HEALTH_CHECK_INTERVAL = 2 * 60 * 1000;
const SLOW_RECOVERY_INTERVAL = 2 * 60 * 1000;
const SLOW_RECOVERY_MAX_ATTEMPTS = 15;
const AIRPLAY_RECOVERY_TRIGGER_COOLDOWN = 30 * 60 * 1000;

const CAPABILITIES = [
    'speaker_album',
    'speaker_artist',
    'speaker_duration',
    'speaker_next',
    'speaker_playing',
    'speaker_position',
    'speaker_prev',
    'speaker_track',
    'speaker_repeat',
    'speaker_shuffle',
    'artwork_url',
    'artwork_url_cloud',
    'artwork_url_local',
    'onoff',
    'power',
    'volume_down',
    'volume_mute',
    'volume_set',
    'volume_up',
    'remote_up',
    'remote_down',
    'remote_left',
    'remote_right',
    'remote_select',
    'remote_home',
    'remote_back',
    'remote_playpause',
    'now_playing_app',
    'button.restart'
];

export default class AppleTVDevice extends DiscoverableDevice<AppleTVDriver> {
    get airplayLogic(): AirPlayLogic {
        return this.#airplayLogic;
    }

    get currentNowPlayingBundleId(): string | null {
        return this.#airplayLogic?.currentNowPlayingBundleId ?? null;
    }

    get discoveryResultAirPlay(): DiscoveryResult {
        return this.discoveryResults[AIRPLAY_SERVICE];
    }

    get sdk(): AppleTV {
        if (!this.#tv) {
            throw new Error('Apple TV SDK device is not initialized.');
        }

        return this.#tv;
    }

    get services(): Record<string, Homey.DiscoveryStrategy> {
        return this.#services;
    }

    #healthTimer: ReturnType<typeof setInterval> | null = null;
    #healthFlight = new SingleFlight<void>();
    #airplayLogic!: AirPlayLogic;
    #airplayRecovery?: ConnectionRecovery;
    #companionLinkRecovery?: ConnectionRecovery;
    #companionLinkRetried = false;
    #connectFlight = new SingleFlight<void>();
    #connectedOnce = false;
    #slowRecoveryAttempt = 0;
    #slowRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
    #services!: Record<string, Homey.DiscoveryStrategy>;
    #tv?: AppleTV;

    async onInit(): Promise<void> {
        await this.setUnavailable('Connecting...');

        this.#services = {
            [AIRPLAY_SERVICE]: this.discovery.getStrategy('airplay')
        };

        this.#airplayLogic = new AirPlayLogic(this);
        await this.#airplayLogic.initialize();

        await this.syncCapabilities(CAPABILITIES);
        this.#registerCapabilities();
        this.#registerMaintenance();

        await super.onInit();

        this.#healthTimer = setInterval(() => {
            void this.#healthFlight.run(() => this.#checkConnectionHealth()).catch(err => this.error('Connection health check failed.', err));
        }, HEALTH_CHECK_INTERVAL);
        this.#recordConnectionEvent('initialized');
        this.log('Initialized.');
    }

    async onUninit(): Promise<void> {
        if (this.#healthTimer) clearInterval(this.#healthTimer);
        this.#healthTimer = null;
        this.#stopSlowRecovery();
        this.#airplayRecovery?.dispose();
        this.#companionLinkRecovery?.dispose();
        await this.#airplayLogic.uninitialize();
        this.#tv?.disconnect();

        this.log('Uninitialized.');
    }

    async #connect(): Promise<void> {
        return this.#connectFlight.run(() => this.#connectOnce());
    }

    async #connectOnce(): Promise<void> {
        try {
            const credentials = getAccessoryCredentialsFromDevice(this);

            if (!credentials) {
                await this.setUnavailable('Cannot find credentials, please re-pair the device.');
                return;
            }

            if (!this.discoveryResultAirPlay) {
                await this.setUnavailable('Service discovery not complete, waiting for device...');
                return;
            }

            // Discover Companion Link via unicast using AirPlay's address.
            const companionLink = await this.#discoverCompanionLink(this.discoveryResultAirPlay.address);

            // Create or reconfigure the SDK device.
            if (!this.#tv) {
                this.#tv = new AppleTV({
                    airplay: this.discoveryResultAirPlay,
                    companionLink: companionLink ?? undefined
                });

                this.#airplayLogic.setDevice(this.#tv);
                this.#wireEvents();
                this.#setupRecovery(credentials);
            } else {
                this.#tv.discoveryResult = this.discoveryResultAirPlay;

                if (this.#tv.companionLink && companionLink) {
                    this.#tv.companionLink.discoveryResult = companionLink;
                }
            }

            this.log('Connecting to Apple TV...');
            await this.#tv.connect(credentials);
        } catch (err) {
            this.error('[connection]', 'Failed to connect to Apple TV.', err);
            this.#recordConnectionEvent('initial-connect-failed', undefined, [err]);
            await this.setUnavailable('Cannot connect to Apple TV.');

            requestConnectionRecovery(this.#tv?.airplay, this.#airplayRecovery);
            requestConnectionRecovery(this.#tv?.companionLink, this.#companionLinkRecovery);
        }
    }

    async #discoverCompanionLink(address: string): Promise<DiscoveryResult | null> {
        this.log(`Discovering Companion Link via unicast to ${address}...`);

        try {
            const results = await mdnsUnicast([address], [COMPANION_LINK_SERVICE], 5);
            const match = results.find((s: MdnsService) => s.address === address);

            if (!match) {
                this.log('Companion Link not found via unicast.');
                return null;
            }

            this.log(`Found Companion Link at ${match.address}:${match.port}.`);

            const txt = match.properties;
            const hostname = match.name.replace(/\s+/g, '-');

            return {
                id: `${hostname}.local`,
                fqdn: `${hostname}.local`,
                address: match.address,
                modelName: txt?.model ?? '',
                familyName: null,
                txt,
                service: {
                    port: match.port,
                    protocol: 'tcp',
                    type: COMPANION_LINK_SERVICE
                },
                packet: null
            } as unknown as DiscoveryResult;
        } catch (err) {
            this.error('Companion Link unicast discovery failed:', err);
            return null;
        }
    }

    #wireEvents(): void {
        if (!this.#tv) {
            return;
        }

        this.#tv.on('connected', async () => {
            this.#airplayRecovery?.reset();
            this.log('Connected to Apple TV (AirPlay).');
            this.#recordConnectionEvent('connected', 'AirPlay');

            if (this.#tv!.companionLink?.isConnected) {
                await this.setAvailable();
            }
        });

        this.#tv.on('disconnected', async (unexpected: boolean) => {
            if (!unexpected) {
                return;
            }

            this.log('Disconnected from Apple TV (AirPlay), reconnecting...');
            this.#recordConnectionEvent('unexpected-disconnect', 'AirPlay');
            await this.setUnavailable('Disconnected from Apple TV (AirPlay), reconnecting...');
            await this.#airplayLogic.clearNowPlaying();
            this.#airplayRecovery?.handleDisconnect(unexpected);
        });

        this.#tv.on('power', async (state) => {
            this.log('Power state changed:', state);

            const isOn = state === 'awake' || state === 'screensaver';

            try {
                await this.setCapabilityValue('onoff', isOn);
                await this.setCapabilityValue('power', this.homey.__(isOn ? 'capability.power.on' : 'capability.power.off'));
            } catch (err) {
                this.error('Failed to set power state.', err);
            }

            if (isOn) {
                this.#airplayLogic.emitUpdate();
                return;
            }

            await this.#airplayLogic.clearNowPlaying();
        });

        if (this.#tv.companionLink) {
            this.#tv.companionLink.on('connected', async () => {
                this.#companionLinkRecovery?.reset();
                this.#companionLinkRetried = false;
                this.#stopSlowRecovery();
                this.log('Connected to Apple TV (Companion Link).');
                this.#recordConnectionEvent('connected', 'Companion Link');

                if (this.#tv!.airplay.isConnected) {
                    await this.setAvailable();
                }
            });

            this.#tv.companionLink.on('disconnected', async (unexpected: boolean) => {
                if (!unexpected) {
                    return;
                }

                this.log('Disconnected from Apple TV (Companion Link), reconnecting...');
                this.#recordConnectionEvent('unexpected-disconnect', 'Companion Link');
                await this.setUnavailable('Disconnected from Apple TV (Companion Link), reconnecting...');
                this.#companionLinkRecovery?.handleDisconnect(unexpected);
            });
        }
    }

    #recordConnectionEvent(event: string, protocol?: string, errors: unknown[] = []): void {
        try {
            const key = `appleTvConnectionHistory:${this.discoveryId}`;
            const previous = this.homey.settings.get(key);
            const history = Array.isArray(previous) ? previous : [];
            // Persist only error classifications; protocol payloads and credentials are never stored.
            const failures = errors.map(error => ({
                name: error instanceof Error ? error.name : 'UnknownError',
                code: error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined
            }));
            this.homey.settings.set(key, [...history, {
                at: new Date().toISOString(), event, protocol, failures,
                airplayConnected: this.#tv?.airplay.isConnected ?? false,
                companionConnected: this.#tv?.companionLink?.isConnected ?? false
            }].slice(-80));
        } catch (err) {
            this.error('Unable to persist connection diagnostics.', err);
        }
    }

    async #checkConnectionHealth(): Promise<void> {
        const tv = this.#tv;
        if (!tv) {
            await this.findServices();
            return;
        }
        // Read connection state without disconnecting or sending playback commands.
        if (tv.airplay.isConnected && tv.companionLink?.isConnected) return;
        this.#recordConnectionEvent('health-check-disconnected');
        await this.setUnavailable('Connection interrupted; automatic recovery in progress.');
        requestConnectionRecovery(tv.airplay, this.#airplayRecovery);
        if (!this.#slowRecoveryTimer) {
            requestConnectionRecovery(tv.companionLink, this.#companionLinkRecovery);
        }
    }

    #setupRecovery(credentials: NonNullable<ReturnType<typeof getAccessoryCredentialsFromDevice>>): void {
        this.#airplayRecovery?.dispose();
        this.#companionLinkRecovery?.dispose();

        this.#airplayRecovery = new ConnectionRecovery({
            maxAttempts: 3,
            baseDelay: 1000,
            // Healthy sessions must never be torn down by a periodic timer.
            reconnectInterval: 0,
            onReconnect: async () => {
                const tv = this.#tv;
                if (!tv) return;
                tv.airplay.disconnectSafely();
                await this.findService(AIRPLAY_SERVICE);
                tv.discoveryResult = this.discoveryResults[AIRPLAY_SERVICE];
                tv.airplay.setCredentials(credentials);
                await tv.airplay.connect();
            }
        });

        this.#airplayRecovery.on('recovering', (attempt) => {
            this.log(`AirPlay recovery attempt ${attempt}...`);
        });

        this.#airplayRecovery.on('failed', (errors) => {
            this.#recordConnectionEvent('recovery-failed', 'AirPlay', errors);
            this.error('AirPlay recovery failed after max attempts.');
            void this.#triggerAirPlayRecoveryFailed();
        });

        this.#companionLinkRecovery = new ConnectionRecovery({
            maxAttempts: 3,
            baseDelay: 1000,
            // Healthy sessions must never be torn down by a periodic timer.
            reconnectInterval: 0,
            onReconnect: async () => {
                const tv = this.#tv;
                if (!tv?.companionLink) return;
                await tv.companionLink.disconnectSafely();
                const cl = await this.#discoverCompanionLink(this.discoveryResultAirPlay.address);

                if (!cl) {
                    throw new Error('Companion Link not found via unicast.');
                }

                tv.companionLink.discoveryResult = cl;
                await tv.companionLink.setCredentials(credentials);
                await tv.companionLink.connect();
            }
        });

        this.#companionLinkRecovery.on('recovering', (attempt) => {
            this.log(`Companion Link recovery attempt ${attempt}...`);
        });

        this.#companionLinkRecovery.on('failed', async (errors) => {
            this.#recordConnectionEvent('recovery-failed', 'Companion Link', errors);
            this.error('Companion Link recovery failed after max attempts.');
            await this.#onCompanionLinkFailed();
        });
    }

    async #triggerAirPlayRecoveryFailed(): Promise<void> {
        const storeKey = 'airplayRecoveryFlowTriggeredAt';
        const now = Date.now();
        const lastTriggeredAt = this.getStoreValue(storeKey);

        if (typeof lastTriggeredAt === 'number'
            && now - lastTriggeredAt < AIRPLAY_RECOVERY_TRIGGER_COOLDOWN) {
            this.log('AirPlay recovery Flow trigger suppressed by cooldown.');
            return;
        }

        await this.setStoreValue(storeKey, now);
        await this.app.appleTvFlow.triggerAirPlayRecoveryFailed(this);
    }

    async #startSlowRecovery(): Promise<void> {
        this.log(`Starting slow recovery phase, retrying every ${SLOW_RECOVERY_INTERVAL / 1000}s for up to ${SLOW_RECOVERY_MAX_ATTEMPTS} attempts...`);
        this.#slowRecoveryAttempt = 0;
        this.#scheduleSlowRecoveryAttempt();
        await this.setUnavailable('Device offline, retrying connection...');
    }

    #scheduleSlowRecoveryAttempt(): void {
        const interval = this.#slowRecoveryAttempt >= SLOW_RECOVERY_MAX_ATTEMPTS
            ? RECONNECT_INTERVAL
            : SLOW_RECOVERY_INTERVAL;

        this.#slowRecoveryTimer = setTimeout(async () => {
            this.#slowRecoveryTimer = null;
            this.#slowRecoveryAttempt++;

            this.log(`Slow recovery attempt ${this.#slowRecoveryAttempt}...`);

            try {
                const cl = await this.#discoverCompanionLink(this.discoveryResultAirPlay.address);

                if (!cl) {
                    throw new Error('Companion Link not found via unicast.');
                }

                const tv = this.#tv;

                if (!tv?.companionLink) {
                    return;
                }

                this.log(`Re-discovered Companion Link at ${cl.address}:${cl.service.port}, reconnecting...`);
                this.#companionLinkRecovery?.reset();
                tv.companionLink.discoveryResult = cl;

                const credentials = getAccessoryCredentialsFromDevice(this);

                if (credentials) {
                    await tv.companionLink.setCredentials(credentials);
                    await tv.companionLink.connect();
                }
            } catch {
                this.log(`Slow recovery attempt ${this.#slowRecoveryAttempt} failed.`);
            }

            if (this.#slowRecoveryAttempt === SLOW_RECOVERY_MAX_ATTEMPTS) {
                this.log('Companion Link recovery entering extended phase, retrying every 15 minutes...');
                await this.app.appleTvFlow.triggerCompanionLinkFailed(this);
            }

            if (!this.#tv?.companionLink?.isConnected && this.#tv) {
                this.#scheduleSlowRecoveryAttempt();
            }
        }, interval);
    }

    #stopSlowRecovery(): void {
        if (this.#slowRecoveryTimer) {
            clearTimeout(this.#slowRecoveryTimer);
            this.#slowRecoveryTimer = null;
        }
        this.#slowRecoveryAttempt = 0;
    }

    async #onCompanionLinkFailed(): Promise<void> {
        if (this.#slowRecoveryTimer) {
            return;
        }

        if (!this.#companionLinkRetried) {
            this.#companionLinkRetried = true;

            this.log('Companion Link failed, attempting re-discovery before giving up...');
            await this.setUnavailable('Reconnecting to Apple TV...');

            try {
                const cl = await this.#discoverCompanionLink(this.discoveryResultAirPlay.address);

                if (!cl) {
                    throw new Error('Companion Link not found via unicast.');
                }

                const tv = this.#tv;

                if (!tv?.companionLink) {
                    return;
                }

                this.log(`Re-discovered Companion Link at ${cl.address}:${cl.service.port}, reconnecting...`);
                this.#companionLinkRecovery?.reset();
                tv.companionLink.discoveryResult = cl;

                const credentials = getAccessoryCredentialsFromDevice(this);

                if (credentials) {
                    await tv.companionLink.setCredentials(credentials);
                    await tv.companionLink.connect();
                }

                return;
            } catch {
                this.log('Re-discovery of Companion Link service failed.');
            }
        }

        await this.#startSlowRecovery();
    }

    #registerCapabilities(): void {
        this.#registerOnOff();
        this.#registerRemote();

        this.registerCapabilityListener('speaker_next', async () => {
            await this.sdk.playback.next();
        });

        this.registerCapabilityListener('speaker_prev', async () => {
            await this.sdk.playback.previous();
        });

        this.registerCapabilityListener('speaker_stop', async () => {
            await this.sdk.playback.stop();
        });

        this.registerCapabilityListener('speaker_playing', async (play: boolean) => {
            if (play) {
                await this.sdk.playback.play();
            } else {
                await this.sdk.playback.pause();
            }
        });

        this.registerCapabilityListener('volume_set', async (volume: number) => {
            await this.sdk.volume.set(volume);
        });

        this.registerCapabilityListener('volume_up', async () => {
            await this.sdk.volume.up();
        });

        this.registerCapabilityListener('volume_down', async () => {
            await this.sdk.volume.down();
        });

        this.registerCapabilityListener('volume_mute', async () => {
            await this.sdk.remote.mute();
        });

        this.registerCapabilityListener('speaker_repeat', async (value: string) => {
            await this.sdk.playback.setRepeatMode(capabilityToRepeatMode[value] ?? Proto.RepeatMode_Enum.Off);
        });

        this.registerCapabilityListener('speaker_shuffle', async (value: boolean) => {
            const mode = value ? Proto.ShuffleMode_Enum.Songs : Proto.ShuffleMode_Enum.Off;
            await this.sdk.playback.setShuffleMode(mode);
        });
    }

    #registerMaintenance(): void {
        this.registerCapabilityListener('button.restart', async () => {
            try {
                this.#stopSlowRecovery();
                this.#airplayRecovery?.dispose();
                this.#companionLinkRecovery?.dispose();
                this.#companionLinkRetried = false;
                this.#tv?.disconnect();
                this.#tv = undefined;
                await this.#airplayLogic.clearNowPlaying();
                await this.#connect();
            } catch (err) {
                this.error(err);
            }
        });
    }

    #registerOnOff(): void {
        this.registerCapabilityListener('onoff', async (value: boolean) => {
            if (value) {
                await this.sdk.power?.on();
            } else {
                await this.sdk.power?.off();
            }
        });
    }

    #registerRemote(): void {
        const keys = CAPABILITIES.filter(k => k.startsWith('remote_'));

        this.registerMultipleCapabilityListener(keys, async values => {
            values.remote_up === true && await this.sdk.remote.up();
            values.remote_down === true && await this.sdk.remote.down();
            values.remote_left === true && await this.sdk.remote.left();
            values.remote_right === true && await this.sdk.remote.right();
            values.remote_select === true && await this.sdk.remote.select();
            values.remote_home === true && await this.sdk.remote.home();
            values.remote_back === true && await this.sdk.remote.menu();
            values.remote_playpause === true && await this.sdk.remote.playPause();
        }, 0);
    }

    async onServiceFound(service: string, discoveryResult: DiscoveryResult): Promise<void> {
        await super.onServiceFound(service, discoveryResult);

        if (this.#connectedOnce) {
            return;
        }

        if (!this.discoveryResultAirPlay) {
            return;
        }

        this.#connectedOnce = true;
        await this.#connect();
    }

    async onServiceUpdated(service: string, discoveryResult: DiscoveryResult): Promise<void> {
        await super.onServiceUpdated(service, discoveryResult);

        if (!this.#tv) {
            await this.#connect();
            return;
        }

        requestConnectionRecovery(this.#tv.airplay, this.#airplayRecovery);
        requestConnectionRecovery(this.#tv.companionLink, this.#companionLinkRecovery);
    }
}

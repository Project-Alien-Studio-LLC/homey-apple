import assert from 'node:assert/strict';
import test from 'node:test';
import normalizePlaybackState from '../src/utils/normalizePlaybackState';
import requestConnectionRecovery from '../src/utils/requestConnectionRecovery';
import SingleFlight from '../src/utils/singleFlight';

test('normalizePlaybackState preserves valid media timing', () => {
    assert.deepEqual(normalizePlaybackState(42.5, 211.25), {
        position: 42.5,
        duration: 211.25
    });
});

test('normalizePlaybackState clamps a stale position to duration', () => {
    assert.deepEqual(normalizePlaybackState(14_201, 211.25), {
        position: 211.25,
        duration: 211.25
    });
});

test('normalizePlaybackState rejects negative and non-finite timing', () => {
    assert.deepEqual(normalizePlaybackState(Number.POSITIVE_INFINITY, Number.NaN), {
        position: -1,
        duration: -1
    });
    assert.deepEqual(normalizePlaybackState(-5, 120), {
        position: 0,
        duration: 120
    });
});

test('SingleFlight coalesces concurrent operations', async () => {
    const flight = new SingleFlight<number>();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
        release = resolve;
    });

    const action = async (): Promise<number> => {
        calls++;
        await gate;
        return 7;
    };

    const first = flight.run(action);
    const second = flight.run(action);
    assert.equal(first, second);
    assert.equal(calls, 1);

    release();
    assert.deepEqual(await Promise.all([first, second]), [7, 7]);
});

test('SingleFlight permits retry after a failed operation', async () => {
    const flight = new SingleFlight<number>();
    let calls = 0;

    await assert.rejects(
        flight.run(async () => {
            calls++;
            throw new Error('offline');
        }),
        /offline/
    );

    const result = await flight.run(async () => {
        calls++;
        return 11;
    });

    assert.equal(result, 11);
    assert.equal(calls, 2);
});

test('requestConnectionRecovery schedules only disconnected protocols', () => {
    const calls: boolean[] = [];
    const recovery = {
        handleDisconnect: (unexpected: boolean) => calls.push(unexpected)
    };

    assert.equal(requestConnectionRecovery({isConnected: true}, recovery), false);
    assert.equal(requestConnectionRecovery(undefined, recovery), false);
    assert.equal(requestConnectionRecovery({isConnected: false}, undefined), false);
    assert.equal(requestConnectionRecovery({isConnected: false}, recovery), true);
    assert.deepEqual(calls, [true]);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { runWidgetAction } from '../widgets/shared';

const createRequest = () => {
    const errors: unknown[][] = [];
    const request = {
        homey: {
            app: {
                error: (...args: unknown[]) => errors.push(args)
            }
        }
    } as any;

    return { errors, request };
};

const device = {
    getName: () => 'Test Apple TV'
} as any;

test('runWidgetAction reports success without diagnostics noise', async () => {
    const { errors, request } = createRequest();
    let called = false;

    const result = await runWidgetAction(request, device, 'play', async () => {
        called = true;
    });

    assert.equal(result, true);
    assert.equal(called, true);
    assert.equal(errors.length, 0);
});

test('runWidgetAction logs the device and action when a command fails', async () => {
    const { errors, request } = createRequest();

    const result = await runWidgetAction(request, device, 'play', async () => {
        throw new Error('offline');
    });

    assert.equal(result, false);
    assert.equal(errors.length, 1);
    assert.equal(errors[0][0], '[widget]');
    assert.match(String(errors[0][1]), /Test Apple TV: play failed/);
    assert.match(String(errors[0][2]), /offline/);
});

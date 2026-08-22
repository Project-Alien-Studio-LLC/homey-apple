import type { Device, WidgetApiRequest } from '@basmilius/homey-common';
import type AppleApp from '../src';

export async function findDevice<T extends Device<AppleApp, any>>(
    request: WidgetApiRequest<AppleApp, any, { deviceId: string }>,
    deviceId: string
): Promise<T | null> {
    return request.homey.app.getDevice<T>(deviceId);
}

export async function runWidgetAction<T extends Device<AppleApp, any>>(
    request: WidgetApiRequest<AppleApp, any, any>,
    device: T,
    actionName: string,
    action: () => Promise<void>
): Promise<boolean> {
    try {
        await action();
        return true;
    } catch (err) {
        request.homey.app.error('[widget]', `${device.getName()}: ${actionName} failed.`, err);
        return false;
    }
}

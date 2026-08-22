type Connection = {
    readonly isConnected: boolean;
};

type Recovery = {
    handleDisconnect(unexpected: boolean): void;
};

/** Requests recovery only for a known, disconnected protocol connection. */
export default function requestConnectionRecovery(
    connection: Connection | null | undefined,
    recovery: Recovery | null | undefined
): boolean {
    if (!connection || connection.isConnected || !recovery) {
        return false;
    }

    recovery.handleDisconnect(true);
    return true;
}

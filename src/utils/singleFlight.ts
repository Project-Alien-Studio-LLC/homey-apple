/** Coalesces concurrent asynchronous work and permits a fresh run after settlement. */
export default class SingleFlight<T> {
    #current: Promise<T> | null = null;

    run(action: () => Promise<T>): Promise<T> {
        if (this.#current) {
            return this.#current;
        }

        this.#current = action().finally(() => {
            this.#current = null;
        });

        return this.#current;
    }
}

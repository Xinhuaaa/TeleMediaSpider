import { EventEmitter } from 'events';

/**
 * Event Bus for replacing busy polling with event-driven architecture
 * This reduces CPU usage by eliminating the need for constant polling
 */
export class EventBus extends EventEmitter {
    constructor() {
        super();
        this.setMaxListeners(100); // Increase listener limit for concurrent operations
    }

    /**
     * Wait for a condition to be met using event-driven approach
     * @param eventName Event to listen for
     * @param checker Function to check if condition is met
     * @param timeout Optional timeout in milliseconds
     */
    async waitForCondition(
        eventName: string,
        checker: () => boolean,
        timeout?: number
    ): Promise<void> {
        // Check immediately first
        if (checker()) {
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            let timeoutHandle: NodeJS.Timeout | null = null;

            const listener = () => {
                if (checker()) {
                    if (timeoutHandle) clearTimeout(timeoutHandle);
                    this.off(eventName, listener);
                    resolve();
                }
            };

            this.on(eventName, listener);

            if (timeout) {
                timeoutHandle = setTimeout(() => {
                    this.off(eventName, listener);
                    reject(new Error(`Timeout waiting for ${eventName}`));
                }, timeout);
            }
        });
    }

    /**
     * Emit an event to notify listeners
     * @param eventName Event name
     * @param data Optional data to pass
     */
    emitEvent(eventName: string, data?: any): void {
        this.emit(eventName, data);
    }
}

// Global event bus instance
export const globalEventBus = new EventBus();

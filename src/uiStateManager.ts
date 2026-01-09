/**
 * UI State Manager
 * Manages the state of the UI to prevent conflicts between logging and menu interaction
 */

export type UIState = 'idle' | 'menu' | 'downloading';

class UIStateManager {
    private currentState: UIState = 'idle';
    private stateChangeCallbacks: ((state: UIState) => void)[] = [];

    /**
     * Get the current UI state
     */
    getState(): UIState {
        return this.currentState;
    }

    /**
     * Set the UI state
     * @param state New state
     */
    setState(state: UIState): void {
        if (this.currentState !== state) {
            this.currentState = state;
            this.notifyStateChange(state);
        }
    }

    /**
     * Check if currently in menu state
     */
    isInMenu(): boolean {
        return this.currentState === 'menu';
    }

    /**
     * Check if currently downloading
     */
    isDownloading(): boolean {
        return this.currentState === 'downloading';
    }

    /**
     * Check if currently idle
     */
    isIdle(): boolean {
        return this.currentState === 'idle';
    }

    /**
     * Register a callback to be notified of state changes
     * @param callback Function to call when state changes
     */
    onStateChange(callback: (state: UIState) => void): void {
        this.stateChangeCallbacks.push(callback);
    }

    /**
     * Notify all registered callbacks of state change
     * @param state New state
     */
    private notifyStateChange(state: UIState): void {
        for (const callback of this.stateChangeCallbacks) {
            try {
                callback(state);
            } catch (error) {
                // Log errors in callbacks for debugging, but continue execution
                if (typeof console !== 'undefined' && console.error) {
                    console.error('Error in UI state change callback:', error);
                }
            }
        }
    }

    /**
     * Execute a function with a specific UI state, then restore the previous state
     * @param state State to set during execution
     * @param fn Function to execute
     */
    async withState<T>(state: UIState, fn: () => Promise<T>): Promise<T> {
        const previousState = this.currentState;
        this.setState(state);
        try {
            return await fn();
        } finally {
            this.setState(previousState);
        }
    }
}

// Global UI state manager instance
export const uiStateManager = new UIStateManager();

/**
 * Throttled logging utility for high-frequency code paths (render loops, physics ticks, etc.).
 *
 * Features:
 * - Per-group throttling: suppresses duplicate log calls within a configurable interval
 * - Per-instance tag: prefixes all output with `[Tag]` for easy DevTools filtering
 * - Per-instance log level with global fallback
 * - Drop counter: reports how many messages were suppressed since the last emission
 * - `once()`: log a message exactly once per group (initialization, one-time warnings)
 * - `clearGroup()` / `clearAllGroups()`: reclaim memory from dynamic group names
 */

export enum LogLevel {
    ERROR = 0,
    WARN = 1,
    LOG = 2,
    INFO = 3,
    DEBUG = 4
}

interface GroupState {
    /** Timestamp (ms) of the last emitted log for this group */
    lastTimeMs: number;
    /** Number of calls suppressed since the last emission */
    droppedCount: number;
}

export class Logger {

    /** Global log level — used when no per-instance level is set */
    public static globalLevel: LogLevel = LogLevel.LOG;

    /**
     * @deprecated Use `Logger.globalLevel` instead. Kept for backward compatibility.
     */
    public static get LOG_LEVEL(): LogLevel { return Logger.globalLevel; }
    public static set LOG_LEVEL(v: LogLevel) { Logger.globalLevel = v; }

    /** Optional per-instance level; when set, overrides `Logger.globalLevel` */
    public level: LogLevel | undefined;

    /** Human-readable tag prefixed to every log message (e.g. `[ShadowPass]`) */
    private _tag: string;

    /**
     * Minimum interval (ms) between consecutive logs of the same group.
     * Zero means no throttling — every call is emitted immediately.
     */
    private _throttleMs: number;

    /** Per-group throttle state */
    private _groups: Map<string, GroupState> = new Map();

    /** Groups that have already fired via `once()` */
    private _onceGroups: Set<string> = new Set();

    constructor(tag: string = '', throttleMs: number = 0, level?: LogLevel) {
        this._tag = tag;
        this._throttleMs = throttleMs;
        this.level = level;
    }

    /**
     * Factory method.
     * - `createLogger('Terrain', 500)` → tagged logger
     */
    static createLogger(tag: string, throttleMs?: number, level?: LogLevel): Logger {
        return new Logger(tag, throttleMs ?? 0, level);
    }

    /** Effective log level for this instance */
    private get _effectiveLevel(): LogLevel {
        return this.level ?? Logger.globalLevel;
    }

    // ========================================================================
    // Throttle internals
    // ========================================================================

    private _getOrCreateGroup(group: string): GroupState {
        let state = this._groups.get(group);
        if (!state) {
            state = { lastTimeMs: 0, droppedCount: 0 };
            this._groups.set(group, state);
        }
        return state;
    }

    /**
     * Throttle gate. Executes `callback` at most once per `_throttleMs` per group.
     * When a message is finally emitted after suppression, appends a drop summary.
     */
    private _exec(group: string, callback: (droppedSuffix: string) => void): void {
        if (this._throttleMs === 0) {
            callback('');
            return;
        }

        const state = this._getOrCreateGroup(group);
        const now = performance.now();

        if (now - state.lastTimeMs >= this._throttleMs) {
            const suffix = state.droppedCount > 0
                ? ` (suppressed ${state.droppedCount} similar message${state.droppedCount > 1 ? 's' : ''})`
                : '';
            state.droppedCount = 0;
            state.lastTimeMs = now;
            callback(suffix);
        } else {
            state.droppedCount++;
        }
    }

    /** Build the prefix string (tag + optional drop suffix) */
    private _prefix(message: string, droppedSuffix: string): string {
        const tag = this._tag ? `[${this._tag}] ` : '';
        return `${tag}${message}${droppedSuffix}`;
    }

    // ========================================================================
    // Log methods
    // ========================================================================

    debug(group: string, message: string, ...args: any[]): void {
        if (this._effectiveLevel >= LogLevel.DEBUG) {
            this._exec(group, (s) => console.debug(this._prefix(message, s), ...args));
        }
    }

    info(group: string, message: string, ...args: any[]): void {
        if (this._effectiveLevel >= LogLevel.INFO) {
            this._exec(group, (s) => console.info(this._prefix(message, s), ...args));
        }
    }

    log(group: string, message: string, ...args: any[]): void {
        if (this._effectiveLevel >= LogLevel.LOG) {
            this._exec(group, (s) => console.log(this._prefix(message, s), ...args));
        }
    }

    warn(group: string, message: string, ...args: any[]): void {
        if (this._effectiveLevel >= LogLevel.WARN) {
            this._exec(group, (s) => console.warn(this._prefix(message, s), ...args));
        }
    }

    error(group: string, message: string, ...args: any[]): void {
        if (this._effectiveLevel >= LogLevel.ERROR) {
            this._exec(group, (s) => console.error(this._prefix(message, s), ...args));
        }
    }

    // ========================================================================
    // Once — log exactly one time per group
    // ========================================================================

    /**
     * Log a message exactly once for the given group. Subsequent calls with the
     * same group are silently ignored. Useful for initialization messages and
     * one-time warnings in hot paths.
     */
    once(group: string, message: string, ...args: any[]): void {
        if (this._onceGroups.has(group)) return;
        this._onceGroups.add(group);
        const tag = this._tag ? `[${this._tag}] ` : '';
        console.log(`${tag}${message}`, ...args);
    }

    /**
     * Like `once()` but at warn level.
     */
    warnOnce(group: string, message: string, ...args: any[]): void {
        if (this._onceGroups.has(group)) return;
        this._onceGroups.add(group);
        const tag = this._tag ? `[${this._tag}] ` : '';
        console.warn(`${tag}${message}`, ...args);
    }

    // ========================================================================
    // Group management
    // ========================================================================

    /** Remove throttle state for a specific group, freeing memory. */
    clearGroup(group: string): void {
        this._groups.delete(group);
        this._onceGroups.delete(group);
    }

    /** Remove all throttle state, freeing memory from dynamic group names. */
    clearAllGroups(): void {
        this._groups.clear();
        this._onceGroups.clear();
    }

    /** Number of tracked groups (useful for diagnostics / leak detection). */
    get groupCount(): number {
        return this._groups.size + this._onceGroups.size;
    }

    // ========================================================================
    // Global level helpers
    // ========================================================================

    /** Convenience setter for the global log level. */
    static setGlobalLevel(level: LogLevel): void {
        Logger.globalLevel = level;
    }
}
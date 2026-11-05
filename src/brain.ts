import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const BUS_NAME = 'io.github.aceep.Crepe.Brain';
const OBJECT_PATH = '/io/github/aceep/Crepe/Brain';
const INTERFACE_NAME = 'io.github.aceep.Crepe.Brain';
const ERROR_PREFIX = `${INTERFACE_NAME}.Error.`;
/**
 * The daemon gives the remote model 20 s and one retry before it answers
 * Upstream itself; giving up sooner would drop a request it still counts.
 */
const CALL_TIMEOUT_MS = 45 * 1000;

export type BrainErrorKind = 'no-key' | 'budget' | 'upstream' | 'invalid' | 'unavailable' | 'timeout';

/** What went wrong talking to the daemon, sorted into what she has a line for. The message is for the logs only. */
export class BrainError extends Error {
    readonly kind: BrainErrorKind;

    constructor(kind: BrainErrorKind, message: string) {
        super(message);
        this.name = 'BrainError';
        this.kind = kind;
    }
}

/** The daemon's `Status()`, with defaults for whatever an older daemon leaves out. */
export interface BrainStatus {
    hasKey: boolean;
    model: string;
    requestsToday: number;
    dailyBudget: number;
    remarksEnabled: boolean;
    fake: boolean;
    version: string;
}

const REMOTE_ERRORS: Record<string, BrainErrorKind> = {
    NoKey: 'no-key',
    Budget: 'budget',
    Upstream: 'upstream',
    Invalid: 'invalid',
};

/**
 * The conversation daemon on the session bus, when it runs. It is
 * optional: the name is watched, a proxy exists only while someone owns
 * it, and every call fails with an `unavailable` BrainError otherwise.
 * No shell UI in here, so the preferences process can use it too.
 */
export class Brain {
    private readonly cancellable = new Gio.Cancellable();
    private readonly onAvailabilityChanged: () => void;
    private watchId: number | null;
    private proxy: Gio.DBusProxy | null = null;
    /** Whether the daemon's own config lets `Remark()` say anything, as of its last `Status()`. */
    private remarksAllowed = false;

    constructor(onAvailabilityChanged: () => void = () => {}) {
        this.onAvailabilityChanged = onAvailabilityChanged;
        // No auto-start: a daemon the user did not start is a daemon they did not want.
        this.watchId = Gio.bus_watch_name(
            Gio.BusType.SESSION,
            BUS_NAME,
            Gio.BusNameWatcherFlags.NONE,
            () => this.connectProxy(),
            () => this.dropProxy(),
        );
    }

    get available(): boolean {
        return this.proxy !== null;
    }

    /**
     * With remarks off in its config the daemon answers every `Remark()`
     * with "", so asking would only turn idle remarks into silences.
     */
    get remarksEnabled(): boolean {
        return this.remarksAllowed;
    }

    async ask(text: string, context: string): Promise<string> {
        const reply = await this.call('Ask', new GLib.Variant('(ss)', [text, context]));
        return firstString(reply);
    }

    /** Resolves to "" when the daemon has nothing to say. */
    async remark(context: string): Promise<string> {
        const reply = await this.call('Remark', new GLib.Variant('(s)', [context]));
        return firstString(reply);
    }

    /** Null when the daemon is not there or does not answer. */
    async status(): Promise<BrainStatus | null> {
        try {
            const status = parseStatus(await this.call('Status', null));
            this.remarksAllowed = status.remarksEnabled;
            return status;
        } catch (error) {
            console.warn(`Crêpe: daemon status unavailable: ${describe(error)}`);
            return null;
        }
    }

    async forget(): Promise<void> {
        await this.call('Forget', null);
    }

    destroy(): void {
        this.cancellable.cancel();
        if (this.watchId !== null)
            Gio.bus_unwatch_name(this.watchId);
        this.watchId = null;
        this.proxy = null;
    }

    private connectProxy(): void {
        Gio.DBusProxy.new_for_bus(
            Gio.BusType.SESSION,
            Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES |
                Gio.DBusProxyFlags.DO_NOT_CONNECT_SIGNALS |
                Gio.DBusProxyFlags.DO_NOT_AUTO_START,
            null,
            BUS_NAME,
            OBJECT_PATH,
            INTERFACE_NAME,
            this.cancellable,
            (_source, result) => {
                try {
                    this.proxy = Gio.DBusProxy.new_for_bus_finish(result);
                } catch (error) {
                    if (!isCancelled(error))
                        console.warn(`Crêpe: could not reach the daemon: ${describe(error)}`);
                    return;
                }
                this.onAvailabilityChanged();
                // Its config only changes with a restart, which shows up here as the name coming back.
                this.status().catch(() => {});
            },
        );
    }

    private dropProxy(): void {
        const hadProxy = this.proxy !== null;
        this.proxy = null;
        this.remarksAllowed = false;
        if (hadProxy)
            this.onAvailabilityChanged();
    }

    private call(method: string, parameters: GLib.Variant | null): Promise<GLib.Variant> {
        const proxy = this.proxy;
        if (!proxy)
            return Promise.reject(new BrainError('unavailable', `${method}: the daemon is not running`));
        return new Promise((resolve, reject) => {
            proxy.call(method, parameters, Gio.DBusCallFlags.NO_AUTO_START, CALL_TIMEOUT_MS, this.cancellable,
                (_source, result) => {
                    try {
                        resolve(proxy.call_finish(result));
                    } catch (error) {
                        reject(toBrainError(method, error));
                    }
                });
        });
    }
}

/**
 * One-off `Status()` for whoever does not keep a Brain around, such as
 * the preferences window. Null when the daemon is not running.
 */
export function fetchStatus(cancellable: Gio.Cancellable | null, callback: (status: BrainStatus | null) => void): void {
    Gio.DBus.session.call(BUS_NAME, OBJECT_PATH, INTERFACE_NAME, 'Status', null, null,
        Gio.DBusCallFlags.NO_AUTO_START, CALL_TIMEOUT_MS, cancellable, (_source, result) => {
            try {
                callback(parseStatus(Gio.DBus.session.call_finish(result)));
            } catch (error) {
                if (isCancelled(error))
                    return;
                callback(null);
            }
        });
}

function toBrainError(method: string, error: unknown): BrainError {
    const message = `${method}: ${describe(error)}`;
    if (!(error instanceof GLib.Error))
        return new BrainError('upstream', message);
    if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.TIMED_OUT) ||
        error.matches(Gio.DBusError, Gio.DBusError.TIMEOUT) ||
        error.matches(Gio.DBusError, Gio.DBusError.TIMED_OUT) ||
        error.matches(Gio.DBusError, Gio.DBusError.NO_REPLY))
        return new BrainError('timeout', message);
    // Gone between the name watch and the call, or the call was dropped on disable.
    if (error.matches(Gio.DBusError, Gio.DBusError.SERVICE_UNKNOWN) ||
        error.matches(Gio.DBusError, Gio.DBusError.NAME_HAS_NO_OWNER) ||
        error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) ||
        error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CLOSED))
        return new BrainError('unavailable', message);
    const remote = Gio.DBusError.is_remote_error(error) ? Gio.DBusError.get_remote_error(error) : null;
    if (remote?.startsWith(ERROR_PREFIX))
        return new BrainError(REMOTE_ERRORS[remote.slice(ERROR_PREFIX.length)] ?? 'upstream', message);
    return new BrainError('upstream', message);
}

function firstString(reply: GLib.Variant): string {
    const [text] = reply.deepUnpack<[string]>();
    return typeof text === 'string' ? text : '';
}

function parseStatus(reply: GLib.Variant): BrainStatus {
    const [fields] = reply.recursiveUnpack() as [Record<string, unknown>];
    return {
        hasKey: fields['has_key'] === true,
        model: typeof fields['model'] === 'string' ? fields['model'] : '',
        requestsToday: typeof fields['requests_today'] === 'number' ? fields['requests_today'] : 0,
        dailyBudget: typeof fields['daily_budget'] === 'number' ? fields['daily_budget'] : 0,
        remarksEnabled: fields['remarks_enabled'] === true,
        fake: fields['fake'] === true,
        version: typeof fields['version'] === 'string' ? fields['version'] : '',
    };
}

function isCancelled(error: unknown): boolean {
    return error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

/** Remote errors carry their D-Bus name in the message; it stays in the logs. */
function describe(error: unknown): string {
    return error instanceof Error || error instanceof GLib.Error ? error.message : String(error);
}

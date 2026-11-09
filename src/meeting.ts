import type Gvc from 'gi://Gvc';
import type Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';

import type {CallSignals} from './digest.js';

/**
 * Whether the screen is shared or recorded, and whether an application
 * listens to the microphone or looks through a camera, from the same
 * sources the shell's own indicators use:
 *
 * - sharing: `Meta.RemoteAccessController`'s `new-handle` signal, whose
 *   handles end with `stopped` (screen sharing, remote desktop and the
 *   portal's screencasts, which is what the panel's indicators follow),
 *   and `Main.screenshotUI`'s `screencast-in-progress` (the built-in recorder);
 * - microphone: the source outputs of the shell's `Gvc.MixerControl`
 *   (`stream-added`, `stream-removed`), event sounds left out;
 * - camera: `Shell.CameraMonitor`'s `cameras-in-use`, which sees PipeWire
 *   cameras only, not an application opening /dev/video* by itself.
 */
export class MeetingMonitor {
    private readonly onChange: () => void;
    private readonly handles = new Map<Meta.RemoteAccessHandle, number>();
    private controllerId: number | null = null;
    private screencastId: number | null = null;
    private mixerIds: number[] = [];
    private cameraMonitor: Shell.CameraMonitor | null = null;
    private cameraId: number | null = null;
    private microphoneInUse = false;
    /** Set from Eval to stand in for what only a real call could show. */
    private simulated: Partial<CallSignals> = {};

    constructor(onChange: () => void) {
        this.onChange = onChange;
        this.watchSharing();
        this.watchMicrophone();
        this.watchCamera();
    }

    get signals(): CallSignals {
        const screenshotUI = Main.screenshotUI as {screencast_in_progress?: boolean};
        return {
            sharing: this.simulated.sharing ?? (this.handles.size > 0 || screenshotUI.screencast_in_progress === true),
            microphone: this.simulated.microphone ?? this.microphoneInUse,
            camera: this.simulated.camera ?? this.cameraMonitor?.camerasInUse === true,
        };
    }

    /** For tests: the given signals read as set until `simulate({})`, whatever the desktop says. */
    simulate(signals: Partial<CallSignals>): void {
        this.simulated = signals;
        this.onChange();
    }

    destroy(): void {
        const controller = global.backend.get_remote_access_controller();
        if (controller && this.controllerId !== null)
            controller.disconnect(this.controllerId);
        this.controllerId = null;
        for (const [handle, id] of this.handles)
            handle.disconnect(id);
        this.handles.clear();
        if (this.screencastId !== null)
            Main.screenshotUI.disconnect(this.screencastId);
        this.screencastId = null;
        const control = getMixerControl();
        for (const id of this.mixerIds)
            control.disconnect(id);
        this.mixerIds = [];
        if (this.cameraMonitor && this.cameraId !== null)
            this.cameraMonitor.disconnect(this.cameraId);
        this.cameraMonitor = null;
        this.cameraId = null;
    }

    private watchSharing(): void {
        // Null where the compositor offers no remote access.
        const controller = global.backend.get_remote_access_controller();
        this.controllerId = controller?.connect('new-handle', (_controller: Meta.RemoteAccessController, handle: Meta.RemoteAccessHandle) => {
            const id = handle.connect('stopped', () => {
                handle.disconnect(id);
                this.handles.delete(handle);
                this.onChange();
            });
            this.handles.set(handle, id);
            this.onChange();
        }) ?? null;
        this.screencastId = Main.screenshotUI.connect('notify::screencast-in-progress', () => this.onChange());
    }

    private watchMicrophone(): void {
        const control = getMixerControl();
        this.mixerIds = [
            control.connect('state-changed', () => this.readMicrophone(null)),
            control.connect('stream-added', () => this.readMicrophone(null)),
            // Whether the stream is still listed when this fires is not promised: leave it out by id.
            control.connect('stream-removed', (_control: Gvc.MixerControl, id: number) => this.readMicrophone(id)),
        ];
        this.readMicrophone(null);
    }

    private readMicrophone(removedId: number | null): void {
        const outputs = getMixerControl().get_source_outputs();
        const inUse = outputs.some(output => !output.is_event_stream && output.get_id() !== removedId);
        if (inUse === this.microphoneInUse)
            return;
        this.microphoneInUse = inUse;
        this.onChange();
    }

    private watchCamera(): void {
        try {
            this.cameraMonitor = new Shell.CameraMonitor();
        } catch (error) {
            console.warn(`Crêpe: no camera monitor, cameras go unnoticed: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        this.cameraId = this.cameraMonitor.connect('notify::cameras-in-use', () => this.onChange());
    }
}

import type {NudgeKind} from './nudgetext.js';

/** More than this and the oldest is forgotten: the summary is a line, not a log. */
export const DIGEST_CAP = 20;

/** What the screen sharing or the calls ask of her. */
export interface CallSignals {
    sharing: boolean;
    microphone: boolean;
    camera: boolean;
}

export interface MeetingMode {
    /** Off the stage altogether. */
    hidden: boolean;
    /** Not a word, not a reaction to a script; hidden implies silent. */
    silent: boolean;
}

/**
 * What the signals and the two settings make of her. Sharing the screen
 * hides her when allowed to; a microphone or a camera in use only silences her.
 */
export function meetingMode(signals: CallSignals, options: {hide: boolean; quiet: boolean}): MeetingMode {
    const hidden = options.hide && signals.sharing;
    const onACall = options.quiet && (signals.microphone || signals.camera);
    return {hidden, silent: hidden || onACall};
}

/** Singular and plural of what each kind of nudge is called in the summary, in the order they are told. */
const LABELS: readonly (readonly [NudgeKind, string, string])[] = [
    ['pipeline_echec', 'pipeline en échec', 'pipelines en échec'],
    ['ticket_nouveau', 'ticket', 'tickets'],
    ['commande_echec', 'commande en échec', 'commandes en échec'],
    ['commande_longue', 'commande longue', 'commandes longues'],
    ['tache_terminee', 'tâche terminée', 'tâches terminées'],
    ['travail_non_commite', 'rappel git', 'rappels git'],
    ['agenda', 'rappel agenda', 'rappels agenda'],
    ['machine', 'alerte machine', 'alertes machine'],
    ['attention', 'appel à l\'aide', 'appels à l\'aide'],
    ['info', 'message', 'messages'],
];

/** The nudges that came in while she kept quiet, counted per kind when she finally speaks. */
export class MeetingDigest {
    private readonly kinds: NudgeKind[] = [];

    /** Kinds that are a state rather than an event (`tickets_ouverts`) are not worth a mention. */
    add(kind: NudgeKind): void {
        if (!LABELS.some(([known]) => known === kind))
            return;
        this.kinds.push(kind);
        if (this.kinds.length > DIGEST_CAP)
            this.kinds.shift();
    }

    clear(): void {
        this.kinds.length = 0;
    }

    /** "2 pipelines en échec, 1 ticket", or null when nothing came in. */
    summary(): string | null {
        const parts: string[] = [];
        for (const [kind, singular, plural] of LABELS) {
            const count = this.kinds.filter(known => known === kind).length;
            if (count > 0)
                parts.push(`${count} ${count === 1 ? singular : plural}`);
        }
        return joinFrench(parts);
    }
}

/** "a", "a et b", "a, b et c"; null for an empty list. */
export function joinFrench(parts: readonly string[]): string | null {
    const last = parts[parts.length - 1];
    if (last === undefined)
        return null;
    return parts.length === 1 ? last : `${parts.slice(0, -1).join(', ')} et ${last}`;
}

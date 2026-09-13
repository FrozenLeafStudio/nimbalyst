/**
 * Engine-specific voice settings data and the rules around previewing a voice.
 *
 * The preview trap this guards: `voice-mode:preview-voice` does not reach the
 * speech-to-speech engine at all. It calls a separate TTS endpoint, which has
 * its own, smaller voice list. Passing a name that endpoint does not know fails;
 * passing a name it happens to share produces a sample that is not what the
 * conversation will sound like. So a voice is previewable only when we can name
 * the TTS voice to use, and any stand-in is labelled as one.
 */

import type { VoiceEngineId } from '../../store/atoms/voiceModeState';

/**
 * Voices the TTS speech endpoint accepts directly. Anything outside this set
 * needs an explicit stand-in or it cannot be previewed.
 */
const TTS_NATIVE_VOICES = new Set(['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer']);

/**
 * Stand-ins for speech-to-speech voices the TTS endpoint does not have. Must
 * stay in step with the map in VoiceModeService's preview handler -- that
 * handler is what actually performs the substitution.
 */
const TTS_STAND_INS: Record<string, string> = {
  ballad: 'nova',
  marin: 'alloy',
  cedar: 'onyx',
  verse: 'fable',
};

export interface VoiceCatalogEntry {
  id: string;
  name: string;
  description: string;
  gender: 'male' | 'female' | 'neutral';
  /** Engines known to accept this voice. */
  engines: readonly VoiceEngineId[];
}

/**
 * Live does not publish its own voice list. Its session config takes the same
 * voice names (the Live startup fixtures use `marin`), so the same catalog is
 * offered on both engines. If an engine rejects a name at startup it reports
 * that itself -- we do not invent a restriction here, and we do not invent
 * Live-only names either.
 */
export const VOICE_CATALOG: readonly VoiceCatalogEntry[] = [
  { id: 'ash', name: 'Ash', description: 'Clear and confident', gender: 'male', engines: ['realtime', 'live'] },
  { id: 'echo', name: 'Echo', description: 'Smooth and resonant', gender: 'male', engines: ['realtime', 'live'] },
  { id: 'verse', name: 'Verse', description: 'Dynamic and engaging', gender: 'male', engines: ['realtime', 'live'] },
  { id: 'cedar', name: 'Cedar', description: 'Deep and authoritative', gender: 'male', engines: ['realtime', 'live'] },
  { id: 'coral', name: 'Coral', description: 'Warm and friendly', gender: 'female', engines: ['realtime', 'live'] },
  { id: 'sage', name: 'Sage', description: 'Thoughtful and calm', gender: 'female', engines: ['realtime', 'live'] },
  { id: 'shimmer', name: 'Shimmer', description: 'Bright and cheerful', gender: 'female', engines: ['realtime', 'live'] },
  { id: 'ballad', name: 'Ballad', description: 'Melodic and expressive', gender: 'female', engines: ['realtime', 'live'] },
  { id: 'marin', name: 'Marin', description: 'Natural and conversational', gender: 'female', engines: ['realtime', 'live'] },
  { id: 'alloy', name: 'Alloy', description: 'Balanced and versatile', gender: 'neutral', engines: ['realtime', 'live'] },
];

export function voicesForEngine(engine: VoiceEngineId): VoiceCatalogEntry[] {
  return VOICE_CATALOG.filter((v) => v.engines.includes(engine));
}

export function voiceGroupsForEngine(engine: VoiceEngineId): Array<{ label: string; voices: VoiceCatalogEntry[] }> {
  const voices = voicesForEngine(engine);
  return (['male', 'female', 'neutral'] as const)
    .map((gender) => ({
      label: gender === 'male' ? 'Male' : gender === 'female' ? 'Female' : 'Neutral',
      voices: voices.filter((v) => v.gender === gender),
    }))
    .filter((group) => group.voices.length > 0);
}

/**
 * The voice to actually use on this engine. A voice the engine does not accept
 * falls back to that engine's first option rather than being sent through and
 * failing at connect time.
 */
export function resolveVoiceForEngine(engine: VoiceEngineId, voiceId: string | undefined): string {
  const available = voicesForEngine(engine);
  if (voiceId && available.some((v) => v.id === voiceId)) return voiceId;
  return available[0]?.id ?? 'alloy';
}

export interface VoicePreviewEligibility {
  canPreview: boolean;
  /** True when the sample is a stand-in voice, or a different speech model, or both. */
  approximate: boolean;
  /** User-facing explanation. Empty when the preview is the voice itself. */
  note: string;
}

export function previewEligibility(engine: VoiceEngineId, voiceId: string): VoicePreviewEligibility {
  const standIn = TTS_STAND_INS[voiceId];
  const direct = TTS_NATIVE_VOICES.has(voiceId);

  if (!direct && !standIn) {
    return {
      canPreview: false,
      approximate: false,
      note: 'Preview is unavailable for this voice -- the preview service has no matching voice, and playing a different one would be misleading.',
    };
  }

  // Live speaks through a different model than the preview endpoint, so even a
  // name the endpoint knows is only an approximation of the Live rendering.
  if (engine === 'live') {
    return {
      canPreview: true,
      approximate: true,
      note: standIn
        ? 'Preview uses a similar voice on a separate text-to-speech service. GPT-Live renders this voice differently.'
        : 'Preview uses a separate text-to-speech service. GPT-Live renders this voice differently.',
    };
  }

  return standIn
    ? { canPreview: true, approximate: true, note: 'This voice has no preview equivalent; the sample uses a similar voice.' }
    : { canPreview: true, approximate: false, note: '' };
}

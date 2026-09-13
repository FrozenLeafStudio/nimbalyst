// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { previewEligibility, resolveVoiceForEngine, voicesForEngine } from '../voiceEngineOptions';
import { realtimeModelForEngine, resolveVoiceEngine } from '../../../../main/services/voice/VoiceModeSettingsHandler';

describe('voice lists', () => {
  it('corrects a voice the target engine does not accept', () => {
    expect(resolveVoiceForEngine('live', 'marin')).toBe('marin');
    expect(resolveVoiceForEngine('live', 'not-a-voice')).toBe(voicesForEngine('live')[0].id);
    expect(resolveVoiceForEngine('realtime', undefined)).toBe(voicesForEngine('realtime')[0].id);
  });
});

describe('previewEligibility', () => {
  it('previews a voice the speech endpoint has, with no caveat', () => {
    expect(previewEligibility('realtime', 'alloy')).toEqual({ canPreview: true, approximate: false, note: '' });
  });

  it('labels a stand-in as a stand-in rather than previewing it silently', () => {
    const result = previewEligibility('realtime', 'cedar');
    expect(result.canPreview).toBe(true);
    expect(result.approximate).toBe(true);
    expect(result.note).not.toBe('');
  });

  it('marks a supported Live preview as approximate because it uses a different model', () => {
    expect(previewEligibility('live', 'marin')).toMatchObject({ canPreview: true, approximate: true });
  });

  it('refuses to preview a voice with no legitimate equivalent', () => {
    const result = previewEligibility('live', 'some-future-live-voice');
    expect(result.canPreview).toBe(false);
    expect(result.note).not.toBe('');
  });
});

describe('engine selection', () => {
  it('reports the fallback instead of silently downgrading', () => {
    expect(resolveVoiceEngine('live', true)).toEqual({ engine: 'live', reason: '' });
    const fallback = resolveVoiceEngine('live', false);
    expect(fallback.engine).toBe('realtime');
    expect(fallback.fallbackFrom).toBe('live');
    expect(fallback.reason).not.toBe('');
  });

  it('defaults to Live while preserving an explicit Realtime selection', () => {
    expect(resolveVoiceEngine('realtime', true).engine).toBe('realtime');
    expect(resolveVoiceEngine(undefined, true).engine).toBe('live');
    expect(resolveVoiceEngine('gpt-realtime-2', true).engine).toBe('live');
  });

  it('never hands a Realtime model string to the Live path', () => {
    expect(realtimeModelForEngine('realtime', 'gpt-realtime')).toBe('gpt-realtime');
    expect(realtimeModelForEngine('realtime', undefined)).toBe('gpt-realtime-2');
    expect(realtimeModelForEngine('live', 'gpt-realtime-2')).toBeUndefined();
  });
});

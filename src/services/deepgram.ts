import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import type { LiveClient } from '@deepgram/sdk';
import { config } from '../config';
import type { TranscriptTurn } from '../types';

const KEYWORDS = [
  'indexed universal life',
  'IUL',
  'cash value',
  'death benefit',
  'premium',
  'rider',
  'beneficiary',
  'policy',
  'tax-free',
  'accumulation',
  'cap rate',
  'floor',
];

const LIVE_CONFIG = {
  model: 'nova-3',
  language: 'es',
  multichannel: true,
  channels: 2,
  sample_rate: 16000,
  encoding: 'linear16' as const,
  smart_format: true,
  punctuate: true,
  interim_results: false,
  keyterm: KEYWORDS,
};

export interface DeepgramSession {
  send(data: Buffer | ArrayBuffer): void;
  finish(): void;
}

export function createDeepgramSession(
  onTurn: (turn: TranscriptTurn) => void,
  onError: (err: Error) => void
): DeepgramSession {
  const client = createClient(config.DEEPGRAM_API_KEY);
  const live: LiveClient = client.listen.live(LIVE_CONFIG);

  live.on(LiveTranscriptionEvents.Transcript, (data) => {
    // In multichannel mode each event is for one channel:
    // channel_index[0] = which channel, channel (singular) = content
    const d = data as { channel_index?: number[]; channel?: { alternatives?: { transcript?: string }[] } };
    const channelIdx = d.channel_index?.[0] ?? 0;
    const text = d.channel?.alternatives?.[0]?.transcript?.trim();
    if (!text) return;

    const turn: TranscriptTurn = {
      speaker: channelIdx === 0 ? 'agente' : 'cliente',
      text,
      timestamp: Date.now(),
      channel: channelIdx === 0 ? 0 : 1,
    };
    onTurn(turn);
  });

  live.on(LiveTranscriptionEvents.Error, (err) => {
    onError(err instanceof Error ? err : new Error(String(err)));
  });

  return {
    send(data: Buffer) {
      // Deepgram SDK expects ArrayBufferLike — pass the underlying ArrayBuffer
      live.send(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
    },
    finish() {
      live.finish();
    },
  };
}

import { createClient } from '@deepgram/sdk';
import OpenAI from 'openai';
import textToSpeechLib from '@google-cloud/text-to-speech';
import dotenv from 'dotenv';
dotenv.config();

// Clients
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ttsClient = new textToSpeechLib.TextToSpeechClient();

console.log(process.env.DEEPGRAM_API_KEY);

// TTS Cache
const ttsCache = new Map();

// Conversation State
export class ConversationState {
    constructor() {
        this.transcript = [];
    }

    addToTranscript(role, text) {
        this.transcript.push({ role, text, timestamp: new Date() });
    }
}

// Deepgram Connection
export function createDeepgramConnection() {
    return deepgram.listen.live({
        model: 'flux',
        language: 'de',
        punctuate: true,
        smart_format: true,
        interim_results: false,
        endpointing: 500,
        vad_events: true,
        utterance_end_ms: 500,
        encoding: 'mulaw',
        sample_rate: 8000,
    });
}

// GPT Response
export async function generateResponse(state, userText) {
    state.addToTranscript('user', userText);

    const messages = [
        {
            role: 'system',
            content: 'Du bist ein freundlicher Rezeptionist. Beantworte die Fragen auf Deutsch.'
        },
        ...state.transcript.map(t => ({
            role: t.role,
            content: t.text
        })),
    ];

    const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        max_tokens: 150,
        temperature: 0.7
    });

    const aiResponse = completion.choices[0].message.content;
    state.addToTranscript('assistant', aiResponse);
    return aiResponse;
}

// Text-to-Speech
export async function textToSpeech(text) {
    if (ttsCache.has(text)) return ttsCache.get(text);

    const request = {
        input: { text },
        voice: { languageCode: 'de-DE', name: 'de-DE-Neural2-F', ssmlGender: 'FEMALE' },
        audioConfig: { audioEncoding: 'MULAW', sampleRateHertz: 8000 }
    };

    const [response] = await ttsClient.synthesizeSpeech(request);
    const audioBuffer = response.audioContent;
    ttsCache.set(text, audioBuffer);
    return audioBuffer;
}

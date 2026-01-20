import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import fs from "fs";
import { createClient } from "@supabase/supabase-js";
import { createClient as createDeepgramClient, LiveTranscriptionEvents } from "@deepgram/sdk";
import OpenAI from "openai";
import textToSpeech from "@google-cloud/text-to-speech";

dotenv.config();

/* ───────────────────── CONFIG ───────────────────── */

const PORT = process.env.PORT || 5050;
const MAX_CAPACITY = 30;
const today = new Date().toISOString().split("T")[0];

// WICHTIG: Prompt verschärft, damit er nicht um Erlaubnis fragt
const SYSTEM_MESSAGE =
    fs.readFileSync("system_message.txt", "utf8") +
    `\nHeute ist der ${today}. 
    REGEL: Wenn der Kunde nach Verfügbarkeit fragt, rufe SOFORT 'check_availability' auf. Frage nicht "Soll ich nachsehen?", sondern mach es einfach.
    Antworte kurz und prägnant. Wenn Uhrzeiten ohne Doppelpunkt erkannt werden (z.B. "18 30"),
wandle sie IMMER in das Format HH:MM um (z.B. "18:30"),
bevor du sie ausgibst oder weiterverarbeitest.`;

/* ───────────────────── CLIENTS ───────────────────── */

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

const deepgram = createDeepgramClient(process.env.DEEPGRAM_API_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ttsClient = new textToSpeech.TextToSpeechClient();

/* ───────────────────── SERVER ───────────────────── */

const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const ttsCache = new Map();

/* ───────────────────── DB FUNCTIONS ───────────────────── */

async function checkAvailability(date, time, partySize) {
    console.log(`🔎 DB CHECK: ${date} ${time} (${partySize} Pers)`);
    const { data, error } = await supabase
        .from("reservations")
        .select("party_size")
        .eq("date", date)
        .eq("time", time)
        .eq("status", "confirmed");

    if (error) {
        console.error("❌ DB Error:", error);
        return { available: false, error: "Database error" };
    }

    const used = data.reduce((s, r) => s + r.party_size, 0);
    const isAvailable = MAX_CAPACITY - used >= partySize;

    console.log(`✅ RESULT: ${isAvailable ? "FREI" : "VOLL"} (Belegt: ${used}/${MAX_CAPACITY})`);

    return {
        available: isAvailable,
        remaining: MAX_CAPACITY - used
    };
}

async function createReservation(date, time, partySize, name) {
    console.log(`📝 RESERVIERUNG: ${name}, ${date}, ${time}`);
    const { data, error } = await supabase
        .from("reservations")
        .insert({
            date, time, party_size: partySize, customer_name: name, status: "confirmed"
        })
        .select();

    if (error) {
        console.error("❌ Reservation Error:", error);
        return { success: false, error: error.message };
    }
    return { success: true, id: data[0].id };
}

/* ───────────────────── GOOGLE TTS ───────────────────── */

async function generateTTS(text) {
    if (ttsCache.has(text)) return ttsCache.get(text);

    const request = {
        input: { text },
        voice: {
            languageCode: "de-DE",
            name: "de-DE-Chirp-HD-D",
            ssmlGender: "MALE"
        },
        audioConfig: {
            audioEncoding: "MULAW",
            sampleRateHertz: 8000
        }
    };

    const [response] = await ttsClient.synthesizeSpeech(request);
    const audio = response.audioContent;
    ttsCache.set(text, audio);
    return audio;
}

/* ───────────────────── TWILIO ROUTES ───────────────────── */

fastify.all("/incoming-call", async (req, reply) => {
    reply.type("text/xml").send(`
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/media-stream" />
  </Connect>
</Response>
  `);
});

/* ───────────────────── MEDIA STREAM ───────────────────── */

fastify.register(async (fastify) => {
    fastify.get("/media-stream", { websocket: true }, (connection) => {
        console.log("📞 Call connected");

        let streamSid = null;
        let callActive = false;
        let dg = null;
        let processing = false;

        let messages = [{ role: "system", content: SYSTEM_MESSAGE }];

        /* ─────────────── DEEPGRAM ─────────────── */
        function startDeepgram() {
            dg = deepgram.listen.live({
                model: "nova-2",
                language: "de",
                smart_format: true,
                interim_results: true,
                encoding: "mulaw",
                sample_rate: 8000,
                endpointing: 800,
                utterance_end_ms: 1000,
                vad_events: true
            });

            dg.on(LiveTranscriptionEvents.Open, () => console.log("✅ Deepgram listening"));

            dg.on(LiveTranscriptionEvents.Transcript, async (data) => {
                const text = data?.channel?.alternatives?.[0]?.transcript;
                const isFinal = data?.is_final;

                if (text && isFinal && text.trim().length > 0) {
                    console.log("🎤 User:", text);
                    if (!processing) {
                        processing = true;
                        // User Nachricht hinzufügen
                        messages.push({ role: "user", content: text });
                        // Rekursiven Prozess starten
                        await processAgentTurn();
                        processing = false;
                    }
                }
            });

            dg.on(LiveTranscriptionEvents.Close, () => console.log("🔌 Deepgram closed"));
            dg.on(LiveTranscriptionEvents.Error, (e) => console.error("DG Error:", e));
        }

        /* ─────────────── REKURSIVE LLM LOGIK ─────────────── */

        async function processAgentTurn() {
            try {
                // OpenAI Anfrage
                const res = await openai.chat.completions.create({
                    model: "gpt-4o-mini",
                    messages,
                    tools: [
                        {
                            type: "function",
                            function: {
                                name: "check_availability",
                                description: "Prüft ob ein Tisch frei ist.",
                                parameters: {
                                    type: "object",
                                    properties: {
                                        date: { type: "string", description: "Format YYYY-MM-DD" },
                                        time: { type: "string", description: "Format HH:MM" },
                                        party_size: { type: "number" }
                                    },
                                    required: ["date", "time", "party_size"]
                                }
                            }
                        },
                        {
                            type: "function",
                            function: {
                                name: "create_reservation",
                                description: "Legt eine Reservierung an.",
                                parameters: {
                                    type: "object",
                                    properties: {
                                        date: { type: "string" },
                                        time: { type: "string" },
                                        party_size: { type: "number" },
                                        name: { type: "string" }
                                    },
                                    required: ["date", "time", "party_size", "name"]
                                }
                            }
                        }
                    ],
                    tool_choice: "auto" // KI entscheidet selbst
                });

                const msg = res.choices[0].message;
                messages.push(msg); // Antwort immer speichern

                // 1. GIBT ES TEXT? -> SPRECHEN
                // Das passiert oft VOR dem Tool call ("Ich schaue kurz nach...")
                if (msg.content) {
                    console.log("🤖 AI:", msg.content);
                    await speak(msg.content);
                }

                // 2. GIBT ES TOOL CALLS? -> AUSFÜHREN & REKURSION
                if (msg.tool_calls) {
                    console.log("🛠️ Tool Call detected:", msg.tool_calls.length);

                    for (const tool of msg.tool_calls) {
                        const args = JSON.parse(tool.function.arguments);
                        let result;

                        if (tool.function.name === "check_availability") {
                            result = await checkAvailability(args.date, args.time, args.party_size);
                        } else if (tool.function.name === "create_reservation") {
                            result = await createReservation(args.date, args.time, args.party_size, args.name);
                        }

                        // Ergebnis in History speichern
                        messages.push({
                            role: "tool",
                            tool_call_id: tool.id,
                            content: JSON.stringify(result)
                        });
                    }

                    // WICHTIG: Rekursiver Aufruf!
                    // Wir rufen OpenAI sofort wieder auf, damit es das Tool-Ergebnis verarbeitet
                    // und dem User die Antwort ("Ja ist frei") gibt.
                    await processAgentTurn();
                }

            } catch (err) {
                console.error("❌ LLM Error:", err);
                await speak("Es gab leider einen Fehler. Bitte nochmal.");
            }
        }

        /* ─────────────── SEND AUDIO ─────────────── */

        async function speak(text) {
            if (!callActive || !streamSid) return;
            try {
                const audio = await generateTTS(text);
                const payload = audio.toString("base64");

                connection.send(JSON.stringify({
                    event: "media",
                    streamSid,
                    media: { payload }
                }));
            } catch (e) {
                console.error("TTS Error:", e);
            }
        }

        /* ─────────────── WEBSOCKET HANDLING ─────────────── */

        connection.on("message", (msg) => {
            const data = JSON.parse(msg);

            if (data.event === "start") {
                streamSid = data.start.streamSid;
                callActive = true;
                console.log("🚀 Stream start:", streamSid);
                startDeepgram();
                setTimeout(() => speak("Restaurant Lindenhof, guten Tag. Wie kann ich helfen?"), 500);
            }

            if (data.event === "media" && dg && dg.getReadyState() === 1) {
                const payload = data.media.payload;
                if (payload) dg.send(Buffer.from(payload, "base64"));
            }

            if (data.event === "stop") {
                console.log("📞 Call ended");
                callActive = false;
                dg?.finish();
            }
        });

        connection.on("close", () => {
            console.log("🔌 Connection closed");
            dg?.finish();
        });
    });
});

fastify.listen({ port: PORT, host: "0.0.0.0" }, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
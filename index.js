import Fastify from "fastify";
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
const SYSTEM_MESSAGE_TEMPLATE = fs.readFileSync("system_message.txt", "utf8");

/* ───────────────────── CLIENTS ───────────────────── */

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const deepgram = createDeepgramClient(process.env.DEEPGRAM_API_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ttsClient = new textToSpeech.TextToSpeechClient();

/* ───────────────────── SERVER ───────────────────── */

const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const ttsCache = new Map();
const practiceCache = new Map();

const WEEKDAY_MAP = {
    sonntag: 0,
    montag: 1,
    dienstag: 2,
    mittwoch: 3,
    donnerstag: 4,
    freitag: 5,
    samstag: 6
};

function formatTime(value) {
    if (!value) return "";
    if (typeof value === "string") return value.slice(0, 5);
    return String(value).slice(0, 5);
}

function formatDate(date) {
    return date.toLocaleDateString("sv-SE");
}

function parseIsoDate(dateStr) {
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
    const [year, month, day] = dateStr.split("-").map(Number);
    return new Date(year, month - 1, day);
}

function getWeekdayFromText(text) {
    if (!text) return null;
    const lower = text.toLowerCase();
    const match = lower.match(/\b(sonntag|montag|dienstag|mittwoch|donnerstag|freitag|samstag)\b/);
    if (!match) return null;
    return WEEKDAY_MAP[match[1]];
}

function getNextWeekdayDate(targetWeekday, referenceDate, allowToday = false) {
    const date = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());
    const currentWeekday = date.getDay();
    let delta = (targetWeekday - currentWeekday + 7) % 7;
    if (delta === 0 && !allowToday) {
        delta = 7;
    }
    date.setDate(date.getDate() + delta);
    return date;
}

function resolveWeekdayDate(dateStr, userText) {
    const targetWeekday = getWeekdayFromText(userText);
    if (targetWeekday === null) return dateStr;
    const parsedDate = parseIsoDate(dateStr);
    if (!parsedDate) return dateStr;
    const today = new Date();
    const todayDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const parsedDateOnly = new Date(parsedDate.getFullYear(), parsedDate.getMonth(), parsedDate.getDate());
    if (parsedDate.getDay() === targetWeekday) {
        if (parsedDateOnly.getTime() === todayDate.getTime()) {
            const next = getNextWeekdayDate(targetWeekday, todayDate, false);
            return formatDate(next);
        }
        return dateStr;
    }
    const next = getNextWeekdayDate(targetWeekday, parsedDateOnly, false);
    return formatDate(next);
}

function isPastDate(dateStr) {
    const parsedDate = parseIsoDate(dateStr);
    if (!parsedDate) return false;
    const today = new Date();
    const todayDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    return parsedDate < todayDate;
}

function buildSystemMessage(practiceSettings) {
    const today = new Date().toISOString().split("T")[0];
    const openingTime = formatTime(practiceSettings.opening_time);
    const closingTime = formatTime(practiceSettings.closing_time);
    return (
        SYSTEM_MESSAGE_TEMPLATE
            .replaceAll("{{restaurant_name}}", practiceSettings.name)
            .replaceAll("{{opening_time}}", openingTime)
            .replaceAll("{{closing_time}}", closingTime) +
        `\nHeute ist der ${today}. 
    REGEL: Wenn der Kunde nach Verfügbarkeit fragt, rufe SOFORT 'check_availability' auf. Frage nicht "Soll ich nachsehen?", sondern mach es einfach.
    Antworte kurz und prägnant. Wenn Uhrzeiten ohne Doppelpunkt erkannt werden (z.B. "18 30"),
wandle sie IMMER in das Format HH:MM um (z.B. "18:30"),
bevor du sie ausgibst oder weiterverarbeitest.`
    );
}

async function getPracticeSettings(practiceId) {
    if (!practiceId) {
        return { settings: null, error: "Missing practice_id" };
    }

    if (practiceCache.has(practiceId)) {
        return { settings: practiceCache.get(practiceId), error: null };
    }

    const { data, error } = await supabase
        .from("practices")
        .select("id, name, max_capacity, opening_time, closing_time")
        .eq("id", practiceId)
        .maybeSingle();

    if (error) {
        console.error("❌ Practice Settings Error:", error);
        return { settings: null, error: error.message };
    }

    if (!data) {
        return { settings: null, error: "Practice not found" };
    }

    practiceCache.set(practiceId, data);
    return { settings: data, error: null };
}

/* ───────────────────── DB FUNCTIONS ───────────────────── */

async function checkAvailability(date, time, partySize, maxCapacity, practiceId) {
    console.log(`🔎 DB CHECK: ${date} ${time} (${partySize} Pers)`);
    if (isPastDate(date)) {
        console.warn(`⚠️ Past date rejected: ${date}`);
        return { available: false, error: "Past date" };
    }
    const { data, error } = await supabase
        .from("reservations")
        .select("party_size")
        .eq("date", date)
        .eq("time", time)
        .eq("status", "confirmed")
        .eq("practice_id", practiceId);

    if (error) {
        console.error("❌ DB Error:", error);
        return { available: false, error: "Database error" };
    }

    const used = data.reduce((s, r) => s + r.party_size, 0);
    const isAvailable = maxCapacity - used >= partySize;

    console.log(`✅ RESULT: ${isAvailable ? "FREI" : "VOLL"} (Belegt: ${used}/${maxCapacity})`);

    return {
        available: isAvailable,
        remaining: maxCapacity - used
    };
}

async function createReservation(date, time, partySize, name, practiceId) {
    console.log(`📝 RESERVIERUNG: ${name}, ${date}, ${time}`);
    if (isPastDate(date)) {
        console.warn(`⚠️ Past date rejected: ${date}`);
        return { success: false, error: "Past date" };
    }
    const { data, error } = await supabase
        .from("reservations")
        .insert({
            date,
            time,
            party_size: partySize,
            customer_name: name,
            status: "confirmed",
            practice_id: practiceId
        })
        .select();

    if (error) {
        console.error("❌ Reservation Error:", error);
        return { success: false, error: error.message };
    }
    return { success: true, id: data[0].id };
}

async function createCallLog(practiceId, streamSid) {
    if (!practiceId) return { success: false };
    try {
        const { data, error } = await supabase
            .from("call_logs")
            .insert({
                practice_id: practiceId,
                stream_sid: streamSid,
                status: "started",
                started_at: new Date().toISOString()
            })
            .select()
            .maybeSingle();

        if (error) {
            console.warn("⚠️ Call Log Insert Error:", error.message);
            return { success: false };
        }

        return { success: true, id: data?.id };
    } catch (err) {
        console.warn("⚠️ Call Log Insert Exception:", err);
        return { success: false };
    }
}

async function finalizeCallLog(callLogId, durationSeconds) {
    if (!callLogId) return;
    try {
        const { error } = await supabase
            .from("call_logs")
            .update({
                status: "ended",
                ended_at: new Date().toISOString(),
                duration_seconds: durationSeconds
            })
            .eq("id", callLogId);

        if (error) {
            console.warn("⚠️ Call Log Update Error:", error.message);
        }
    } catch (err) {
        console.warn("⚠️ Call Log Update Exception:", err);
    }
}

async function createTranscriptEntry(callLogId, role, content) {
    if (!callLogId || !content) return;
    try {
        const { error } = await supabase
            .from("call_transcripts")
            .insert({
                call_log_id: callLogId,
                role,
                content,
                created_at: new Date().toISOString()
            });

        if (error) {
            console.warn("⚠️ Transcript Insert Error:", error.message);
        }
    } catch (err) {
        console.warn("⚠️ Transcript Insert Exception:", err);
    }
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
    const { practice_id: practiceId } = req.query || {};

    if (!practiceId) {
        reply.type("text/xml").send(`
<Response>
  <Say>Es gab ein Konfigurationsproblem. Bitte versuchen Sie es später erneut.</Say>
  <Hangup/>
</Response>
        `);
        return;
    }

    const { settings, error } = await getPracticeSettings(practiceId);
    if (error || !settings) {
        reply.type("text/xml").send(`
<Response>
  <Say>Diese Praxis ist nicht verfügbar. Bitte versuchen Sie es später erneut.</Say>
  <Hangup/>
</Response>
        `);
        return;
    }

    reply.type("text/xml").send(`
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/media-stream">
      <Parameter name="practice_id" value="${encodeURIComponent(practiceId)}" />
    </Stream>
  </Connect>
</Response>
  `);
    console.log(`📞 Incoming call for practice ${practiceId}`);
});

/* ───────────────────── MEDIA STREAM ───────────────────── */

fastify.register(async (fastify) => {
    fastify.get("/media-stream", { websocket: true }, (connection, req) => {
        console.log("📞 Call connected");

        let streamSid = null;
        let callActive = false;
        let dg = null;
        let processing = false;
        let callLogId = null;
        let callStartedAt = null;
        let lastAvailabilityCheckIndex = 0;

        let practiceId = req.query?.practice_id;
        let practiceSettings = null;
        let messages = [];

        async function ensurePracticeSettings() {
            if (practiceSettings) return { ok: true };
            const { settings, error } = await getPracticeSettings(practiceId);
            if (error || !settings) {
                console.error("❌ Practice Settings Missing:", error || "Not found");
                return { ok: false };
            }
            practiceSettings = settings;
            messages = [{ role: "system", content: buildSystemMessage(practiceSettings) }];
            return { ok: true };
        }

        /* ─────────────── DEEPGRAM ─────────────── */
        function startDeepgram() {
            dg = deepgram.listen.live({
                model: "nova-2",
                language: "de",
                smart_format: true,
                interim_results: true,
                encoding: "mulaw",
                sample_rate: 8000,
                endpointing: 1000,
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
                        await createTranscriptEntry(callLogId, "user", text);
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

        function shouldForceAvailabilityCall(text) {
            if (!text) return false;
            const lower = text.toLowerCase();
            const hasCheckVerb = /überprüf|pr(ü|ue)f|nachseh|schau|check/.test(lower);
            const hasAvailabilitySignal = /verf(ü|ue)gbar|frei|tisch/.test(lower);
            return hasCheckVerb && hasAvailabilitySignal;
        }

        function hasAvailabilityInputs(history, sinceIndex = 0) {
            const userTexts = history
                .slice(sinceIndex)
                .filter((message) => message.role === "user")
                .map((message) => message.content || "");
            const combined = userTexts.join(" ");

            const hasDate = /\b(heute|morgen|übermorgen)\b/i.test(combined) ||
                /\b\d{1,2}\.\s?\d{1,2}\.\b/.test(combined) ||
                /\b\d{4}-\d{2}-\d{2}\b/.test(combined);
            const hasTime = /\b\d{1,2}[:.]\d{2}\b/.test(combined) ||
                /\b\d{1,2}\s?\d{2}\b/.test(combined) ||
                /\b\d{1,2}\s?uhr\b/i.test(combined);
            const hasPartySize = /\bfür\s?\d+\b/i.test(combined) ||
                /\b\d+\s?(personen|leute|gäste)\b/i.test(combined);

            return hasDate && hasTime && hasPartySize;
        }

        async function handleToolCalls(toolCalls) {
            console.log("🛠️ Tool Call detected:", toolCalls.length);
            const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");

            for (const tool of toolCalls) {
                const args = JSON.parse(tool.function.arguments);
                let result;

                if (tool.function.name === "check_availability") {
                    const resolvedDate = resolveWeekdayDate(args.date, lastUserMessage?.content || "");
                    result = await checkAvailability(
                        resolvedDate,
                        args.time,
                        args.party_size,
                        practiceSettings.max_capacity,
                        practiceSettings.id
                    );
                } else if (tool.function.name === "create_reservation") {
                    const resolvedDate = resolveWeekdayDate(args.date, lastUserMessage?.content || "");
                    result = await createReservation(
                        resolvedDate,
                        args.time,
                        args.party_size,
                        args.name,
                        practiceSettings.id
                    );
                }

                // Ergebnis in History speichern
                messages.push({
                    role: "tool",
                    tool_call_id: tool.id,
                    content: JSON.stringify(result)
                });

                if (tool.function.name === "check_availability") {
                    lastAvailabilityCheckIndex = messages.length;
                }
            }
        }

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
                    await createTranscriptEntry(callLogId, "assistant", msg.content);
                }

                // 2. GIBT ES TOOL CALLS? -> AUSFÜHREN & REKURSION
                if (msg.tool_calls) {
                    await handleToolCalls(msg.tool_calls);

                    // WICHTIG: Rekursiver Aufruf!
                    // Wir rufen OpenAI sofort wieder auf, damit es das Tool-Ergebnis verarbeitet
                    // und dem User die Antwort ("Ja ist frei") gibt.
                    await processAgentTurn();
                    return;
                }

                if (!msg.tool_calls && (shouldForceAvailabilityCall(msg.content) || hasAvailabilityInputs(messages, lastAvailabilityCheckIndex))) {
                    const forcedRes = await openai.chat.completions.create({
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
                            }
                        ],
                        tool_choice: { type: "function", function: { name: "check_availability" } }
                    });

                    const forcedMsg = forcedRes.choices[0].message;
                    messages.push(forcedMsg);

                    if (forcedMsg.tool_calls) {
                        await handleToolCalls(forcedMsg.tool_calls);
                        await processAgentTurn();
                    }
                    return;
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

        connection.on("message", async (msg) => {
            const data = JSON.parse(msg);

            if (data.event === "start") {
                streamSid = data.start.streamSid;
                callActive = true;
                console.log("🚀 Stream start:", streamSid);
                practiceId = data.start?.customParameters?.practice_id || practiceId;
                const init = await ensurePracticeSettings();
                if (!init.ok) {
                    await speak("Es gab ein Konfigurationsproblem. Bitte versuchen Sie es später erneut.");
                    connection.close();
                    return;
                }
                startDeepgram();
                const greeting = `${practiceSettings.name}, guten Tag. Wie kann ich helfen?`;
                messages.push({ role: "assistant", content: greeting });
                setTimeout(() => speak(greeting), 500);
                callStartedAt = Date.now();
                const callLog = await createCallLog(practiceId, streamSid);
                callLogId = callLog.id || null;
                await createTranscriptEntry(callLogId, "assistant", greeting);
            }

            if (data.event === "media" && dg && dg.getReadyState() === 1) {
                const payload = data.media.payload;
                if (payload) dg.send(Buffer.from(payload, "base64"));
            }

            if (data.event === "stop") {
                console.log("📞 Call ended");
                callActive = false;
                dg?.finish();
                if (callStartedAt) {
                    const durationSeconds = Math.max(0, Math.round((Date.now() - callStartedAt) / 1000));
                    await finalizeCallLog(callLogId, durationSeconds);
                }
            }
        });

        connection.on("close", () => {
            console.log("🔌 Connection closed");
            dg?.finish();
            if (callStartedAt) {
                const durationSeconds = Math.max(0, Math.round((Date.now() - callStartedAt) / 1000));
                finalizeCallLog(callLogId, durationSeconds);
            }
        });
    });
});

fastify.listen({ port: PORT, host: "0.0.0.0" }, () => {
    console.log(`✅ Server running on port ${PORT}`);
});

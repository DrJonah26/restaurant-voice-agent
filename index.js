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

if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
    const ttsKeyPath = "/tmp/google-tts-key.json";
    try {
        fs.writeFileSync(ttsKeyPath, process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON, "utf8");
        process.env.GOOGLE_APPLICATION_CREDENTIALS = ttsKeyPath;
    } catch (err) {
        console.error("Failed to write Google TTS credentials file:", err);
    }
}

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
const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;

/* ───────────────────── SERVER ───────────────────── */

const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const ttsCache = new Map();
const practiceCache = new Map();

const RESERVATION_DURATION_MINUTES = 60;

const ACCESS_DENIED_MESSAGES = {
    expired: "Dieses Restaurant ist derzeit nicht verfügbar. Bitte versuchen Sie es später erneut.",
    limit_exceeded: "Das monatliche Anruflimit wurde erreicht. Bitte versuchen Sie es später erneut.",
    default: "Dieses Restaurant ist derzeit nicht verfügbar. Bitte versuchen Sie es später erneut."
};

const HANDOFF_THRESHOLDS = {
    misunderstandings: 3,
    corrections: 3,
    noProgressTurns: 3,
    outOfHoursRepeats: 2,
    toolErrors: 1
};

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

function parseTimeToMinutes(value) {
    if (value === null || value === undefined) return null;
    const raw = String(value).trim().toLowerCase();
    if (!raw) return null;
    const trimmed = raw.replace(/\s*uhr$/, "");
    const normalized = trimmed.replace(/\./g, ":").replace(/\s+/g, ":");
    const hmsMatch = normalized.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if (hmsMatch) {
        const hours = Number(hmsMatch[1]);
        const minutes = Number(hmsMatch[2]);
        if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
        if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
        return hours * 60 + minutes;
    }
    const compactMatch = normalized.match(/^(\d{1,2})(\d{2})$/);
    if (compactMatch) {
        const hours = Number(compactMatch[1]);
        const minutes = Number(compactMatch[2]);
        if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
        if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
        return hours * 60 + minutes;
    }
    const hourOnlyMatch = normalized.match(/^(\d{1,2})$/);
    if (hourOnlyMatch) {
        const hours = Number(hourOnlyMatch[1]);
        if (Number.isNaN(hours) || hours < 0 || hours > 23) return null;
        return hours * 60;
    }
    return null;
}

function computePeakOccupancy(reservations, requestedStart, partySize) {
    const requestedEnd = requestedStart + RESERVATION_DURATION_MINUTES;
    const events = [];

    const addOverlapInterval = (start, end, size) => {
        const overlapStart = Math.max(start, requestedStart);
        const overlapEnd = Math.min(end, requestedEnd);
        if (overlapStart >= overlapEnd) return;
        events.push({ time: overlapStart, delta: size });
        events.push({ time: overlapEnd, delta: -size });
    };

    for (const reservation of reservations || []) {
        const resStart = parseTimeToMinutes(reservation.time);
        if (resStart === null) continue;
        const resSize = Number(reservation.party_size) || 0;
        if (resSize <= 0) continue;
        const resEnd = resStart + RESERVATION_DURATION_MINUTES;
        addOverlapInterval(resStart, resEnd, resSize);
    }

    const newSize = Number(partySize) || 0;
    if (newSize > 0) {
        addOverlapInterval(requestedStart, requestedEnd, newSize);
    }

    if (events.length === 0) return 0;

    events.sort((a, b) => {
        if (a.time !== b.time) return a.time - b.time;
        return a.delta - b.delta;
    });

    let current = 0;
    let peak = 0;
    for (const event of events) {
        current += event.delta;
        if (current > peak) peak = current;
    }
    return peak;
}

function parseIsoDate(dateStr) {
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
    const [year, month, day] = dateStr.split("-").map(Number);
    return new Date(year, month - 1, day);
}

function getUtcMonthRange(date = new Date()) {
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    const start = new Date(Date.UTC(year, month, 1, 0, 0, 0));
    const end = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0));
    return { startIso: start.toISOString(), endIso: end.toISOString() };
}

function decodeCustomParam(value) {
    if (!value || typeof value !== "string") return null;
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function normalizeText(text) {
    return (text || "").toLowerCase();
}

function extractPartySizeFromText(text) {
    if (!text) return null;
    const sizeMatch = text.match(/\b(\d{1,2})\s*(personen|leute|g(?:a|\u00e4)ste|gaeste|pax)\b/i);
    if (sizeMatch) return Number(sizeMatch[1]);
    const fuerMatch = text.match(/\bf(ue|u)r\s*(\d{1,2})\b/i);
    if (fuerMatch) return Number(fuerMatch[2]);
    const sindMatch = text.match(/\bwir\s+sind\s+(\d{1,2})\b/i);
    if (sindMatch) return Number(sindMatch[1]);
    return null;
}

function isExplicitHandoffRequest(text) {
    if (!text) return false;
    return /(mitarbeiter|menschen|jemand(en)? sprechen|durchstell|weiterleit|verbinde|berater|chef)/i.test(text);
}

function isSpecialCaseRequest(text) {
    if (!text) return false;
    return /(storn|aend|aender|allerg|sonderwunsch|speisekarte|preise?|wegbeschreibung|anfahrt|adresse)/i.test(text);
}

function isCorrection(text) {
    if (!text) return false;
    return /\b(nein|falsch|korrigier|ich meinte|doch|anders|stimmt nicht|sorry|moment)\b/i.test(text);
}

function getConversationSignals(history, sinceIndex = 0) {
    const userTexts = history
        .slice(sinceIndex)
        .filter((message) => message.role === "user")
        .map((message) => message.content || "");
    const combined = userTexts.join(" ");

    const hasDate = /\b(heute|morgen|\u00fcbermorgen|uebermorgen)\b/i.test(combined) ||
        /\b\d{1,2}\.\s?\d{1,2}\.\b/.test(combined) ||
        /\b\d{4}-\d{2}-\d{2}\b/.test(combined);
    const hasTime = /\b\d{1,2}[:.]\d{2}\b/.test(combined) ||
        /\b\d{1,2}\s?\d{2}\b/.test(combined) ||
        /\b\d{1,2}\s?uhr\b/i.test(combined);
    const hasPartySize = /\bf(ue|u)r\s?\d+\b/i.test(combined) ||
        /\b\d+\s?(personen|leute|g(?:a|\u00e4)ste|gaeste)\b/i.test(combined) ||
        /\bwir\s+sind\s+\d+\b/i.test(combined);
    const hasName = /\b(ich hei(?:ss|ß)e|mein name ist|name ist|auf den namen|ich bin)\b/i.test(combined);

    return { hasDate, hasTime, hasPartySize, hasName };
}

function countMissingRequired(signals) {
    const missing = [
        !signals.hasDate,
        !signals.hasTime,
        !signals.hasPartySize,
        !signals.hasName
    ];
    return missing.filter(Boolean).length;
}

function buildHandoffTwiml(phoneNumber) {
    const safeNumber = String(phoneNumber || "").trim();
    return `<Response><Dial>${safeNumber}</Dial></Response>`;
}

function buildAccessDeniedTwiml(message) {
    const safeMessage = message || ACCESS_DENIED_MESSAGES.default;
    return `<Response><Say language="de-DE">${safeMessage}</Say><Hangup/></Response>`;
}

async function transferCallToNumber(callSid, phoneNumber) {
    if (!twilioAccountSid || !twilioAuthToken) {
        return { ok: false, error: "Missing Twilio credentials" };
    }
    if (!callSid || !phoneNumber) {
        return { ok: false, error: "Missing callSid or phone number" };
    }
    const twiml = buildHandoffTwiml(phoneNumber);
    const body = new URLSearchParams({ Twiml: twiml });
    const auth = Buffer.from(`${twilioAccountSid}:${twilioAuthToken}`).toString("base64");
    const response = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/Calls/${callSid}.json`,
        {
            method: "POST",
            headers: {
                Authorization: `Basic ${auth}`,
                "Content-Type": "application/x-www-form-urlencoded"
            },
            body
        }
    );

    if (!response.ok) {
        const details = await response.text();
        return { ok: false, error: details || `HTTP ${response.status}` };
    }
    return { ok: true };
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
    const today = new Date();
    const todayStr = today.toISOString().split("T")[0];
    const weekdayName = today.toLocaleDateString("de-DE", { weekday: "long" });
    const next7Days = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(today);
        d.setDate(d.getDate() + i + 1);
        return `${d.toLocaleDateString("de-DE", { weekday: "long" })}: ${d.toISOString().split("T")[0]}`;
    }).join("\n");
    const openingTime = formatTime(practiceSettings.opening_time);
    const closingTime = formatTime(practiceSettings.closing_time);
    return (
        SYSTEM_MESSAGE_TEMPLATE
            .replaceAll("{{restaurant_name}}", practiceSettings.name)
            .replaceAll("{{opening_time}}", openingTime)
            .replaceAll("{{closing_time}}", closingTime) +
        `\nHEUTIGES DATUM: ${todayStr} (${weekdayName})

WICHTIG - WOCHENTAGE RICHTIG INTERPRETIEREN:
Wenn der Kunde einen Wochentag nennt, nutze diese Zuordnung:
${next7Days}

Beispiel: Sagt jemand "Donnerstag", verwende den kommenden Donnerstag aus der Liste (nicht heute, falls heute Donnerstag ist).

REGEL: Wenn der Kunde nach Verfügbarkeit fragt, rufe SOFORT 'check_availability' auf. Frage nicht "Soll ich nachsehen?", sondern mach es einfach.
Antworte kurz und prägnant. Wenn Uhrzeiten ohne Doppelpunkt erkannt werden (z.B. "18 30"),
wandle sie IMMER in das Format HH:MM um (z.B. "18:30"),
bevor du sie ausgibst oder weiterverarbeitest.`
    );
}

async function getPracticeSettings(practiceId, { bypassCache = false } = {}) {
    if (!practiceId) {
        return { settings: null, error: "Missing practice_id" };
    }

    if (!bypassCache && practiceCache.has(practiceId)) {
        return { settings: practiceCache.get(practiceId), error: null };
    }

    const { data, error } = await supabase
        .from("practices")
        .select("id, name, max_capacity, opening_time, closing_time, phone_number, subscription_status, calls_limit")
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

async function getMonthlyCallCount(practiceId, now = new Date()) {
    if (!practiceId) return { count: null, error: "Missing practice_id" };
    const { startIso, endIso } = getUtcMonthRange(now);
    const { count, error } = await supabase
        .from("call_logs")
        .select("id", { count: "exact", head: true })
        .eq("practice_id", practiceId)
        .gte("started_at", startIso)
        .lt("started_at", endIso);

    if (error) {
        console.warn("Call count error:", error.message);
        return { count: null, error: error.message };
    }

    return { count: count ?? 0, error: null };
}

function isSubscriptionExpired(status) {
    return String(status || "").trim().toLowerCase() === "expired";
}

async function checkPracticeAccess(practiceId) {
    const { settings, error } = await getPracticeSettings(practiceId, { bypassCache: true });
    if (error || !settings) {
        return { allowed: false, reason: "not_found", message: ACCESS_DENIED_MESSAGES.default, settings: null };
    }

    if (isSubscriptionExpired(settings.subscription_status)) {
        return { allowed: false, reason: "expired", message: ACCESS_DENIED_MESSAGES.expired, settings };
    }

    const callsLimit = Number(settings.calls_limit);
    if (Number.isFinite(callsLimit) && callsLimit > 0) {
        const { count, error: countError } = await getMonthlyCallCount(practiceId);
        if (countError) {
            return { allowed: false, reason: "limit_check_failed", message: ACCESS_DENIED_MESSAGES.default, settings };
        }
        if ((count ?? 0) >= callsLimit) {
            return {
                allowed: false,
                reason: "limit_exceeded",
                message: ACCESS_DENIED_MESSAGES.limit_exceeded,
                settings,
                callsCount: count ?? 0,
                callsLimit
            };
        }
    }

    return { allowed: true, settings };
}

/* ───────────────────── DB FUNCTIONS ───────────────────── */

async function checkAvailability(date, time, partySize, maxCapacity, practiceId) {
    console.log(`🔎 DB CHECK: ${date} ${time} (${partySize} Pers)`);
    if (isPastDate(date)) {
        console.warn(`⚠️ Past date rejected: ${date}`);
        return { available: false, error: "Past date" };
    }
    const requestedStart = parseTimeToMinutes(time);
    if (requestedStart === null) {
        console.warn(`Invalid time rejected: ${time}`);
        return { available: false, error: "Invalid time" };
    }
    const { data, error } = await supabase
        .from("reservations")
        .select("party_size, time")
        .eq("date", date)
        .eq("status", "confirmed")
        .eq("practice_id", practiceId);

    if (error) {
        console.error("❌ DB Error:", error);
        return { available: false, error: "Database error" };
    }

    const peakOccupancy = computePeakOccupancy(data, requestedStart, partySize);
    const used = peakOccupancy;
    const isAvailable = used <= maxCapacity;

    console.log(`✅ RESULT: ${isAvailable ? "FREI" : "VOLL"} (Belegt: ${used}/${maxCapacity})`);

    return {
        available: isAvailable,
        remaining: maxCapacity - used
    };
}

async function createReservation(date, time, partySize, name, practiceId, phoneNumber) {
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
            phone_number: phoneNumber || null,
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
    const callerPhone = typeof req.body?.From === "string"
        ? req.body.From
        : (typeof req.query?.From === "string" ? req.query.From : null);
    const callerPhoneParam = callerPhone ? encodeURIComponent(callerPhone) : "";

    if (!practiceId) {
        reply.type("text/xml").send(
            buildAccessDeniedTwiml("Es gab ein Konfigurationsproblem. Bitte versuchen Sie es spaeter erneut.")
        );
        return;
    }

    const access = await checkPracticeAccess(practiceId);
    if (!access.allowed) {
        const forwardNumber = access.settings?.phone_number;
        if (forwardNumber) {
            reply.type("text/xml").send(buildHandoffTwiml(forwardNumber));
        } else {
            reply.type("text/xml").send(buildAccessDeniedTwiml(access.message));
        }
        return;
    }

    reply.type("text/xml").send(`
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/media-stream">
      <Parameter name="practice_id" value="${encodeURIComponent(practiceId)}" />
      <Parameter name="caller_phone" value="${callerPhoneParam}" />
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
        let callerPhone = null;
        let callSid = null;

        const handoffState = {
            inProgress: false,
            misunderstandings: 0,
            corrections: 0,
            noProgressTurns: 0,
            outOfHoursRepeats: 0,
            toolErrors: 0,
            userTurns: 0,
            lastSignals: null
        };

        const HANDOFF_MESSAGE = "Ich verbinde Sie jetzt mit einem Mitarbeiter.";

        let practiceId = req.query?.practice_id;
        let practiceSettings = null;
        let messages = [];

        function updateProgressCounters() {
            const signals = getConversationSignals(messages);
            const missingCount = countMissingRequired(signals);
            const lastSignals = handoffState.lastSignals;
            const gainedInfo = lastSignals
                ? (signals.hasDate && !lastSignals.hasDate) ||
                  (signals.hasTime && !lastSignals.hasTime) ||
                  (signals.hasPartySize && !lastSignals.hasPartySize) ||
                  (signals.hasName && !lastSignals.hasName)
                : false;

            if (gainedInfo || missingCount < 2) {
                handoffState.noProgressTurns = 0;
            } else if (handoffState.userTurns >= 3) {
                handoffState.noProgressTurns += 1;
            }

            handoffState.lastSignals = signals;
        }

        function evaluateHandoffForUserText(text) {
            if (!text) return null;
            if (isExplicitHandoffRequest(text)) return "user_request";
            if (isSpecialCaseRequest(text)) return "special_case";

            const partySize = extractPartySizeFromText(text);
            if (partySize && partySize > 10) return "party_size_over_limit";

            if (isCorrection(text)) {
                handoffState.corrections += 1;
            }

            updateProgressCounters();

            if (handoffState.corrections >= HANDOFF_THRESHOLDS.corrections) return "repeated_corrections";
            if (handoffState.noProgressTurns >= HANDOFF_THRESHOLDS.noProgressTurns) return "no_progress";

            return null;
        }

        function evaluateHandoffForAssistantText(text) {
            if (!text) return null;
            const lower = normalizeText(text);
            if (lower.includes("nicht verstanden")) {
                handoffState.misunderstandings += 1;
            }
            if (lower.includes("wir haben von")) {
                handoffState.outOfHoursRepeats += 1;
            }

            if (handoffState.misunderstandings >= HANDOFF_THRESHOLDS.misunderstandings) return "misunderstandings";
            if (handoffState.outOfHoursRepeats >= HANDOFF_THRESHOLDS.outOfHoursRepeats) return "out_of_hours";

            return null;
        }

        async function initiateHandoff(reason) {
            if (handoffState.inProgress || !callActive) return;
            handoffState.inProgress = true;
            console.log("ÐY\"z Handoff triggered:", reason);

            const handoffText = HANDOFF_MESSAGE;
            messages.push({ role: "assistant", content: handoffText });
            await speak(handoffText);
            await createTranscriptEntry(callLogId, "assistant", handoffText);

            const targetNumber = practiceSettings?.phone_number;
            if (!targetNumber) {
                const fallbackText = "Es gibt ein technisches Problem. Bitte rufen Sie spaeter an.";
                messages.push({ role: "assistant", content: fallbackText });
                await speak(fallbackText);
                await createTranscriptEntry(callLogId, "assistant", fallbackText);
                return;
            }

            const transfer = await transferCallToNumber(callSid, targetNumber);
            if (!transfer.ok) {
                console.error("Handoff failed:", transfer.error);
                const fallbackText = "Es gibt ein technisches Problem. Bitte rufen Sie spaeter an.";
                messages.push({ role: "assistant", content: fallbackText });
                await speak(fallbackText);
                await createTranscriptEntry(callLogId, "assistant", fallbackText);
            }

            callActive = false;
            dg?.finish();
            try {
                connection.close();
            } catch (err) {
                console.warn("Handoff close error:", err);
            }
        }

        async function ensurePracticeSettings() {
            if (practiceSettings) return { ok: true };
            const access = await checkPracticeAccess(practiceId);
            if (!access.allowed || !access.settings) {
                console.error("Practice Access Denied:", access.reason || "Not allowed");
                return {
                    ok: false,
                    message: access.message || ACCESS_DENIED_MESSAGES.default,
                    forwardToNumber: access.settings?.phone_number || null
                };
            }
            practiceSettings = access.settings;
            messages = [{ role: "system", content: buildSystemMessage(practiceSettings) }];
            return { ok: true };
        }

        /* ─────────────── DEEPGRAM ─────────────── */
        function startDeepgram() {
            dg = deepgram.listen.live({
                model: "nova-3",
                language: "de",
                smart_format: true,
                interim_results: true,
                encoding: "mulaw",
                sample_rate: 8000,
                endpointing: 950,
                utterance_end_ms: 1000,
                vad_events: true
            });

            dg.on(LiveTranscriptionEvents.Open, () => console.log("✅ Deepgram listening"));

            dg.on(LiveTranscriptionEvents.Transcript, async (data) => {
                const text = data?.channel?.alternatives?.[0]?.transcript;
                const isFinal = data?.is_final;
                if (handoffState.inProgress) return;

                if (text && isFinal && text.trim().length > 0) {
                    console.log("🎤 User:", text);
                    if (!processing) {
                        processing = true;
                        // User Nachricht hinzufügen
                        messages.push({ role: "user", content: text });
                        await createTranscriptEntry(callLogId, "user", text);
                        handoffState.userTurns += 1;
                        const handoffReason = evaluateHandoffForUserText(text);
                        if (handoffReason) {
                            await initiateHandoff(handoffReason);
                            processing = false;
                            return;
                        }
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

        function hasAvailabilityInputsLegacy(history, sinceIndex = 0) {
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

        function hasAvailabilityInputs(history, sinceIndex = 0) {
            const signals = getConversationSignals(history, sinceIndex);
            return signals.hasDate && signals.hasTime && signals.hasPartySize;
        }

        async function handleToolCalls(toolCalls) {
            console.log("🛠️ Tool Call detected:", toolCalls.length);
            const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
            let handedOff = false;

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
                        practiceSettings.id,
                        callerPhone
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

                if (result?.error && result.error !== "Past date") {
                    handoffState.toolErrors += 1;
                } else if (result?.success === false && result?.error) {
                    handoffState.toolErrors += 1;
                }

                if (handoffState.toolErrors >= HANDOFF_THRESHOLDS.toolErrors) {
                    await initiateHandoff("tool_error");
                    handedOff = true;
                    break;
                }
            }

            return { handedOff };
        }

        async function processAgentTurn() {
            try {
                if (handoffState.inProgress) return;
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

                if (msg.content) {
                    const handoffReason = evaluateHandoffForAssistantText(msg.content);
                    if (handoffReason) {
                        await initiateHandoff(handoffReason);
                        return;
                    }
                }

                // 2. GIBT ES TOOL CALLS? -> AUSFÜHREN & REKURSION
                if (msg.tool_calls) {
                    const { handedOff } = await handleToolCalls(msg.tool_calls);
                    if (handedOff) return;

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
                        const { handedOff } = await handleToolCalls(forcedMsg.tool_calls);
                        if (handedOff) return;
                        await processAgentTurn();
                    }
                    return;
                }

            } catch (err) {
                console.error("❌ LLM Error:", err);
                handoffState.toolErrors += 1;
                if (handoffState.toolErrors >= HANDOFF_THRESHOLDS.toolErrors) {
                    await initiateHandoff("llm_error");
                    return;
                }
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
                callSid = data.start?.callSid || data.start?.call_sid || null;
                console.log("🚀 Stream start:", streamSid);
                practiceId = data.start?.customParameters?.practice_id || practiceId;
                const rawCallerPhone = data.start?.customParameters?.caller_phone
                    || data.start?.customParameters?.from
                    || data.start?.customParameters?.From;
                callerPhone = decodeCustomParam(rawCallerPhone) || null;
                const init = await ensurePracticeSettings();
                if (!init.ok) {
                    if (init.forwardToNumber && callSid) {
                        await transferCallToNumber(callSid, init.forwardToNumber);
                    }
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


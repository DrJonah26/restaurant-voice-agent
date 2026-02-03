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

if (process.env.GOOGLE_TTS_CREDENTIALS) {
    const ttsKeyPath = "/tmp/google-tts-key.json";
    try {
        fs.writeFileSync(ttsKeyPath, process.env.GOOGLE_TTS_CREDENTIALS, "utf8");
        process.env.GOOGLE_APPLICATION_CREDENTIALS = ttsKeyPath;
        console.log("\u2705 Google TTS credentials loaded");
    } catch (err) {
        console.error("Failed to write Google TTS credentials file:", err);
    }
}

/* --------------------- CONFIG --------------------- */

const PORT = process.env.PORT || 5050;
const SYSTEM_MESSAGE_TEMPLATE = fs.readFileSync("system_message.txt", "utf8");

/* --------------------- CLIENTS --------------------- */

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const deepgram = createDeepgramClient(process.env.DEEPGRAM_API_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ttsClient = new textToSpeech.TextToSpeechClient();
const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;

/* --------------------- SERVER --------------------- */

const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const ttsCache = new Map();
const practiceCache = new Map();

const RESERVATION_DURATION_MINUTES = 60;

const ACCESS_DENIED_MESSAGES = {
    expired: "Dieses Restaurant ist derzeit nicht verf\u00fcgbar. Bitte versuchen Sie es sp\u00e4ter erneut.",
    limit_exceeded: "Das monatliche Anruflimit wurde erreicht. Bitte versuchen Sie es sp\u00e4ter erneut.",
    default: "Dieses Restaurant ist derzeit nicht verf\u00fcgbar. Bitte versuchen Sie es sp\u00e4ter erneut."
};

const HANDOFF_THRESHOLDS = {
    misunderstandings: 3
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

function normalizeNumberWord(text) {
    return (text || "")
        .toLowerCase()
        .replace(/\u00e4/g, "ae")
        .replace(/\u00f6/g, "oe")
        .replace(/\u00fc/g, "ue")
        .replace(/\u00df/g, "ss");
}

const NUMBER_WORD_MAP = {
    ein: 1,
    eins: 1,
    eine: 1,
    einer: 1,
    zwei: 2,
    zweit: 2,
    drei: 3,
    dritt: 3,
    vier: 4,
    viert: 4,
    fuenf: 5,
    funf: 5,
    fuenft: 5,
    funft: 5,
    sechs: 6,
    sechst: 6,
    sieben: 7,
    siebt: 7,
    acht: 8,
    neun: 9,
    neunt: 9,
    zehn: 10,
    zehnt: 10,
    elf: 11,
    zwoelf: 12,
    zwolf: 12,
    zwoelft: 12,
    zwolft: 12
};

function extractPartySizeFromText(text) {
    if (!text) return null;
    const sizeMatch = text.match(/\b(\d{1,2})\s*(personen|leute|g(?:a|\u00e4)ste|gaeste|pax)\b/i);
    if (sizeMatch) return Number(sizeMatch[1]);
    const fuerMatch = text.match(/\bf(ue|u)r\s*(\d{1,2})\b/i);
    if (fuerMatch) return Number(fuerMatch[2]);
    const sindMatch = text.match(/\bwir\s+sind\s+(\d{1,2})\b/i);
    if (sindMatch) return Number(sindMatch[1]);
    const normalized = normalizeNumberWord(text);
    const numberWordPattern = "(ein(?:s|e|er)?|zwei|zweit|drei|dritt|vier|viert|fuenf|funf|fuenft|funft|sechs|sechst|sieben|siebt|acht|neun|neunt|zehn|zehnt|elf|zwoelf|zwolf|zwoelft|zwolft)";
    const wordWithUnit = normalized.match(new RegExp(`\\b${numberWordPattern}\\s*(personen|leute|gaeste|gaste|pax)\\b`, "i"));
    if (wordWithUnit) return NUMBER_WORD_MAP[wordWithUnit[1]];
    const wordFuer = normalized.match(new RegExp(`\\bf(?:ue|u)r\\s*${numberWordPattern}\\b`, "i"));
    if (wordFuer) return NUMBER_WORD_MAP[wordFuer[1]];
    const wordSind = normalized.match(new RegExp(`\\bwir\\s+sind\\s+(?:zu\\s+|so\\s+)?${numberWordPattern}\\b`, "i"));
    if (wordSind) return NUMBER_WORD_MAP[wordSind[1]];
    const wordZu = normalized.match(new RegExp(`\\bzu\\s+${numberWordPattern}\\b`, "i"));
    if (wordZu) return NUMBER_WORD_MAP[wordZu[1]];
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

function isAffirmativeResponse(text) {
    const normalized = normalizeNumberWord(text);
    return /\b(ja|jep|jup|jo|klar|gerne|bitte|okay|ok|natuerlich)\b/i.test(normalized) ||
        /\b(verbinde|verbinden|weiterleiten|weiterleite)\b/i.test(normalized);
}

function isNegativeResponse(text) {
    const normalized = normalizeNumberWord(text);
    return /\b(nein|nee|no|noe)\b/i.test(normalized) ||
        normalized.includes("lieber nicht") ||
        normalized.includes("auf keinen fall") ||
        normalized.includes("nicht noetig");
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
    const hasPartySize = extractPartySizeFromText(combined) !== null;
    const hasName = /\b(ich hei(?:ss|\u00df)e|mein name ist|name ist|der name ist|auf den namen|den namen|ich bin)\b/i.test(combined);

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
        `\nHEUTIGES DATUM: ${todayStr} (${weekdayName})\n\n` +
        `WICHTIG - WOCHENTAGE RICHTIG INTERPRETIEREN:\n` +
        `Wenn der Kunde einen Wochentag nennt, nutze diese Zuordnung:\n${next7Days}\n\n` +
        `Beispiel: Sagt jemand "Donnerstag", verwende den kommenden Donnerstag aus der Liste (nicht heute, falls heute Donnerstag ist).\n\n` +
        `REGEL: Wenn der Kunde nach Verf\u00fcgbarkeit fragt, rufe SOFORT 'check_availability' auf. Frage nicht "Soll ich nachsehen?", sondern mach es einfach.\n` +
        `Antworte kurz und pr\u00e4gnant. Wenn Uhrzeiten ohne Doppelpunkt erkannt werden (z.B. "18 30"),\n` +
        `wandle sie IMMER in das Format HH:MM um (z.B. "18:30"),\n` +
        `bevor du sie ausgibst oder weiterverarbeitest.`
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
        console.error("\u274c Practice Settings Error:", error);
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

/* --------------------- DB FUNCTIONS --------------------- */

async function checkAvailability(date, time, partySize, maxCapacity, practiceId) {
    console.log(`\uD83D\uDD0E DB CHECK: ${date} ${time} (${partySize} Pers)`);
    if (isPastDate(date)) {
        console.warn(`\u26A0\uFE0F Past date rejected: ${date}`);
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
        console.error("\u274c DB Error:", error);
        return { available: false, error: "Database error" };
    }

    const peakOccupancy = computePeakOccupancy(data, requestedStart, partySize);
    const used = peakOccupancy;
    const isAvailable = used <= maxCapacity;

    console.log(`\u2705 RESULT: ${isAvailable ? "FREI" : "VOLL"} (Belegt: ${used}/${maxCapacity})`);

    return {
        available: isAvailable,
        remaining: maxCapacity - used
    };
}

async function createReservation(date, time, partySize, name, practiceId, phoneNumber) {
    console.log(`\uD83D\uDCDD RESERVIERUNG: ${name}, ${date}, ${time}`);
    if (isPastDate(date)) {
        console.warn(`\u26A0\uFE0F Past date rejected: ${date}`);
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
        console.error("\u274c Reservation Error:", error);
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
            .select();

        if (error) {
            console.warn("Call log error:", error.message);
            return { success: false, error: error.message };
        }
        return { success: true, id: data?.[0]?.id };
    } catch (err) {
        console.warn("Call log error:", err);
        return { success: false, error: err?.message || String(err) };
    }
}

async function finalizeCallLog(callLogId, durationSeconds) {
    if (!callLogId) return { success: false };
    try {
        const { error } = await supabase
            .from("call_logs")
            .update({
                status: "completed",
                duration_seconds: durationSeconds,
                ended_at: new Date().toISOString()
            })
            .eq("id", callLogId);

        if (error) {
            console.warn("Finalize call log error:", error.message);
            return { success: false, error: error.message };
        }
        return { success: true };
    } catch (err) {
        console.warn("Finalize call log error:", err);
        return { success: false, error: err?.message || String(err) };
    }
}

async function createTranscriptEntry(callLogId, role, content) {
    if (!callLogId || !role || !content) return { success: false };
    try {
        const { error } = await supabase
            .from("call_transcripts")
            .insert({
                call_log_id: callLogId,
                role,
                content
            });

        if (error) {
            console.warn("Transcript insert error:", error.message);
            return { success: false, error: error.message };
        }
        return { success: true };
    } catch (err) {
        console.warn("Transcript insert error:", err);
        return { success: false, error: err?.message || String(err) };
    }
}

/* --------------------- GOOGLE TTS --------------------- */

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
/* --------------------- TWILIO ROUTES --------------------- */

fastify.all("/incoming-call", async (req, reply) => {
    const { practice_id: practiceId } = req.query || {};
    const rawCallerPhone = req.query?.caller_phone
        ?? req.body?.caller_phone
        ?? req.body?.From
        ?? req.body?.from
        ?? req.query?.From
        ?? req.query?.from
        ?? null;
    const callerPhone = decodeCustomParam(rawCallerPhone);

    if (!practiceId) {
        reply.type("text/xml").send(`
<Response>
  <Say>Es gab ein Konfigurationsproblem. Bitte versuchen Sie es sp\u00e4ter erneut.</Say>
  <Hangup/>
</Response>
        `);
        return;
    }

    const access = await checkPracticeAccess(practiceId);
    if (!access.allowed) {
        const forwardNumber = access.settings?.phone_number || null;
        if (forwardNumber) {
            reply.type("text/xml").send(buildHandoffTwiml(forwardNumber));
        } else {
            reply.type("text/xml").send(buildAccessDeniedTwiml(access.message));
        }
        return;
    }

    const callerPhoneParam = callerPhone ? encodeURIComponent(String(callerPhone).trim()) : "";

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
    console.log(`\uD83D\uDCDE Incoming call for practice ${practiceId}`);
});

/* --------------------- MEDIA STREAM --------------------- */

fastify.register(async (fastify) => {
    fastify.get("/media-stream", { websocket: true }, (connection, req) => {
        console.log("\uD83D\uDCDE Call connected");

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
            awaitingConfirmation: false,
            consecutiveMisunderstandings: 0
        };

        const HANDOFF_MESSAGE = "Ich verbinde sie mit einem Mitarbeiter.";
        const HANDOFF_CONFIRM_MESSAGE = "M\u00f6chten Sie zu einem Mitarbeiter weitergeleitet werden?";

        let practiceId = req.query?.practice_id;
        let practiceSettings = null;
        let messages = [];

        function shouldOfferHandoff(text) {
            if (!text) return false;
            const lower = normalizeText(text);
            if (lower.includes("nicht verstanden")) {
                handoffState.consecutiveMisunderstandings += 1;
            } else {
                handoffState.consecutiveMisunderstandings = 0;
            }
            if (handoffState.awaitingConfirmation) return false;
            return handoffState.consecutiveMisunderstandings >= HANDOFF_THRESHOLDS.misunderstandings;
        }

        async function promptHandoffConfirmation() {
            if (handoffState.inProgress || handoffState.awaitingConfirmation || !callActive) return;
            handoffState.awaitingConfirmation = true;
            handoffState.consecutiveMisunderstandings = 0;
            const prompt = HANDOFF_CONFIRM_MESSAGE;
            messages.push({ role: "assistant", content: prompt });
            await speak(prompt);
            await createTranscriptEntry(callLogId, "assistant", prompt);
        }

        async function handleHandoffConfirmation(text) {
            if (!handoffState.awaitingConfirmation) return false;
            if (isAffirmativeResponse(text)) {
                handoffState.awaitingConfirmation = false;
                await initiateHandoff("user_confirmed");
                return true;
            }
            if (isNegativeResponse(text)) {
                handoffState.awaitingConfirmation = false;
                handoffState.consecutiveMisunderstandings = 0;
                const declineText = "Alles klar. Wie kann ich Ihnen sonst helfen?";
                messages.push({ role: "assistant", content: declineText });
                await speak(declineText);
                await createTranscriptEntry(callLogId, "assistant", declineText);
                return true;
            }
            const retryText = "Bitte sagen Sie ja oder nein.";
            messages.push({ role: "assistant", content: retryText });
            await speak(retryText);
            await createTranscriptEntry(callLogId, "assistant", retryText);
            return true;
        }

        async function initiateHandoff(reason) {
            if (handoffState.inProgress || !callActive) return;
            handoffState.inProgress = true;
            console.log("Handoff triggered:", reason);

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

        /* --------------------- DEEPGRAM --------------------- */
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

            dg.on(LiveTranscriptionEvents.Open, () => console.log("\u2705 Deepgram listening"));

            dg.on(LiveTranscriptionEvents.Transcript, async (data) => {
                const text = data?.channel?.alternatives?.[0]?.transcript;
                const isFinal = data?.is_final;
                if (handoffState.inProgress) return;

                if (text && isFinal && text.trim().length > 0) {
                    console.log("\uD83C\uDFA4 User:", text);
                    if (!processing) {
                        processing = true;
                        // User Nachricht hinzufuegen
                        messages.push({ role: "user", content: text });
                        await createTranscriptEntry(callLogId, "user", text);
                        if (await handleHandoffConfirmation(text)) {
                            processing = false;
                            return;
                        }
                        // Rekursiven Prozess starten
                        await processAgentTurn();
                        processing = false;
                    }
                }
            });

            dg.on(LiveTranscriptionEvents.Close, () => console.log("\uD83D\uDD0C Deepgram closed"));
            dg.on(LiveTranscriptionEvents.Error, (e) => console.error("DG Error:", e));
        }

        /* --------------------- REKURSIVE LLM LOGIK --------------------- */

        function shouldForceAvailabilityCall(text) {
            if (!text) return false;
            const lower = text.toLowerCase();
            const hasCheckVerb = /\u00fcberpr\u00fcf|pr(\u00fc|ue)f|nachseh|schau|check/.test(lower);
            const hasAvailabilitySignal = /verf(\u00fc|ue)gbar|frei|tisch/.test(lower);
            return hasCheckVerb && hasAvailabilitySignal;
        }

        function hasAvailabilityInputsLegacy(history, sinceIndex = 0) {
            const userTexts = history
                .slice(sinceIndex)
                .filter((message) => message.role === "user")
                .map((message) => message.content || "");
            const combined = userTexts.join(" ");

            const hasDate = /\b(heute|morgen|\u00fcbermorgen)\b/i.test(combined) ||
                /\b\d{1,2}\.\s?\d{1,2}\.\b/.test(combined) ||
                /\b\d{4}-\d{2}-\d{2}\b/.test(combined);
            const hasTime = /\b\d{1,2}[:.]\d{2}\b/.test(combined) ||
                /\b\d{1,2}\s?\d{2}\b/.test(combined) ||
                /\b\d{1,2}\s?uhr\b/i.test(combined);
            const hasPartySize = /\bf\u00fcr\s?\d+\b/i.test(combined) ||
                /\b\d+\s?(personen|leute|g\u00e4ste)\b/i.test(combined);

            return hasDate && hasTime && hasPartySize;
        }

        function hasAvailabilityInputs(history, sinceIndex = 0) {
            const signals = getConversationSignals(history, sinceIndex);
            return signals.hasDate && signals.hasTime && signals.hasPartySize;
        }

        async function handleToolCalls(toolCalls) {
            console.log("\uD83D\uDEE0\uFE0F Tool Call detected:", toolCalls.length);
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
            }

            return { handedOff: false };
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
                                description: "Pr\u00fcft ob ein Tisch frei ist.",
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
                    console.log("\uD83E\uDD16 AI:", msg.content);
                    await speak(msg.content);
                    await createTranscriptEntry(callLogId, "assistant", msg.content);
                }

                if (msg.content) {
                    if (shouldOfferHandoff(msg.content)) {
                        await promptHandoffConfirmation();
                        return;
                    }
                }

                // 2. GIBT ES TOOL CALLS? -> AUSF\u00dcHREN & REKURSION
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
                                    description: "Pr\u00fcft ob ein Tisch frei ist.",
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
                console.error("\u274c LLM Error:", err);
                await speak("Es gab leider einen Fehler. Bitte nochmal.");
            }
        }

        /* --------------------- SEND AUDIO --------------------- */

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

        /* --------------------- WEBSOCKET HANDLING --------------------- */

        connection.on("message", async (msg) => {
            const data = JSON.parse(msg);

            if (data.event === "start") {
                streamSid = data.start.streamSid;
                callActive = true;
                callSid = data.start?.callSid || data.start?.call_sid || null;
                console.log("\uD83D\uDE80 Stream start:", streamSid);
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
                console.log("\uD83D\uDCDE Call ended");
                callActive = false;
                dg?.finish();
                if (callStartedAt) {
                    const durationSeconds = Math.max(0, Math.round((Date.now() - callStartedAt) / 1000));
                    await finalizeCallLog(callLogId, durationSeconds);
                }
            }
        });

        connection.on("close", () => {
            console.log("\uD83D\uDD0C Connection closed");
            dg?.finish();
            if (callStartedAt) {
                const durationSeconds = Math.max(0, Math.round((Date.now() - callStartedAt) / 1000));
                finalizeCallLog(callLogId, durationSeconds);
            }
        });
    });
});

fastify.listen({ port: PORT, host: "0.0.0.0" }, () => {
    console.log(`\u2705 Server running on port ${PORT}`);
});

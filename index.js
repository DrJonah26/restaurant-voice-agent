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
const NOTIFICATION_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000];
const TURN_QUEUE_MAX_SIZE = 3;
const QUICK_FILLER_TEXT = "Einen Moment, ich pruefe das sofort.";

function parsePositiveInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return parsed;
}

function parsePercent(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(0, Math.min(100, parsed));
}

function parseBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === "") return fallback;
    const normalized = String(value).trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    return fallback;
}

function parseBackoffDelays(rawValue, fallback) {
    if (!rawValue) return fallback;
    const parsed = String(rawValue)
        .split(",")
        .map((part) => Number.parseInt(part.trim(), 10))
        .filter((delay) => Number.isFinite(delay) && delay > 0);
    return parsed.length > 0 ? parsed : fallback;
}

function hashToPercent(value) {
    const text = String(value || "");
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return Math.abs(hash >>> 0) % 100;
}

function getRolloutPercentFromStage(stage) {
    if (stage >= 3) return 100;
    if (stage === 2) return 50;
    if (stage === 1) return 10;
    return 0;
}

const PERF_V2_ENABLED = parseBoolean(process.env.PERF_V2_ENABLED, true);
const PERF_V2_ROLLOUT_STAGE = Math.min(3, Math.max(0, Number.parseInt(process.env.PERF_V2_ROLLOUT_STAGE || "3", 10) || 0));
const PERF_V2_ROLLOUT_PERCENT = parsePercent(process.env.PERF_V2_ROLLOUT_PERCENT, getRolloutPercentFromStage(PERF_V2_ROLLOUT_STAGE));
const DG_ENDPOINTING_MS_LEGACY = 950;
const DG_UTTERANCE_END_MS_LEGACY = 1000;
const DG_ENDPOINTING_MS = Math.max(200, parsePositiveInt(process.env.DG_ENDPOINTING_MS, 550));
const DG_UTTERANCE_END_MS = Math.max(1000, parsePositiveInt(process.env.DG_UTTERANCE_END_MS, 1000));
const INITIAL_TURN_COALESCE_MS = parsePositiveInt(process.env.INITIAL_TURN_COALESCE_MS, 900);
const INITIAL_TURN_FIRST_CHUNK_WAIT_MS = parsePositiveInt(process.env.INITIAL_TURN_FIRST_CHUNK_WAIT_MS, 1800);
const INITIAL_TURN_MAX_WAIT_MS = parsePositiveInt(process.env.INITIAL_TURN_MAX_WAIT_MS, 2600);
const MAX_LLM_HISTORY_MESSAGES = parsePositiveInt(process.env.MAX_LLM_HISTORY_MESSAGES, 18);
const MAX_TOOL_HISTORY_MESSAGES = parsePositiveInt(process.env.MAX_TOOL_HISTORY_MESSAGES, 4);
const TRANSCRIPT_QUEUE_RETRIES = parsePositiveInt(process.env.TRANSCRIPT_QUEUE_RETRIES, 2);
const TRANSCRIPT_QUEUE_BACKOFF_MS = parseBackoffDelays(process.env.TRANSCRIPT_QUEUE_BACKOFF_MS, [300, 900]);

const ACCESS_DENIED_MESSAGES = {
    expired: "Dieses Restaurant ist derzeit nicht verf\u00fcgbar. Bitte versuchen Sie es sp\u00e4ter erneut.",
    limit_exceeded: "Das monatliche Anruflimit wurde erreicht. Bitte versuchen Sie es sp\u00e4ter erneut.",
    default: "Dieses Restaurant ist derzeit nicht verf\u00fcgbar. Bitte versuchen Sie es sp\u00e4ter erneut."
};

const HANDOFF_THRESHOLDS = {
    misunderstandings: 3
};
const HANDOFF_ROUTING_MODE = String(process.env.HANDOFF_ROUTING_MODE || "separate_number").trim().toLowerCase();
const ALLOW_SAME_NUMBER_HANDOFF = HANDOFF_ROUTING_MODE === "studio_same_number";
const HANDOFF_NUMBER_KEYS = [
    "extra_number"
];
console.log(`Handoff routing mode: ${HANDOFF_ROUTING_MODE}`);

const WEEKDAY_MAP = {
    sonntag: 0,
    montag: 1,
    dienstag: 2,
    mittwoch: 3,
    donnerstag: 4,
    freitag: 5,
    samstag: 6
};
const WEEKDAY_LABELS = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
const WEEKDAY_TOKEN_MAP = {
    sonntag: 0,
    montag: 1,
    dienstag: 2,
    mittwoch: 3,
    donnerstag: 4,
    freitag: 5,
    samstag: 6,
    so: 0,
    mo: 1,
    di: 2,
    mi: 3,
    do: 4,
    fr: 5,
    sa: 6,
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
    sun: 0,
    mon: 1,
    tue: 2,
    tues: 2,
    wed: 3,
    thu: 4,
    thur: 4,
    thurs: 4,
    fri: 5,
    sat: 6
};

function parseClosedDaysRaw(value) {
    if (Array.isArray(value)) return value;
    if (typeof value !== "string") return [];
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed;
    } catch {
        // Fall through and parse as delimited string.
    }
    return trimmed
        .replace(/[{}\[\]"']/g, "")
        .split(",")
        .map((token) => token.trim())
        .filter(Boolean);
}

function normalizeWeekdayToken(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[.\-_/]/g, "")
        .replace(/\s+/g, "")
        .replace(/\u00e4/g, "ae")
        .replace(/\u00f6/g, "oe")
        .replace(/\u00fc/g, "ue")
        .replace(/\u00df/g, "ss");
}

function normalizeClosedDays(value) {
    const rawDays = parseClosedDaysRaw(value);
    const normalized = new Set();

    for (const rawDay of rawDays) {
        if (typeof rawDay === "number" && Number.isInteger(rawDay) && rawDay >= 0 && rawDay <= 6) {
            normalized.add(rawDay);
            continue;
        }

        if (typeof rawDay === "string") {
            const numeric = Number(rawDay);
            if (Number.isInteger(numeric) && numeric >= 0 && numeric <= 6) {
                normalized.add(numeric);
                continue;
            }
            const token = normalizeWeekdayToken(rawDay);
            const mapped = WEEKDAY_TOKEN_MAP[token];
            if (Number.isInteger(mapped)) {
                normalized.add(mapped);
            }
        }
    }

    return Array.from(normalized).sort((a, b) => a - b);
}

function getClosedDayDetails(dateStr, closedDaysRaw) {
    const closedDayIndexes = normalizeClosedDays(closedDaysRaw);
    const parsedDate = parseIsoDate(dateStr);
    if (!parsedDate) {
        return {
            isClosed: false,
            requestedDayName: null,
            closedDayNames: closedDayIndexes.map((day) => WEEKDAY_LABELS[day]),
            otherClosedDayNames: [],
            closedDayIndexes
        };
    }

    const requestedDayIndex = parsedDate.getDay();
    const requestedDayName = WEEKDAY_LABELS[requestedDayIndex];
    const closedDayNames = closedDayIndexes.map((day) => WEEKDAY_LABELS[day]);
    const otherClosedDayNames = closedDayIndexes
        .filter((day) => day !== requestedDayIndex)
        .map((day) => WEEKDAY_LABELS[day]);

    return {
        isClosed: closedDayIndexes.includes(requestedDayIndex),
        requestedDayName,
        closedDayNames,
        otherClosedDayNames,
        closedDayIndexes
    };
}

function formatTime(value) {
    if (!value) return "";
    if (typeof value === "string") return value.slice(0, 5);
    return String(value).slice(0, 5);
}

function formatDate(date) {
    return date.toLocaleDateString("sv-SE");
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldEnablePerfV2ForPractice(practiceId) {
    if (!PERF_V2_ENABLED) return false;
    if (!practiceId) return false;
    if (PERF_V2_ROLLOUT_PERCENT >= 100) return true;
    if (PERF_V2_ROLLOUT_PERCENT <= 0) return false;
    return hashToPercent(practiceId) < PERF_V2_ROLLOUT_PERCENT;
}

function trimMessagesForLLM(history, maxDialogMessages = MAX_LLM_HISTORY_MESSAGES, maxToolMessages = MAX_TOOL_HISTORY_MESSAGES) {
    if (!Array.isArray(history) || history.length === 0) return [];

    const indexed = history.map((message, index) => ({ message, index }));
    const systemMessages = indexed.filter((entry) => entry.message?.role === "system");
    const toolMessages = indexed.filter((entry) => entry.message?.role === "tool");
    const dialogMessages = indexed.filter((entry) => entry.message?.role !== "system" && entry.message?.role !== "tool");

    const selectedDialog = dialogMessages.slice(-maxDialogMessages);
    const selectedTools = toolMessages.slice(-maxToolMessages);

    const selectedIndexes = new Set();
    for (const entry of selectedDialog) selectedIndexes.add(entry.index);
    for (const entry of selectedTools) selectedIndexes.add(entry.index);

    const nonSystemSelected = indexed
        .filter((entry) => selectedIndexes.has(entry.index))
        .map((entry) => entry.message);

    return [...systemMessages.map((entry) => entry.message), ...nonSystemSelected];
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

function normalizePhoneNumber(value) {
    if (!value) return null;
    const raw = String(value).trim().replace(/^tel:/i, "");
    const compact = raw.replace(/[\s().-]/g, "");
    if (!compact) return null;

    const normalized = compact.startsWith("+")
        ? `+${compact.slice(1).replace(/\+/g, "")}`
        : compact.replace(/\+/g, "");
    const digits = normalized.replace(/\D/g, "");
    if (digits.length < 6) return null;
    return normalized;
}

function toComparablePhoneNumber(value) {
    const normalized = normalizePhoneNumber(value);
    if (!normalized) return null;
    return normalized.replace(/\D/g, "");
}

function isSamePhoneNumber(a, b) {
    const aComparable = toComparablePhoneNumber(a);
    const bComparable = toComparablePhoneNumber(b);
    if (!aComparable || !bComparable) return false;
    return aComparable === bComparable;
}

function getHandoffNumberCandidates(settings) {
    const candidates = [];
    for (const key of HANDOFF_NUMBER_KEYS) {
        const normalized = normalizePhoneNumber(settings?.[key]);
        if (!normalized) continue;
        if (!candidates.some((existing) => isSamePhoneNumber(existing, normalized))) {
            candidates.push(normalized);
        }
    }
    return candidates;
}

function resolveHandoffTargetNumber(settings, { botNumber = null, forwardedFrom = null, allowSameNumber = false } = {}) {
    const candidates = getHandoffNumberCandidates(settings);
    if (!candidates.length) {
        return { targetNumber: null, reason: "missing_target_number" };
    }
    const normalizedBotNumber = normalizePhoneNumber(botNumber);
    if (allowSameNumber && !normalizedBotNumber) {
        return { targetNumber: null, reason: "missing_bot_number_for_same_number_mode" };
    }

    for (const candidate of candidates) {
        const matchesBotNumber = isSamePhoneNumber(candidate, normalizedBotNumber);
        const matchesForwardedFrom = isSamePhoneNumber(candidate, forwardedFrom);

        if (!allowSameNumber && (matchesBotNumber || matchesForwardedFrom)) {
            continue;
        }

        return {
            targetNumber: candidate,
            reason: null,
            callerIdForTransfer: allowSameNumber ? normalizedBotNumber : null
        };
    }

    if (normalizedBotNumber && candidates.some((candidate) => isSamePhoneNumber(candidate, normalizedBotNumber))) {
        return { targetNumber: null, reason: "target_matches_bot_number" };
    }
    if (forwardedFrom && candidates.some((candidate) => isSamePhoneNumber(candidate, forwardedFrom))) {
        return { targetNumber: null, reason: "target_matches_forwarded_from" };
    }
    return { targetNumber: null, reason: "no_usable_target_number" };
}

function buildHandoffTwiml(phoneNumber, { callerId = null } = {}) {
    const safeNumber = normalizePhoneNumber(phoneNumber);
    if (!safeNumber) return "";
    const safeCallerId = normalizePhoneNumber(callerId);
    if (safeCallerId) {
        return `<Response><Dial callerId="${safeCallerId}"><Number>${safeNumber}</Number></Dial></Response>`;
    }
    return `<Response><Dial><Number>${safeNumber}</Number></Dial></Response>`;
}

function buildHangupTwiml() {
    return "<Response><Hangup/></Response>";
}

function buildAccessDeniedTwiml(message) {
    const safeMessage = message || ACCESS_DENIED_MESSAGES.default;
    return `<Response><Say language="de-DE">${safeMessage}</Say><Hangup/></Response>`;
}

async function updateTwilioCallTwiml(callSid, twiml) {
    if (!twilioAccountSid || !twilioAuthToken) {
        return { ok: false, error: "Missing Twilio credentials" };
    }
    if (!callSid || !twiml) {
        return { ok: false, error: "Missing callSid or TwiML" };
    }

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

async function transferCallToNumber(callSid, phoneNumber, { callerId = null } = {}) {
    const targetNumber = normalizePhoneNumber(phoneNumber);
    if (!callSid || !targetNumber) {
        return { ok: false, error: "Missing callSid or phone number" };
    }
    const twiml = buildHandoffTwiml(targetNumber, { callerId });
    return updateTwilioCallTwiml(callSid, twiml);
}

async function hangupCall(callSid) {
    return updateTwilioCallTwiml(callSid, buildHangupTwiml());
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
    const closedDayIndexes = normalizeClosedDays(practiceSettings.closed_days);
    const closedDaysSummary = closedDayIndexes.length > 0
        ? closedDayIndexes.map((day) => WEEKDAY_LABELS[day]).join(", ")
        : "Keine";
    return (
        SYSTEM_MESSAGE_TEMPLATE
            .replaceAll("{{restaurant_name}}", practiceSettings.name)
            .replaceAll("{{opening_time}}", openingTime)
            .replaceAll("{{closing_time}}", closingTime) +
        `\nGESCHLOSSENE TAGE: ${closedDaysSummary}\n` +
        `\nHEUTIGES DATUM: ${todayStr} (${weekdayName})\n\n` +
        `WICHTIG - WOCHENTAGE RICHTIG INTERPRETIEREN:\n` +
        `Wenn der Kunde einen Wochentag nennt, nutze diese Zuordnung:\n${next7Days}\n\n` +
        `Beispiel: Sagt jemand "Donnerstag", verwende den kommenden Donnerstag aus der Liste (nicht heute, falls heute Donnerstag ist).\n\n` +
        `WICHTIG: Wenn ein Tool-Ergebnis is_closed_day=true zurueckgibt,\n` +
        `sage klar, dass das Restaurant am angefragten Tag geschlossen ist,\n` +
        `nenne auch die weiteren geschlossenen Tage aus other_closed_days (falls vorhanden)\n` +
        `und frage direkt nach einem neuen Termin.\n\n` +
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
        .select("*")
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

async function checkAvailability(date, time, partySize, maxCapacity, practiceId, closedDaysRaw) {
    console.log(`\uD83D\uDD0E DB CHECK: ${date} ${time} (${partySize} Pers)`);
    if (isPastDate(date)) {
        console.warn(`\u26A0\uFE0F Past date rejected: ${date}`);
        return { available: false, error: "Past date" };
    }
    const closedDayDetails = getClosedDayDetails(date, closedDaysRaw);
    if (closedDayDetails.isClosed) {
        console.warn(`\u26A0\uFE0F Closed day rejected: ${date} (${closedDayDetails.requestedDayName})`);
        return {
            available: false,
            error: "Closed day",
            is_closed_day: true,
            requested_day: closedDayDetails.requestedDayName,
            closed_days: closedDayDetails.closedDayNames,
            other_closed_days: closedDayDetails.otherClosedDayNames,
            prompt_user_for_new_date: true
        };
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

async function notifyReservationCreatedWithRetry(reservationId) {
    const baseUrl = process.env.APP_API_BASE_URL;
    const internalApiSecret = process.env.INTERNAL_API_SECRET;

    if (!reservationId) {
        return { success: false, skipped: true, reason: "missing_reservation_id" };
    }
    if (!baseUrl) {
        console.warn("Notification skipped: APP_API_BASE_URL is not set");
        return { success: false, skipped: true, reason: "missing_app_api_base_url" };
    }
    if (!internalApiSecret) {
        console.warn("Notification skipped: INTERNAL_API_SECRET is not set");
        return { success: false, skipped: true, reason: "missing_internal_api_secret" };
    }

    const normalizedBaseUrl = String(baseUrl).replace(/\/+$/, "");
    const url = `${normalizedBaseUrl}/api/internal/notifications/reservation-created`;
    const requestOptions = {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${internalApiSecret}`
        },
        body: JSON.stringify({ reservationId })
    };

    let lastErrorMessage = "Notification request failed";

    for (let attempt = 0; attempt <= NOTIFICATION_RETRY_DELAYS_MS.length; attempt++) {
        try {
            const response = await fetch(url, requestOptions);

            if (response.ok) {
                return { success: true, status: response.status };
            }

            const details = (await response.text()).trim();
            const statusError = details ? `HTTP ${response.status}: ${details}` : `HTTP ${response.status}`;
            lastErrorMessage = statusError;

            if (response.status >= 400 && response.status < 500) {
                console.warn(`Notification failed without retry: ${statusError}`);
                return { success: false, status: response.status, retryable: false, error: statusError };
            }

            if (response.status < 500 || response.status > 599) {
                console.warn(`Notification failed without retry: ${statusError}`);
                return { success: false, status: response.status, retryable: false, error: statusError };
            }
        } catch (error) {
            lastErrorMessage = error?.message || String(error);
        }

        if (attempt === NOTIFICATION_RETRY_DELAYS_MS.length) break;
        await sleep(NOTIFICATION_RETRY_DELAYS_MS[attempt]);
    }

    console.warn(`Notification failed after retries: ${lastErrorMessage}`);
    return { success: false, retryable: true, error: lastErrorMessage };
}

async function createReservation(date, time, partySize, name, practiceId, phoneNumber, closedDaysRaw) {
    console.log(`\uD83D\uDCDD RESERVIERUNG: ${name}, ${date}, ${time}`);
    if (isPastDate(date)) {
        console.warn(`\u26A0\uFE0F Past date rejected: ${date}`);
        return { success: false, error: "Past date" };
    }
    const closedDayDetails = getClosedDayDetails(date, closedDaysRaw);
    if (closedDayDetails.isClosed) {
        console.warn(`\u26A0\uFE0F Closed day reservation rejected: ${date} (${closedDayDetails.requestedDayName})`);
        return {
            success: false,
            error: "Closed day",
            is_closed_day: true,
            requested_day: closedDayDetails.requestedDayName,
            closed_days: closedDayDetails.closedDayNames,
            other_closed_days: closedDayDetails.otherClosedDayNames,
            prompt_user_for_new_date: true
        };
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
    const reservationId = data?.[0]?.id;
    if (!reservationId) {
        console.error("Reservation insert succeeded but no reservation id was returned");
        return { success: false, error: "Reservation id missing" };
    }

    void notifyReservationCreatedWithRetry(reservationId)
        .then((notificationResult) => {
            if (!notificationResult.success && !notificationResult.skipped) {
                console.warn(`Reservation notification error: ${notificationResult.error || "unknown error"}`);
            }
        })
        .catch((err) => {
            console.warn("Reservation notification error:", err?.message || String(err));
        });

    return { success: true, id: reservationId };
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
            name: "de-DE-Chirp-HD-B",
            ssmlGender: "FEMALE"
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
    const rawBotNumber = req.query?.bot_number
        ?? req.query?.to_number
        ?? req.body?.To
        ?? req.body?.to
        ?? req.query?.To
        ?? req.query?.to
        ?? req.body?.Called
        ?? req.query?.Called
        ?? req.body?.called
        ?? req.query?.called
        ?? null;
    const botNumber = decodeCustomParam(rawBotNumber);
    const rawForwardedFrom = req.query?.forwarded_from
        ?? req.body?.forwarded_from
        ?? req.body?.ForwardedFrom
        ?? req.query?.ForwardedFrom
        ?? null;
    const forwardedFrom = decodeCustomParam(rawForwardedFrom);

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
        const handoffResolution = resolveHandoffTargetNumber(access.settings, {
            botNumber,
            forwardedFrom
        });
        const forwardNumber = handoffResolution.targetNumber;
        if (forwardNumber) {
            reply.type("text/xml").send(buildHandoffTwiml(forwardNumber));
        } else {
            if (handoffResolution.reason) {
                console.warn(`Access denied forward blocked: ${handoffResolution.reason}`);
            }
            reply.type("text/xml").send(buildAccessDeniedTwiml(access.message));
        }
        return;
    }

    const callerPhoneParam = callerPhone ? encodeURIComponent(String(callerPhone).trim()) : "";
    const botNumberParam = botNumber ? encodeURIComponent(String(botNumber).trim()) : "";
    const forwardedFromParam = forwardedFrom ? encodeURIComponent(String(forwardedFrom).trim()) : "";

    reply.type("text/xml").send(`
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/media-stream">
      <Parameter name="practice_id" value="${encodeURIComponent(practiceId)}" />
      <Parameter name="caller_phone" value="${callerPhoneParam}" />
      <Parameter name="bot_number" value="${botNumberParam}" />
      <Parameter name="forwarded_from" value="${forwardedFromParam}" />
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
        let deepgramConnected = false;
        let deepgramFallbackAttempted = false;
        let deepgramFailureHandled = false;
        let processing = false;
        let callLogId = null;
        let callStartedAt = null;
        let lastAvailabilityCheckIndex = 0;
        let callerPhone = null;
        let botPhoneNumber = decodeCustomParam(req.query?.bot_number) || null;
        let forwardedFromNumber = decodeCustomParam(req.query?.forwarded_from) || null;
        let callSid = null;
        let hangupTimer = null;
        let greetingTimer = null;
        let hasProcessedFirstUserTurn = false;
        let firstTurnBuffer = null;

        const handoffState = {
            inProgress: false,
            awaitingConfirmation: false,
            consecutiveMisunderstandings: 0
        };
        const callEndState = {
            shouldHangupAfterAssistantReply: false,
            hangupScheduled: false
        };

        const HANDOFF_MESSAGE = "Ich verbinde Sie zurück mit dem Restaurant.";
        const HANDOFF_CONFIRM_MESSAGE = "Möchten Sie zu einem Mitarbeiter weitergeleitet werden?";

        let practiceId = req.query?.practice_id;
        let practiceSettings = null;
        let messages = [];
        let perfV2EnabledForCall = false;
        let turnSequence = 0;
        const pendingTurns = [];
        const transcriptQueue = [];
        let transcriptQueueRunning = false;

        const openAiTools = [
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
        ];

        function warmupTtsCache() {
            const phrases = [
                QUICK_FILLER_TEXT,
                "Alles klar.",
                "Ich schaue kurz nach.",
                "Einen Moment bitte."
            ];
            for (const phrase of phrases) {
                if (ttsCache.has(phrase)) continue;
                void generateTTS(phrase).catch((err) => {
                    console.warn("TTS warmup failed:", err?.message || String(err));
                });
            }
        }

        function createTurnMetrics(sttFinalAt) {
            turnSequence += 1;
            return {
                turn_id: turnSequence,
                stream_sid: streamSid || null,
                call_sid: callSid || null,
                practice_id: practiceId || null,
                perf_v2_enabled: perfV2EnabledForCall,
                stt_final_at: sttFinalAt,
                llm_spans: [],
                tool_spans: [],
                tts_start_at: null,
                tts_send_at: null,
                first_response_at: null,
                openai_calls_per_turn: 0,
                tool_calls_per_turn: 0,
                user_text_length: 0
            };
        }

        function flushTurnMetrics(metrics, reason) {
            if (!metrics) return;
            const turnFirstResponseMs = metrics.first_response_at && metrics.stt_final_at
                ? Math.max(0, metrics.first_response_at - metrics.stt_final_at)
                : null;
            const payload = {
                event: "turn_metrics",
                ...metrics,
                reason: reason || "completed",
                turn_first_response_ms: turnFirstResponseMs
            };
            console.log(JSON.stringify(payload));
        }

        async function processTranscriptQueue() {
            if (transcriptQueueRunning) return;
            transcriptQueueRunning = true;
            try {
                while (transcriptQueue.length > 0) {
                    const item = transcriptQueue.shift();
                    if (!item || !item.callLogId || !item.role || !item.content) continue;

                    let success = false;
                    let lastError = null;
                    for (let attempt = 0; attempt <= TRANSCRIPT_QUEUE_RETRIES; attempt += 1) {
                        const result = await createTranscriptEntry(item.callLogId, item.role, item.content);
                        if (result?.success) {
                            success = true;
                            break;
                        }
                        lastError = result?.error || "unknown_error";
                        if (attempt >= TRANSCRIPT_QUEUE_RETRIES) break;
                        const waitMs = TRANSCRIPT_QUEUE_BACKOFF_MS[Math.min(attempt, TRANSCRIPT_QUEUE_BACKOFF_MS.length - 1)] || 300;
                        await sleep(waitMs);
                    }

                    if (!success) {
                        console.warn("Transcript queue item failed:", {
                            role: item.role,
                            callLogId: item.callLogId,
                            error: lastError
                        });
                    }
                }
            } finally {
                transcriptQueueRunning = false;
            }
        }

        function enqueueTranscriptEntry(callLogIdValue, role, content) {
            if (!callLogIdValue || !role || !content) return;
            transcriptQueue.push({
                callLogId: callLogIdValue,
                role,
                content
            });
            void processTranscriptQueue();
        }

        async function recordTranscriptEntry(role, content) {
            if (!callLogId || !role || !content) return;
            if (!perfV2EnabledForCall) {
                await createTranscriptEntry(callLogId, role, content);
                return;
            }
            enqueueTranscriptEntry(callLogId, role, content);
        }

        function shouldSendQuickFiller(text) {
            if (!perfV2EnabledForCall || !text) return false;
            const normalized = normalizeText(text);
            const hasReservationIntent = /(reservier|reservierung|tisch|verfuegbar|verf\u00fcgbar|frei|uhr|morgen|heute|uebermorgen|\u00fcbermorgen)/i.test(normalized);
            return hasReservationIntent;
        }

        function enqueueTurn(text, sttFinalAt = Date.now(), { isFirstTurn = false } = {}) {
            if (!text) return;
            if (pendingTurns.length >= TURN_QUEUE_MAX_SIZE) {
                pendingTurns.shift();
                console.warn("Turn queue overflow. Oldest turn dropped.");
            }
            pendingTurns.push({
                text,
                sttFinalAt,
                isFirstTurn
            });
            void processPendingTurns();
        }

        function clearFirstTurnBuffer() {
            if (!firstTurnBuffer) return;
            if (firstTurnBuffer.timer) {
                clearTimeout(firstTurnBuffer.timer);
            }
            firstTurnBuffer = null;
        }

        function flushFirstTurnBuffer() {
            if (!firstTurnBuffer) return;
            const mergedText = firstTurnBuffer.parts.join(" ").replace(/\s+/g, " ").trim();
            const sttFinalAt = firstTurnBuffer.sttFinalAt || Date.now();
            clearFirstTurnBuffer();
            hasProcessedFirstUserTurn = true;
            if (mergedText) {
                enqueueTurn(mergedText, sttFinalAt, { isFirstTurn: true });
            }
        }

        function scheduleFirstTurnBufferFlush(delayMs) {
            if (!firstTurnBuffer) return;
            if (firstTurnBuffer.timer) {
                clearTimeout(firstTurnBuffer.timer);
            }
            firstTurnBuffer.timer = setTimeout(() => {
                flushFirstTurnBuffer();
            }, delayMs);
        }

        function handleIncomingFinalTranscript(cleanText) {
            if (!cleanText) return;

            if (!hasProcessedFirstUserTurn) {
                const now = Date.now();
                if (!firstTurnBuffer) {
                    firstTurnBuffer = {
                        parts: [cleanText],
                        sttFinalAt: now,
                        timer: null,
                        startedAt: now
                    };
                    const firstWait = Math.min(INITIAL_TURN_FIRST_CHUNK_WAIT_MS, INITIAL_TURN_MAX_WAIT_MS);
                    scheduleFirstTurnBufferFlush(firstWait);
                } else {
                    firstTurnBuffer.parts.push(cleanText);
                    firstTurnBuffer.sttFinalAt = now;
                    const elapsed = Math.max(0, now - firstTurnBuffer.startedAt);
                    const remaining = Math.max(0, INITIAL_TURN_MAX_WAIT_MS - elapsed);
                    const delay = Math.min(INITIAL_TURN_COALESCE_MS, remaining);
                    if (delay <= 0) {
                        flushFirstTurnBuffer();
                        return;
                    }
                    scheduleFirstTurnBufferFlush(delay);
                }
                return;
            }

            enqueueTurn(cleanText, Date.now());
        }

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
            await recordTranscriptEntry("assistant", prompt);
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
                await recordTranscriptEntry("assistant", declineText);
                return true;
            }
            const retryText = "Bitte sagen Sie ja oder nein.";
            messages.push({ role: "assistant", content: retryText });
            await speak(retryText);
            await recordTranscriptEntry("assistant", retryText);
            return true;
        }

        async function initiateHandoff(reason) {
            if (handoffState.inProgress || !callActive) return;
            handoffState.inProgress = true;
            console.log("Handoff triggered:", reason);

            const handoffText = HANDOFF_MESSAGE;
            messages.push({ role: "assistant", content: handoffText });
            await speak(handoffText);
            await recordTranscriptEntry("assistant", handoffText);

            const handoffResolution = resolveHandoffTargetNumber(practiceSettings, {
                botNumber: botPhoneNumber,
                forwardedFrom: forwardedFromNumber,
                allowSameNumber: ALLOW_SAME_NUMBER_HANDOFF
            });
            const targetNumber = handoffResolution.targetNumber;
            if (!targetNumber) {
                if (handoffResolution.reason) {
                    console.warn(`Handoff blocked: ${handoffResolution.reason}`);
                }
                const fallbackText = "Die Weiterleitung ist derzeit nicht verfuegbar. Bitte versuchen Sie es spaeter erneut.";
                messages.push({ role: "assistant", content: fallbackText });
                await speak(fallbackText);
                await recordTranscriptEntry("assistant", fallbackText);
                handoffState.inProgress = false;
                return;
            }

            const transfer = await transferCallToNumber(callSid, targetNumber, {
                callerId: handoffResolution.callerIdForTransfer || null
            });
            if (!transfer.ok) {
                console.error("Handoff failed:", transfer.error);
                const fallbackText = "Es gibt ein technisches Problem. Bitte rufen Sie spaeter an.";
                messages.push({ role: "assistant", content: fallbackText });
                await speak(fallbackText);
                await recordTranscriptEntry("assistant", fallbackText);
                handoffState.inProgress = false;
                return;
            }
            console.log("Handoff transfer accepted by Twilio");
        }

        function estimateSpeechDurationMs(text) {
            if (!text) return 2200;
            const words = String(text).trim().split(/\s+/).filter(Boolean).length;
            const estimated = words * 360 + 1200;
            return Math.max(2200, Math.min(10000, estimated));
        }

        function scheduleReservationCompletionHangup(lastAssistantText) {
            if (!callActive || callEndState.hangupScheduled) return;
            callEndState.hangupScheduled = true;
            const waitMs = estimateSpeechDurationMs(lastAssistantText);

            hangupTimer = setTimeout(async () => {
                if (!callActive || handoffState.inProgress) return;
                if (!callSid) {
                    connection.close();
                    return;
                }
                const result = await hangupCall(callSid);
                if (!result.ok) {
                    console.error("Auto-hangup failed:", result.error);
                    callEndState.hangupScheduled = false;
                }
            }, waitMs);
        }

        async function ensurePracticeSettings() {
            if (practiceSettings) return { ok: true };
            const access = await checkPracticeAccess(practiceId);
            if (!access.allowed || !access.settings) {
                console.error("Practice Access Denied:", access.reason || "Not allowed");
                const handoffResolution = resolveHandoffTargetNumber(access.settings, {
                    botNumber: botPhoneNumber,
                    forwardedFrom: forwardedFromNumber
                });
                return {
                    ok: false,
                    message: access.message || ACCESS_DENIED_MESSAGES.default,
                    forwardToNumber: handoffResolution.targetNumber,
                    forwardBlockedReason: handoffResolution.reason
                };
            }
            practiceSettings = access.settings;
            messages = [{ role: "system", content: buildSystemMessage(practiceSettings) }];
            return { ok: true };
        }

        /* --------------------- DEEPGRAM --------------------- */
        function getDeepgramLiveOptions(useFallback = false) {
            const endpointing = useFallback
                ? DG_ENDPOINTING_MS_LEGACY
                : (perfV2EnabledForCall ? DG_ENDPOINTING_MS : DG_ENDPOINTING_MS_LEGACY);
            const utteranceEndMs = useFallback
                ? DG_UTTERANCE_END_MS_LEGACY
                : (perfV2EnabledForCall ? DG_UTTERANCE_END_MS : DG_UTTERANCE_END_MS_LEGACY);

            return {
                model: "nova-3",
                language: "de",
                smart_format: true,
                interim_results: true,
                encoding: "mulaw",
                sample_rate: 8000,
                endpointing,
                utterance_end_ms: utteranceEndMs,
                vad_events: true
            };
        }

        function startDeepgram({ useFallback = false } = {}) {
            const liveOptions = getDeepgramLiveOptions(useFallback);
            deepgramConnected = false;

            dg = deepgram.listen.live(liveOptions);

            dg.on(LiveTranscriptionEvents.Open, () => {
                deepgramConnected = true;
                console.log(`\u2705 Deepgram listening (endpointing=${liveOptions.endpointing}, utterance_end_ms=${liveOptions.utterance_end_ms})`);
            });

            dg.on(LiveTranscriptionEvents.Transcript, async (data) => {
                const text = data?.channel?.alternatives?.[0]?.transcript;
                const isFinal = data?.is_final;
                if (handoffState.inProgress) return;
                if (text && text.trim().length > 0 && greetingTimer) {
                    clearTimeout(greetingTimer);
                    greetingTimer = null;
                    console.log("Greeting canceled due to early user speech.");
                }

                if (text && isFinal && text.trim().length > 0) {
                    const cleanText = text.trim();
                    console.log("\uD83C\uDFA4 User:", cleanText);
                    handleIncomingFinalTranscript(cleanText);
                }
            });

            dg.on(LiveTranscriptionEvents.Close, () => console.log("\uD83D\uDD0C Deepgram closed"));
            dg.on(LiveTranscriptionEvents.Error, async (e) => {
                const message = e?.message || "unknown_deepgram_error";
                const isHandshakeError = /non-101 status code|ready state: connecting|network error/i.test(message);
                console.error("DG Error:", {
                    message,
                    requestId: e?.requestId,
                    statusCode: e?.statusCode,
                    url: e?.url,
                    readyState: e?.readyState
                });

                if (!deepgramConnected && isHandshakeError && !useFallback && !deepgramFallbackAttempted) {
                    deepgramFallbackAttempted = true;
                    console.warn("Deepgram handshake failed. Retrying once with legacy streaming parameters.");
                    try {
                        dg?.finish();
                    } catch {
                        // no-op
                    }
                    startDeepgram({ useFallback: true });
                    return;
                }

                if (!deepgramConnected && !deepgramFailureHandled && callActive) {
                    deepgramFailureHandled = true;
                    console.error("Deepgram connection failed permanently. Triggering handoff.");
                    await initiateHandoff("deepgram_connection_error");
                }
            });
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

        async function handleUserTurn(turn) {
            if (!turn?.text) return;

            const metrics = createTurnMetrics(turn.sttFinalAt);
            metrics.user_text_length = turn.text.length;

            try {
                messages.push({ role: "user", content: turn.text });
                await recordTranscriptEntry("user", turn.text);

                if (await handleHandoffConfirmation(turn.text)) {
                    flushTurnMetrics(metrics, "handoff_confirmation");
                    return;
                }
                if (isExplicitHandoffRequest(turn.text)) {
                    await initiateHandoff("explicit_user_request");
                    flushTurnMetrics(metrics, "explicit_handoff_request");
                    return;
                }

                if (!turn.isFirstTurn && shouldSendQuickFiller(turn.text)) {
                    await speak(QUICK_FILLER_TEXT, { metrics });
                    await recordTranscriptEntry("assistant", QUICK_FILLER_TEXT);
                }

                await processAgentTurn(metrics);
                flushTurnMetrics(metrics, metrics.error ? "error" : "completed");
            } catch (err) {
                console.error("Turn handling error:", err);
                flushTurnMetrics(metrics, "error");
            }
        }

        async function processPendingTurns() {
            if (processing) return;
            processing = true;
            try {
                while (pendingTurns.length > 0 && callActive && !handoffState.inProgress) {
                    const nextTurn = pendingTurns.shift();
                    await handleUserTurn(nextTurn);
                }
            } finally {
                processing = false;
            }

            if (pendingTurns.length > 0 && callActive && !handoffState.inProgress) {
                void processPendingTurns();
            }
        }

        async function handleToolCalls(toolCalls, metrics = null) {
            console.log("\uD83D\uDEE0\uFE0F Tool Call detected:", toolCalls.length);
            const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");

            for (const tool of toolCalls) {
                const args = JSON.parse(tool.function.arguments);
                let result;
                const toolStartAt = Date.now();

                if (tool.function.name === "check_availability") {
                    const resolvedDate = resolveWeekdayDate(args.date, lastUserMessage?.content || "");
                    result = await checkAvailability(
                        resolvedDate,
                        args.time,
                        args.party_size,
                        practiceSettings.max_capacity,
                        practiceSettings.id,
                        practiceSettings.closed_days
                    );
                } else if (tool.function.name === "create_reservation") {
                    const resolvedDate = resolveWeekdayDate(args.date, lastUserMessage?.content || "");
                    result = await createReservation(
                        resolvedDate,
                        args.time,
                        args.party_size,
                        args.name,
                        practiceSettings.id,
                        callerPhone,
                        practiceSettings.closed_days
                    );
                    if (result?.success) {
                        callEndState.shouldHangupAfterAssistantReply = true;
                    }
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

                if (metrics) {
                    metrics.tool_calls_per_turn += 1;
                    metrics.tool_spans.push({
                        name: tool.function.name,
                        start_at: toolStartAt,
                        end_at: Date.now()
                    });
                }
            }

            return { handedOff: false };
        }
        async function processAgentTurn(metrics = null) {
            try {
                if (handoffState.inProgress) return;

                const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
                const forceAvailabilityTool = perfV2EnabledForCall
                    && (shouldForceAvailabilityCall(lastUserMessage?.content || "") || hasAvailabilityInputs(messages, lastAvailabilityCheckIndex));
                const toolChoice = forceAvailabilityTool
                    ? { type: "function", function: { name: "check_availability" } }
                    : "auto";

                const llmStartAt = Date.now();
                const res = await openai.chat.completions.create({
                    model: "gpt-4o-mini",
                    messages: perfV2EnabledForCall ? trimMessagesForLLM(messages) : messages,
                    tools: openAiTools,
                    tool_choice: toolChoice
                });
                const llmEndAt = Date.now();
                if (metrics) {
                    metrics.openai_calls_per_turn += 1;
                    metrics.llm_spans.push({
                        start_at: llmStartAt,
                        end_at: llmEndAt,
                        tool_choice: typeof toolChoice === "string" ? toolChoice : toolChoice.function?.name || "function"
                    });
                }

                const msg = res.choices?.[0]?.message;
                if (!msg) return;
                messages.push(msg);

                if (msg.content) {
                    console.log("\uD83E\uDD16 AI:", msg.content);
                    await speak(msg.content, { metrics });
                    await recordTranscriptEntry("assistant", msg.content);
                }

                if (msg.content && shouldOfferHandoff(msg.content)) {
                    await promptHandoffConfirmation();
                    return;
                }

                if (msg.tool_calls) {
                    const { handedOff } = await handleToolCalls(msg.tool_calls, metrics);
                    if (handedOff) return;
                    await processAgentTurn(metrics);
                    return;
                }

                if (callEndState.shouldHangupAfterAssistantReply && msg.content) {
                    callEndState.shouldHangupAfterAssistantReply = false;
                    scheduleReservationCompletionHangup(msg.content);
                    return;
                }

                if (!perfV2EnabledForCall && !msg.tool_calls && (shouldForceAvailabilityCall(msg.content) || hasAvailabilityInputs(messages, lastAvailabilityCheckIndex))) {
                    const forcedStartAt = Date.now();
                    const forcedRes = await openai.chat.completions.create({
                        model: "gpt-4o-mini",
                        messages,
                        tools: [openAiTools[0]],
                        tool_choice: { type: "function", function: { name: "check_availability" } }
                    });
                    const forcedEndAt = Date.now();
                    if (metrics) {
                        metrics.openai_calls_per_turn += 1;
                        metrics.llm_spans.push({
                            start_at: forcedStartAt,
                            end_at: forcedEndAt,
                            tool_choice: "check_availability"
                        });
                    }

                    const forcedMsg = forcedRes.choices?.[0]?.message;
                    if (!forcedMsg) return;
                    messages.push(forcedMsg);

                    if (forcedMsg.tool_calls) {
                        const { handedOff } = await handleToolCalls(forcedMsg.tool_calls, metrics);
                        if (handedOff) return;
                        await processAgentTurn(metrics);
                    }
                }
            } catch (err) {
                console.error("\u274c LLM Error:", err);
                if (metrics) {
                    metrics.error = err?.message || String(err);
                }
                await speak("Es gab leider einen Fehler. Bitte nochmal.", { metrics });
            }
        }

        /* --------------------- SEND AUDIO --------------------- */

        async function speak(text, { metrics = null } = {}) {
            if (!callActive || !streamSid) return;
            try {
                const ttsStartAt = Date.now();
                if (metrics && !metrics.tts_start_at) {
                    metrics.tts_start_at = ttsStartAt;
                }
                const audio = await generateTTS(text);
                const payload = audio.toString("base64");

                connection.send(JSON.stringify({
                    event: "media",
                    streamSid,
                    media: { payload }
                }));
                if (metrics) {
                    const sentAt = Date.now();
                    metrics.tts_send_at = sentAt;
                    if (!metrics.first_response_at) {
                        metrics.first_response_at = sentAt;
                    }
                }
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
                deepgramConnected = false;
                deepgramFallbackAttempted = false;
                deepgramFailureHandled = false;
                hasProcessedFirstUserTurn = false;
                clearFirstTurnBuffer();
                if (greetingTimer) {
                    clearTimeout(greetingTimer);
                    greetingTimer = null;
                }
                callSid = data.start?.callSid || data.start?.call_sid || null;
                console.log("\uD83D\uDE80 Stream start:", streamSid);
                practiceId = data.start?.customParameters?.practice_id || practiceId;
                perfV2EnabledForCall = shouldEnablePerfV2ForPractice(practiceId);
                console.log(`PERF_V2 status for practice ${practiceId}: ${perfV2EnabledForCall ? "enabled" : "disabled"} (global=${PERF_V2_ENABLED}, rollout=${PERF_V2_ROLLOUT_PERCENT}%)`);
                const rawCallerPhone = data.start?.customParameters?.caller_phone
                    || data.start?.customParameters?.from
                    || data.start?.customParameters?.From;
                callerPhone = decodeCustomParam(rawCallerPhone) || null;
                const rawBotNumber = data.start?.customParameters?.bot_number
                    || data.start?.customParameters?.to
                    || data.start?.customParameters?.To
                    || data.start?.customParameters?.called
                    || data.start?.customParameters?.Called;
                botPhoneNumber = decodeCustomParam(rawBotNumber) || botPhoneNumber;
                const rawForwardedFrom = data.start?.customParameters?.forwarded_from
                    || data.start?.customParameters?.ForwardedFrom;
                forwardedFromNumber = decodeCustomParam(rawForwardedFrom) || forwardedFromNumber;
                const init = await ensurePracticeSettings();
                if (!init.ok) {
                    if (init.forwardBlockedReason) {
                        console.warn(`Initial forward blocked: ${init.forwardBlockedReason}`);
                    }
                    if (init.forwardToNumber && callSid) {
                        await transferCallToNumber(callSid, init.forwardToNumber);
                    }
                    connection.close();
                    return;
                }
                startDeepgram();
                if (perfV2EnabledForCall) {
                    warmupTtsCache();
                }
                const greeting = `${practiceSettings.name}, guten Tag. Wie kann ich helfen?`;
                messages.push({ role: "assistant", content: greeting });
                greetingTimer = setTimeout(() => {
                    greetingTimer = null;
                    if (!callActive || handoffState.inProgress) return;
                    void speak(greeting);
                }, 500);
                callStartedAt = Date.now();
                const callLog = await createCallLog(practiceId, streamSid);
                callLogId = callLog.id || null;
                await recordTranscriptEntry("assistant", greeting);
            }

            if (data.event === "media" && dg && dg.getReadyState() === 1) {
                const payload = data.media.payload;
                if (payload) dg.send(Buffer.from(payload, "base64"));
            }

            if (data.event === "stop") {
                console.log("\uD83D\uDCDE Call ended");
                callActive = false;
                if (greetingTimer) {
                    clearTimeout(greetingTimer);
                    greetingTimer = null;
                }
                clearFirstTurnBuffer();
                pendingTurns.length = 0;
                if (hangupTimer) {
                    clearTimeout(hangupTimer);
                    hangupTimer = null;
                }
                dg?.finish();
                if (callStartedAt) {
                    const durationSeconds = Math.max(0, Math.round((Date.now() - callStartedAt) / 1000));
                    await finalizeCallLog(callLogId, durationSeconds);
                }
            }
        });

        connection.on("close", () => {
            console.log("\uD83D\uDD0C Connection closed");
            callActive = false;
            if (greetingTimer) {
                clearTimeout(greetingTimer);
                greetingTimer = null;
            }
            clearFirstTurnBuffer();
            pendingTurns.length = 0;
            if (hangupTimer) {
                clearTimeout(hangupTimer);
                hangupTimer = null;
            }
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

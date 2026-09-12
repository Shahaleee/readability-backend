const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const API_KEY = process.env.GROQ_API_KEY;
const API_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "openai/gpt-oss-120b";

// Global configuration safeguard
if (!API_KEY) {
    console.error("CRITICAL ERROR: GROQ_API_KEY environment variable is missing.");
}

// Shared helper: call Groq's chat completions endpoint
async function callGroq(promptText, { jsonMode = false, maxTokens = 4096, temperature = 0.4 } = {}) {
    const body = {
        model: MODEL,
        messages: [{ role: "user", content: promptText }],
        temperature: temperature,
        max_tokens: maxTokens
    };

    // Ask Groq to guarantee raw JSON output when we need structured data
    if (jsonMode) {
        body.response_format = { type: "json_object" };
    }

    const response = await fetch(API_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${API_KEY}`
        },
        body: JSON.stringify(body)
    });

    const data = await response.json();

    if (data.error) {
        const err = new Error(data.error.message || "Groq API error");
        err.status = response.status;
        throw err;
    }

    const rawText = data.choices?.[0]?.message?.content?.trim();
    if (!rawText) {
        const err = new Error("Empty response from Groq.");
        err.status = 502;
        throw err;
    }

    return rawText;
}

function stripJsonFences(text) {
    return text.replace(/```json\n?|```/g, '').trim();
}

// ==========================================
// 1. ENDPOINT: TEXT SIMPLIFIER
// ==========================================
app.post('/api/simplify', async (req, res) => {
    const { text, targetGrade } = req.body;

    if (!API_KEY) {
        return res.status(500).json({ error: "Backend configuration error: GROQ_API_KEY is missing." });
    }
    if (!text || !text.trim()) {
        return res.status(400).json({ error: "No text provided for simplification." });
    }

    try {
        const prompt = `You are an expert educational assistant. Simplify the following text strictly for a Grade ${targetGrade} level.
CRITICAL RULES:
1. Output ONLY plain, clean text paragraphs.
2. Do NOT use any Markdown formatting, asterisks (*), or bold text (**).
3. Do NOT include conversational filler, introductions, or conclusions. Start directly with the explanation.
4. Make it look professional, clean, and ready for a teacher or parent to copy and paste directly into a school worksheet.

Text to simplify: ${text}`;

        const simplifiedText = await callGroq(prompt);

        // Kept in the same shape the frontend already expects
        // (data.candidates[0].content.parts[0].text)
        res.json({
            candidates: [
                { content: { parts: [{ text: simplifiedText }] } }
            ]
        });
    } catch (error) {
        console.error("Simplification Server Error:", error);
        res.status(error.status || 500).json({ error: error.message || "Failed to connect to AI service" });
    }
});

// ==========================================
// 2. ENDPOINT: FULL STRUCTURED ANALYSIS
// ==========================================
app.post('/api/full-analyze', async (req, res) => {
    const { text } = req.body;

    if (!API_KEY) {
        return res.status(500).json({ error: "Backend configuration error: GROQ_API_KEY is missing." });
    }
    if (!text || !text.trim()) {
        return res.status(400).json({ error: "No text provided for analysis." });
    }

    try {
        const prompt = `You are an expert CBSE curriculum analyst and reading-level specialist for teachers and parents in India.

Analyze the text below in two steps:
1. Identify the general subject and topic area (e.g. "physics — electrostatics", "history — early 20th century economic history", "biology — cell structure").
2. Estimate which CBSE class that subject/topic area is typically taught in, based on the general difficulty and scope of the concepts involved — not on trying to recall an exact chapter or textbook name.

IMPORTANT — avoid hallucination:
- Do NOT name a specific chapter title, textbook name, or NCERT book title (e.g. do not say things like "this is Chapter 4 of [book name]"). You cannot reliably verify exact chapter placement, and a wrong specific citation is worse than a general, honest description.
- In "gradeReport", describe the subject and general topic area in plain words, and state your estimated class — without asserting a specific chapter or book as fact.
- Reason primarily from genuine conceptual difficulty and vocabulary for that subject, not from a guessed memory of an exact syllabus document.

Respond with ONLY a single raw JSON object — no markdown fences, no commentary, no preamble.

Use exactly this schema:
{
  "gradeLevel": <integer 1-12, your best estimate of the CBSE Class this text's subject/topic difficulty corresponds to>,
  "gradeReport": "<one or two sentences: name the general subject/topic area and state your estimated CBSE class, without citing a specific chapter or textbook title>",
  "classSuitability": [<12 integers, 0-100, one per CBSE Class 1 through 12 in order, representing how suitable this text is for that class>],
  "keyConcepts": [{"concept": "<a short phrase naming a main concept or topic in the text>", "explanation": "<a simple, one-sentence explanation of that concept>"}],
  "difficultWords": [{"word": "<the exact word or short phrase as it appears in the text>", "definition": "<a simple, one-sentence, student-friendly definition>"}],
  "summary": "<a concise 2-4 sentence plain-English summary of the text>",
  "simplified": "<the full text rewritten in plain, clean paragraphs at roughly one class level below the estimated gradeLevel, with no markdown formatting>"
}

Rules:
- Identify 4 to 10 genuinely difficult, advanced, or abstract words/phrases for "difficultWords". Skip this list if the text is already very simple.
- "gradeLevel" must be a plain integer, not a string or range.
- "classSuitability" must have exactly 12 integers. The class matching "gradeLevel" should score highest (usually 85-100), with suitability tapering off gradually for classes further away — don't just put one class at 100 and everything else at 0, reflect genuine overlap between neighboring classes.
- "keyConcepts" must have between 3 and 6 entries, each with its own short "concept" phrase and a one-sentence "explanation" a student could understand.
- Never wrap the JSON in backticks or add any text outside the JSON object.

Text to analyze:
"""${text}"""`;

        const rawJsonText = await callGroq(prompt, { jsonMode: true, maxTokens: 6000, temperature: 0.05 });

        let parsed;
        try {
            parsed = JSON.parse(stripJsonFences(rawJsonText));
        } catch (parseErr) {
            console.error("JSON parse failed. Raw response was:", rawJsonText);
            const err = new Error("The AI returned a malformed response. Please try again.");
            err.status = 502;
            throw err;
        }

        // Light normalization so the frontend can rely on the shape
        parsed.gradeLevel = Math.max(1, Math.min(12, parseInt(parsed.gradeLevel, 10) || 1));

        const rawConcepts = Array.isArray(parsed.keyConcepts) ? parsed.keyConcepts : [];
        parsed.keyConcepts = rawConcepts.map(item => {
            if (typeof item === 'string') {
                // Fallback in case the model ever slips back to plain strings
                return { concept: item, explanation: "" };
            }
            return {
                concept: item?.concept || "",
                explanation: item?.explanation || ""
            };
        }).filter(item => item.concept);

        parsed.difficultWords = Array.isArray(parsed.difficultWords) ? parsed.difficultWords : [];
        parsed.gradeReport = parsed.gradeReport || "";
        parsed.summary = parsed.summary || "";
        parsed.simplified = parsed.simplified || "";

        // Validate classSuitability: must be exactly 12 numbers 0-100.
        // If the AI omitted it or returned something malformed, fall back to
        // a synthetic bell curve centered on gradeLevel so the UI never breaks.
        const rawSuitability = Array.isArray(parsed.classSuitability) ? parsed.classSuitability : [];
        const cleanSuitability = rawSuitability
            .slice(0, 12)
            .map(v => Math.max(0, Math.min(100, parseInt(v, 10) || 0)));

        if (cleanSuitability.length === 12 && cleanSuitability.some(v => v > 0)) {
            parsed.classSuitability = cleanSuitability;
        } else {
            parsed.classSuitability = Array.from({ length: 12 }, (_, i) => {
                const classNum = i + 1;
                const distance = Math.abs(classNum - parsed.gradeLevel);
                return Math.max(5, Math.round(100 - distance * 22));
            });
        }

        res.json(parsed);
    } catch (error) {
        console.error("Full Analysis Server Error:", error);
        res.status(error.status || 500).json({ error: error.message || "AI Analysis Engine temporary blackout." });
    }
});

// ==========================================
// 3. ENDPOINT: AI VALIDATION GATEKEEPER
// ==========================================
app.post('/api/validate', async (req, res) => {
    const { text } = req.body;

    if (!API_KEY) {
        return res.status(500).json({ error: "Backend configuration error: GROQ_API_KEY is missing." });
    }
    if (!text || !text.trim()) {
        return res.json({ isValid: true });
    }

    try {
        const prompt = `You are a strict validation filter. Analyze the following text.
If it contains heavy internet slang, brainrot, keyboard mashing (e.g., asdfgh, tyfikghyio), or completely lacks standard English/academic structure, reject it.
Respond ONLY with a valid JSON object in this exact format: {"isValid": true/false, "reason": "Short reason if false"}.
Text to analyze: "${text}"`;

        const rawText = await callGroq(prompt, { jsonMode: true });
        const result = JSON.parse(stripJsonFences(rawText));

        res.json(result);
    } catch (error) {
        console.error("Validation Server Error:", error);
        res.status(error.status || 500).json({ error: error.message || "Failed to validate text payload context structure." });
    }
});

// ==========================================
// 4. SERVER RUNTIME INITIALIZATION
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Capstone Production Server running smoothly on port ${PORT}`);
});
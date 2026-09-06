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
async function callGroq(promptText, { jsonMode = false } = {}) {
    const body = {
        model: MODEL,
        messages: [{ role: "user", content: promptText }],
        temperature: 0.4
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
        const prompt = `You are an expert reading-level and curriculum analysis engine for teachers and parents.

Analyze the text below and respond with ONLY a single raw JSON object — no markdown fences, no commentary, no preamble.

Use exactly this schema:
{
  "gradeLevel": <integer 1-12, your best estimate of the US academic grade required to comfortably read this text>,
  "gradeReport": "<one or two sentence, teacher-friendly explanation of why this text sits at that grade level>",
  "keyConcepts": ["<3 to 6 short phrases naming the main concepts or topics in the text>"],
  "difficultWords": [{"word": "<the exact word or short phrase as it appears in the text>", "definition": "<a simple, one-sentence, student-friendly definition>"}],
  "summary": "<a concise 2-4 sentence plain-English summary of the text>",
  "simplified": "<the full text rewritten in plain, clean paragraphs at roughly one grade level below the estimated gradeLevel, with no markdown formatting>"
}

Rules:
- Identify 4 to 10 genuinely difficult, advanced, or abstract words/phrases for "difficultWords". Skip this list if the text is already very simple.
- "gradeLevel" must be a plain integer, not a string or range.
- Never wrap the JSON in backticks or add any text outside the JSON object.

Text to analyze:
"""${text}"""`;

        const rawJsonText = await callGroq(prompt, { jsonMode: true });
        const parsed = JSON.parse(stripJsonFences(rawJsonText));

        // Light normalization so the frontend can rely on the shape
        parsed.gradeLevel = Math.max(1, Math.min(12, parseInt(parsed.gradeLevel, 10) || 1));
        parsed.keyConcepts = Array.isArray(parsed.keyConcepts) ? parsed.keyConcepts : [];
        parsed.difficultWords = Array.isArray(parsed.difficultWords) ? parsed.difficultWords : [];
        parsed.gradeReport = parsed.gradeReport || "";
        parsed.summary = parsed.summary || "";
        parsed.simplified = parsed.simplified || "";

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
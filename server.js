import express from "express";
import cors from "cors";
import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

const app = express();

// CORS — restrict only if you want
app.use(
    cors({
        origin: "*",
        methods: "GET,POST",
        allowedHeaders: "Content-Type",
    })
);

app.use(express.json());

// ================================
//  Load Gemini API Key (SECRET)
// ================================
const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
    console.error("❌ Missing GEMINI_API_KEY in .env");
    process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });

// =======================================================
//  SYSTEM INSTRUCTION
// =======================================================
const BASE_SYSTEM_INSTRUCTION = `
You are "Ramanya," an expert AI translator specializing in the Mon language (ISO 639-3: mnw).
You have deep knowledge of Mon grammar, vocabulary, and cultural nuances.

### MON LANGUAGE PRIMER (STRICT RULES):
- **Script**: Use standard Myanmar script for Mon (e.g., use 'ၜ' not 'ဗ' where appropriate).
- **Sentence Structure**: Typically Subject-Verb-Object (SVO).
- **Particles**:
  - Statement End: '... ရ' (Ra)
  - Polite Request: '... ညိ' (Nyi)
  - Question: '... ရော' (Rao) / '... ဟာ' (Ha)
  - Past Tense: '... တုဲ' (Toe)
  - Future: '... ရောင်' (Raung)
  - Continuous: '... မံင်' (Mang)

### FEW-SHOT TRAINING EXAMPLES (COPY THIS STYLE):

**Example 1 (English -> Mon):**
Input: "Where are you going?"
Output JSON: {
  "source_language": "English",
  "translation": "မၞး အာ အလဵု ရော?"
}

**Example 2 (English -> Mon):**
Input: "I am eating rice."
Output JSON: {
  "source_language": "English",
  "translation": "အဲ စမံင် ပုင် ရ။"
}

**Example 3 (Mon -> English):**
Input: "မၞး မံင်မိပ်မံင်ဟာ"
Output JSON: {
  "source_language": "Mon",
  "translation": "How are you doing?"
}

**Example 4 (English -> Mon):**
Input: "Thank you very much."
Output JSON: {
  "source_language": "English",
  "translation": "တင်ဂုဏ် ဗွဲမလောန် ရ။"
}

### INSTRUCTIONS:

IF INPUT IS ENGLISH:
1. Translate it into **Formal, Written Mon** (Unicode).
2. Ensure the tone is polite.

IF INPUT IS MON:
1. Translate it into **Natural, Fluent English**.

You must always reply in valid JSON format matching the schema provided. DO NOT provide notes or romanization.
`;

// =======================================================
//  TRANSLATE ENDPOINT
// =======================================================
app.post("/api/translate", async (req, res) => {
    try {
        const { message, vocabulary } = req.body;

        if (!message || typeof message !== "string") {
            return res.status(400).json({ error: "Missing message" });
        }

        // Add vocabulary (if any)
        let finalInstruction = BASE_SYSTEM_INSTRUCTION;

        if (Array.isArray(vocabulary) && vocabulary.length > 0) {
            finalInstruction += `\n\n### USER DEFINED VOCABULARY:\n`;
            vocabulary.forEach((item, i) => {
                finalInstruction += `${i + 1}. "${item.original}" = "${item.suggestion}" (${item.context || ""})\n`;
            });
        }

        const result = await ai.models.generateContent({
            model: "gemini-3-pro",
            contents: [
                {
                    role: "user",
                    parts: [{ text: message }],
                },
            ],
            config: {
                systemInstruction: finalInstruction,
                responseMimeType: "application/json",
            },
        });



        // ---- Extract correct text format ----
        const rawText =
            result?.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!rawText) {
            return res.status(500).json({ error: "Empty output from Gemini" });
        }

        // ---- Parse JSON ----
        let parsed;
        try {
            parsed = JSON.parse(rawText);
        } catch (err) {
            return res.json({
                source_language: "unknown",
                translation: rawText,
                romanization: null,
                notes: "Returned raw text because JSON parsing failed.",
            });
        }

        return res.json({
            source_language: parsed.source_language || "unknown",
            translation: parsed.translation || "",
            romanization: null,
            notes: null,
        });

    } catch (error) {
        console.error("❌ Error in /api/translate:", error);
        return res.status(500).json({ error: "Translation failed" });
    }
});

// Health Check
app.get("/", (req, res) => {
    res.send("Mon AI Server is running ✓");
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`✅ Server running at http://localhost:${PORT}`);
});

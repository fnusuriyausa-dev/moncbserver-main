import express from "express";
import cors from "cors";
import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import admin from "firebase-admin";

const app = express();

// -------------------------------------------------------------
// 1. Body size limit (avoid 413) + CORS
// -------------------------------------------------------------
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.use(
  cors({
    origin: "*",
    methods: "GET,POST",
    allowedHeaders: "Content-Type",
  })
);

// -------------------------------------------------------------
// 2. Gemini API
// -------------------------------------------------------------
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("❌ Missing GEMINI_API_KEY in environment");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });

// -------------------------------------------------------------
// 3. Firestore (admin SDK)
// -------------------------------------------------------------
const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!serviceAccountJson) {
  console.error("❌ Missing FIREBASE_SERVICE_ACCOUNT in environment");
  process.exit(1);
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(serviceAccountJson)),
  });
}
const db = admin.firestore();

// -------------------------------------------------------------
// 4. Helper: Embeddings + cosine similarity
// -------------------------------------------------------------
async function embedText(text) {
  if (!text || !text.trim()) return null;

  const result = await ai.models.embedContent({
    model: "gemini-embedding-001",
    contents: text,
    // You can tune the dimensionality if you want smaller vectors
    config: { outputDimensionality: 256 },
  });

  const embedding = result?.embeddings?.[0]?.values;
  if (!embedding || !Array.isArray(embedding)) {
    console.warn("⚠ No embedding returned for text:", text.slice(0, 60));
    return null;
  }
  return embedding;
}

function dot(a, b) {
  let s = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) s += a[i] * b[i];
  return s;
}

function magnitude(v) {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

function cosineSimilarity(a, b) {
  const ma = magnitude(a);
  const mb = magnitude(b);
  if (!ma || !mb) return 0;
  return dot(a, b) / (ma * mb);
}

// -------------------------------------------------------------
// 5. Load approved suggestions + ensure embeddings (Option A)
// -------------------------------------------------------------
async function getApprovedSuggestionsWithEmbeddings() {
  const snapshot = await db
    .collection("suggestions")
    .where("status", "==", "approved")
    .get();

  const suggestions = [];

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const original = data.original;
    const suggestion = data.suggestion;
    const context = data.context || "";

    if (!original || !suggestion) continue;

    let embedding = data.embedding;

    // Lazily generate embedding if missing
    if (!embedding || !Array.isArray(embedding) || embedding.length === 0) {
      try {
        embedding = await embedText(original);
        if (embedding) {
          await doc.ref.update({ embedding });
        }
      } catch (err) {
        console.error("⚠ Failed to embed suggestion", doc.id, err);
        continue;
      }
    }

    if (!embedding) continue;

    suggestions.push({
      id: doc.id,
      original,
      suggestion,
      context,
      embedding,
    });
  }

  return suggestions;
}

// -------------------------------------------------------------
// 6. SYSTEM INSTRUCTION (base prompt)
// -------------------------------------------------------------
const BASE_SYSTEM_INSTRUCTION = `
You are "Ramanya," an expert AI translator specializing in the Mon language (ISO 639-3: mnw).
You have deep knowledge of Mon grammar, vocabulary, and cultural nuances.

### MON LANGUAGE PRIMER (STRICT RULES):
- Script: Use standard Myanmar script for Mon.
- Question: end with "ရော?" or "ဟာ?"
- Statement: end with "ရ။"
- Past: "တုဲ"
- Future: "ရောင်"
- Continuous: "မံင်"

### TRANSLATION INSTRUCTIONS:

IF INPUT IS ENGLISH:
1. Translate into formal, written Mon (Unicode).
2. Use polite, natural tone.

IF INPUT IS MON:
1. Translate into natural, fluent English.

You must always respond with valid JSON:
{
  "source_language": "English" | "Mon" | "...",
  "translation": "..."
}
`;

// -------------------------------------------------------------
// 7. TRANSLATE ENDPOINT with embedding search (Option A)
// -------------------------------------------------------------
app.post("/api/translate", async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Missing message" });
    }

    // 1) Compute embedding for user input
    const queryEmbedding = await embedText(message);

    // 2) Load approved suggestions + embeddings
    let relevantExamplesText = "";
    if (queryEmbedding) {
      const approved = await getApprovedSuggestionsWithEmbeddings();

      if (approved.length > 0) {
        // Compute similarity
        const scored = approved.map((item) => ({
          ...item,
          score: cosineSimilarity(queryEmbedding, item.embedding),
        }));

        // Sort by similarity
        scored.sort((a, b) => b.score - a.score);

        // Take top K examples
        const K = 5;
        const topK = scored.slice(0, K).filter((x) => x.score > 0.3); // small threshold

        if (topK.length > 0) {
          relevantExamplesText += "\n\n### RELEVANT USER-APPROVED EXAMPLES:\n";
          topK.forEach((item, idx) => {
            relevantExamplesText += `${idx + 1}. When the user input is "${item.original}", the correct translation must be "${item.suggestion}".`;
            if (item.context) {
              relevantExamplesText += ` Context: ${item.context}`;
            }
            relevantExamplesText += "\n";
          });
        }
      }
    }

    const finalInstruction = BASE_SYSTEM_INSTRUCTION + relevantExamplesText;

    // 3) Call Gemini with systemInstruction + user message
    const result = await ai.models.generateContent({
      model: "gemini-3-pro-preview",
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

    const rawText = result?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!rawText) {
      return res.status(500).json({ error: "Empty output from Gemini" });
    }

    // Try parsing JSON returned by model
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (err) {
      console.warn("⚠ JSON parse failed, returning raw text:", rawText);
      return res.json({
        source_language: "unknown",
        translation: rawText,
        romanization: null,
        notes: null,
      });
    }

    return res.json({
      source_language: parsed.source_language || "unknown",
      translation: parsed.translation || "",
      romanization: parsed.romanization ?? null,
      notes: parsed.notes ?? null,
    });
  } catch (error) {
    console.error("❌ Error in /api/translate:", error);
    return res.status(500).json({ error: "Translation failed" });
  }
});

// -------------------------------------------------------------
// 8. Optional: Admin endpoint to rebuild all embeddings
//    (Call it manually from Postman, protected by a simple token)
// -------------------------------------------------------------
app.post("/api/reindex-suggestions", async (req, res) => {
  const token = req.headers["x-admin-token"];
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ error: "Forbidden" });
  }

  try {
    const snapshot = await db
      .collection("suggestions")
      .where("status", "==", "approved")
      .get();

    let updatedCount = 0;

    for (const doc of snapshot.docs) {
      const data = doc.data();
      if (data.embedding && Array.isArray(data.embedding) && data.embedding.length > 0) {
        continue;
      }

      const emb = await embedText(data.original);
      if (emb) {
        await doc.ref.update({ embedding: emb });
        updatedCount++;
      }
    }

    return res.json({ ok: true, updatedCount });
  } catch (err) {
    console.error("❌ Error reindexing suggestions:", err);
    return res.status(500).json({ error: "Reindex failed" });
  }
});

// -------------------------------------------------------------
// 9. Health Check
// -------------------------------------------------------------
app.get("/", (req, res) => {
  res.send("Mon AI Server (Option A + embeddings) is running ✓");
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});

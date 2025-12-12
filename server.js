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
// 3. Firestore (Admin SDK)
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
// 4. Embedding Helpers
// -------------------------------------------------------------
async function embedText(text) {
  if (!text || !text.trim()) return null;

  const result = await ai.models.embedContent({
    model: "gemini-embedding-001",
    contents: text,
    config: { outputDimensionality: 256 },
  });

  const embedding = result?.embeddings?.[0]?.values;
  if (!embedding) return null;

  return embedding;
}

function dot(a, b) {
  let s = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) s += a[i] * b[i];
  return s;
}

function magnitude(v) {
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
}

function cosineSimilarity(a, b) {
  const ma = magnitude(a);
  const mb = magnitude(b);
  if (!ma || !mb) return 0;
  return dot(a, b) / (ma * mb);
}

// -------------------------------------------------------------
// 5. Load Approved Suggestions + Ensure Embeddings
// -------------------------------------------------------------
async function getApprovedSuggestionsWithEmbeddings() {
  const snapshot = await db.collection("suggestions_approved").get();

  const suggestions = [];

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const { original, suggestion, context = "" } = data;
    if (!original || !suggestion) continue;

    let embedding = data.embedding;

    if (!embedding || !Array.isArray(embedding) || embedding.length === 0) {
      try {
        embedding = await embedText(original);
        if (embedding) await doc.ref.update({ embedding });
      } catch (err) {
        console.error("⚠ Embedding failed:", err);
        continue;
      }
    }

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
// 6. Base System Instruction
// -------------------------------------------------------------
const BASE_SYSTEM_INSTRUCTION = `
You are "Ramanya," an expert English ↔ Mon translator.

### RULES:
- Use formal written Mon when translating English → Mon.
- Use natural fluent English when translating Mon → English.
- Use correct Mon particles: 
  - Statement: "ရ။"
  - Question: "ရော?" or "ဟာ?"
  - Past: "တုဲ"
  - Future: "ရောင်"
  - Continuous: "မံင်"

Always output in JSON:
{
  "source_language": "",
  "translation": ""
}
`;

// -------------------------------------------------------------
// 7. TRANSLATE ENDPOINT (Option A: Embedding Search)
// -------------------------------------------------------------
app.post("/api/translate", async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Missing message" });
    }

    const queryEmbedding = await embedText(message);

    let relevantExamplesText = "";
    if (queryEmbedding) {
      const approved = await getApprovedSuggestionsWithEmbeddings();

      const scored = approved.map((item) => ({
        ...item,
        score: cosineSimilarity(queryEmbedding, item.embedding),
      }));

      scored.sort((a, b) => b.score - a.score);

      const topK = scored.slice(0, 5).filter((x) => x.score > 0.3);

      if (topK.length > 0) {
        relevantExamplesText += "\n\n### RELEVANT USER EXAMPLES:\n";
        topK.forEach((item, idx) => {
          relevantExamplesText += `${idx + 1}. "${item.original}" → "${item.suggestion}"\n`;
        });
      }
    }

    const finalInstruction = BASE_SYSTEM_INSTRUCTION + relevantExamplesText;

    const result = await ai.models.generateContent({
      model: "gemini-3-pro-preview",
      contents: [{ role: "user", parts: [{ text: message }] }],
      config: {
        systemInstruction: finalInstruction,
        responseMimeType: "application/json",
      },
    });

    const rawText = result?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!rawText) return res.status(500).json({ error: "Empty output from Gemini" });

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = { source_language: "unknown", translation: rawText };
    }

    return res.json(parsed);
  } catch (error) {
    console.error("❌ Error in /api/translate:", error);
    return res.status(500).json({ error: "Translation failed" });
  }
});

// -------------------------------------------------------------
// 8. NEW: Save Suggestion from User
// -------------------------------------------------------------
app.post("/api/suggest", async (req, res) => {
  try {
    const { original, suggestion, context } = req.body;

    if (!original || !suggestion) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const newSuggestion = {
      original,
      suggestion,
      context: context || "",
      status: "pending",      // Admin must approve
      createdAt: Date.now(),
    };

    const ref = await db.collection("suggestions_pending").add(newSuggestion);

    return res.json({ ok: true, id: ref.id });
  } catch (err) {
    console.error("❌ Error saving suggestion:", err);
    return res.status(500).json({ error: "Failed to save suggestion" });
  }
});

// 9. Admin: Approve a suggestion
app.post("/api/approve-suggestion", async (req, res) => {
  try {
    const { id } = req.body;

    const docRef = db.collection("suggestions_pending").doc(id);
    const doc = await docRef.get();

    if (!doc.exists) return res.status(404).json({ error: "Not found" });

    const data = doc.data();

    await db.collection("suggestions_approved").add({
      ...data,
      status: "approved",
      approvedAt: Date.now(),
    });

    await docRef.delete();

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to approve suggestion" });
  }
});
// -------------------------------------------------------------
// 9. Health Check
// -------------------------------------------------------------
app.get("/", (req, res) => {
  res.send("Mon AI Server (Option A + Embeddings) Running ✓");
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`✅ Server running at port ${PORT}`);
});

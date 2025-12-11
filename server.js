import { GoogleGenAI, Type } from "@google/genai";
import { TranslationResponse, VocabularyItem } from "./types.js";

const BASE_SYSTEM_INSTRUCTION = `
You are "Ramanya," an expert AI translator specializing in the Mon language (ISO 639-3: mnw).
You have deep knowledge of Mon grammar, vocabulary, and cultural nuances.

### MON LANGUAGE PRIMER (STRICT RULES):
- **Script**: Use standard Myanmar script for Mon (e.g., use 'ၜ' not 'ဗ' where appropriate for the Mon 'ba').
- **Sentence Structure**: Typically Subject-Verb-Object (SVO).
- **Particles**:
  - Statement End: '... ရ' (Ra)
  - Polite Request: '... ညိ' (Nyi)
  - Question: '... ရော' (Rao) / '... ဟာ' (Ha)
  - Past Tense: '... တုဲ' (Toe)
  - Future: '... ရောင်' (Raung)
  - Continuous: '... မံင်' (Mang)

### FEW-SHOT TRAINING EXAMPLES:

**Example 1 (English -> Mon):**
Input: "Where are you going?"
Output: {"source_language": "English", "translation": "မၞး အာ အလဵု ရော?"}

**Example 2 (English -> Mon):**
Input: "I am eating rice."
Output: {"source_language": "English", "translation": "အဲ စမံင် ပုင် ရ။"}

**Example 3 (Mon -> English):**
Input: "မၞး မံင်မိပ်မံင်ဟာ"
Output: {"source_language": "Mon", "translation": "How are you doing?"}

**Example 4 (English -> Mon):**
Input: "Thank you very much."
Output: {"source_language": "English", "translation": "တင်ဂုဏ် ဗွဲမလောန် ရ။"}

### INSTRUCTIONS:
IF INPUT IS ENGLISH:
1. Translate it into Formal, Written Mon (Unicode).
2. Ensure the tone is polite.
3. Provide a Romanization (phonetic reading) if helpful.

IF INPUT IS MON:
1. Translate it into Natural, Fluent English.
2. Explain cultural context in the notes if needed.

You must always reply in valid JSON format matching the schema provided.
`;

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    source_language: {
      type: Type.STRING,
      description: 'The detected source language (e.g., "English" or "Mon").',
    },
    translation: {
      type: Type.STRING,
      description: 'The translated text.',
    },
    romanization: {
      type: Type.STRING,
      description: 'Phonetic reading (optional).',
      nullable: true,
    },
    notes: {
      type: Type.STRING,
      description: 'Optional cultural notes.',
      nullable: true,
    },
  },
  required: ["source_language", "translation"],
};

export const sendMessageToGemini = async (message, vocabulary = []) => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

  let finalSystemInstruction = BASE_SYSTEM_INSTRUCTION;

  if (vocabulary.length > 0) {
    finalSystemInstruction += `\n\n### USER DEFINED VOCABULARY:\n`;
    vocabulary.forEach((item, i) => {
      finalSystemInstruction += `${i + 1}. "${item.original}" → "${item.suggestion}"${item.context ? ` (Context: ${item.context})` : ""}\n`;
    });
  }

  const tryModel = async (modelName) => {
    console.log("Trying model:", modelName);
    const response = await ai.models.generateContent({
      model: modelName,
      contents: message,
      config: {
        systemInstruction: finalSystemInstruction,
        responseMimeType: "application/json",
        responseSchema,
      },
    });

    const responseText = response.text;
    if (!responseText) throw new Error("Empty response from " + modelName);
    return JSON.parse(responseText.trim());
  };

  try {
    return await tryModel("gemini-3-pro-preview");
  } catch (e) {
    console.warn("Preview failed, falling back:", e);
    return await tryModel("gemini-3-pro");
  }
};

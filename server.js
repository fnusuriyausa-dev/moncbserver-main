
// Use GoogleGenAI from @google/genai
import { GoogleGenAI, Type } from "@google/genai";
import { TranslationResponse, VocabularyItem } from "../types";

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

### FEW-SHOT TRAINING EXAMPLES (COPY THIS STYLE):

**Example 1 (English -> Mon):**
Input: "Where are you going?"
Output: {"source_language": "English", "translation": "မၞး အာ အလဵု ရော?"}

**Example 2 (English -> Mon):**
Input: "I am eating rice."
Output: {"source_language": "English", "translation": "အဲ စမံင် ပုင် ရ။"}

**Example 4 (English -> Mon):**
Input: "Thank you very much."
Output: {"source_language": "English", "translation": "တင်ဂုဏ် ဗွဲမလောန် ရ။"}

### INSTRUCTIONS:
IF INPUT IS ENGLISH:
1. Translate it into Formal, Written Mon (Unicode).
2. Ensure the tone is polite.

IF INPUT IS MON:
1. Translate it into Natural, Fluent English.

You must always reply in valid JSON format matching the schema provided. DO NOT provide notes or romanization unless specifically requested by context.
`;

export const sendMessageToGemini = async (
  message: string, 
  vocabulary: VocabularyItem[] = []
): Promise<TranslationResponse> => {
  // Initialize AI with apiKey from process.env.API_KEY
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  let finalSystemInstruction = BASE_SYSTEM_INSTRUCTION;
  
  if (vocabulary.length > 0) {
    finalSystemInstruction += `\n\n### USER DEFINED VOCABULARY:\n`;
    vocabulary.forEach((item, index) => {
      finalSystemInstruction += `${index + 1}. For "${item.original}", use "${item.suggestion}".${item.context ? ` Context: ${item.context}` : ''}\n`;
    });
  }

  const tryModel = async (modelName: string): Promise<TranslationResponse> => {
    console.debug(`Attempting translation with: ${modelName}`);
    // Use generateContent directly as per guidelines
    const response = await ai.models.generateContent({
      model: modelName,
      contents: message,
      config: {
        systemInstruction: finalSystemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            source_language: {
              type: Type.STRING,
              description: 'The language of the input text.',
            },
            translation: {
              type: Type.STRING,
              description: 'The translated text.',
            },
            romanization: {
              type: Type.STRING,
              description: 'Pronunciation guide for the translated text.',
            },
            notes: {
              type: Type.STRING,
              description: 'Cultural or grammatical notes.',
            },
          },
          required: ['source_language', 'translation'],
          propertyOrdering: ["source_language", "translation", "romanization", "notes"],
        },
      },
    });

    // Access response.text property directly
    const text = response.text;
    if (!text) throw new Error(`Empty response from model ${modelName}.`);
    
    return JSON.parse(text.trim()) as TranslationResponse;
  };

  // Use only recommended models as per guidelines
  const modelsToTry = ['gemini-2.5-pro', 'gemini-2.5-flash'];

  for (const model of modelsToTry) {
    try {
      return await tryModel(model);
    } catch (error) {
      console.warn(`Model '${model}' failed or is unavailable. Trying next fallback...`, error);
    }
  }

  throw new Error("Translation service is currently unavailable. Please try again later.");
};

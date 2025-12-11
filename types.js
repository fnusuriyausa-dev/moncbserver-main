export class TranslationResponse {
  /** @type {string} */
  source_language;

  /** @type {string} */
  translation;

  /** @type {string|null} */
  romanization;

  /** @type {string|null} */
  notes;
}

export class VocabularyItem {
  /** @type {string} */
  original;

  /** @type {string} */
  suggestion;

  /** @type {string|null} */
  context;
}

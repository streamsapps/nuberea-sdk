import { Type, type Static } from '@sinclair/typebox';
import { RestClient, apiBaseUrl, parseApiPayload, type ApiRequestOptions } from './http.js';

const text = Type.Union([Type.String(), Type.Null()]);
const id = Type.String({ minLength: 1 });
const lexicalScope = Type.Literal('lexical_meaning_not_token_sense');
export const StudyReferenceSchema = Type.Object({
  corpus: Type.Union([Type.Literal('greek'), Type.Literal('hebrew'), Type.Literal('lxx'), Type.Literal('latin')]),
  book: Type.String({ minLength: 1, maxLength: 40 }),
  chapter: Type.Integer({ minimum: 1, maximum: 150 }),
  verse: Type.Integer({ minimum: 1, maximum: 200 }),
}, { additionalProperties: false });
export type StudyReference = Static<typeof StudyReferenceSchema>;
export const GreekLexiconRequestSchema = Type.Union([
  Type.Object({ lemma: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false }),
  Type.Object({ strong: Type.String({ pattern: '^(?:[Gg])?0*[0-9]{1,5}[a-zA-Z]?$' }) }, { additionalProperties: false }),
]);
export type GreekLexiconRequest = Static<typeof GreekLexiconRequestSchema>;
export const SemanticDomainRequestSchema = Type.Object({
  code: Type.String({ pattern: '^[0-9]{3}(?:[0-9]{3})?$' }),
}, { additionalProperties: false });

export const UbsGreekMeaningSchema = Type.Object({
  lex_id: id, entry_id: id, base_form_id: id, lemma: Type.String(),
  strong_codes: Type.Array(Type.String()), parts_of_speech: Type.Array(Type.String()),
  entry_code: text, is_biblical_term: text,
  definition: Type.String(), definition_long: Type.String(), definition_short: Type.String(),
  glosses: Type.Array(Type.String()), domain_codes: Type.Array(Type.String()), domain_labels: Type.Array(Type.String()),
  subdomain_codes: Type.Array(Type.String()), subdomain_labels: Type.Array(Type.String()),
  valencies_json: text, collocations_json: text, synonyms_json: text, antonyms_json: text,
  comments: Type.String(), reference_count: Type.Integer({ minimum: 0 }),
  linkage_scope: lexicalScope, source_revision: Type.String(),
});
export type UbsGreekMeaning = Static<typeof UbsGreekMeaningSchema>;
const meaningArray = Type.Array(UbsGreekMeaningSchema, { maxItems: 1000 });
export const LsjEntrySchema = Type.Object({
  id, headword: Type.String(), definition_text: Type.String(),
  morph_forms: Type.Array(Type.String()), greek_forms: Type.Array(Type.String()), latin_forms: Type.Array(Type.String()),
});
export const StudyWordSchema = Type.Object({
  ref: id, word_position: Type.Integer({ minimum: 1, maximum: 500 }), token_id: id, text: Type.String(),
  lemma: text, strong: text, category: text, gloss: text, case: text, gender: text, number: text,
  tense: text, voice: text, mood: text, person: text, pos: text, morph: text, stem: text, type: text, state: text,
  gloss_en: text, gloss_source: text, gloss_source_revision: text, gloss_status: text, gloss_derivation_method: text,
  lexicon_entry_id: text, lexicon_headword: text, lexicon_pos: text,
  morphology: text, xpos: text, deprel: text, annotation_method: text, annotation_status: text,
  morphology_source: text, morphology_source_revision: text, morphology_confidence: text, morphology_reasoning: text,
  lexeme: Type.Optional(text), transliteration: Type.Optional(text),
  lexical_semantics: Type.Optional(Type.Object({
    dictionary: Type.Literal('ubs_greek'), match_method: Type.Literal('normalized_lemma'),
    status: Type.Union([Type.Literal('candidate_meanings_not_token_sense'), Type.Literal('no_lexical_meaning_found')]),
    candidate_lex_ids: Type.Array(Type.String()),
  })),
  lsj_semantics: Type.Optional(Type.Object({
    dictionary: Type.Literal('lsj'), match_method: Type.Literal('exact_lexeme'),
    status: Type.Union([Type.Literal('candidate_entries_not_token_sense'), Type.Literal('no_lexical_entry_found')]),
    candidate_entry_ids: Type.Array(Type.String()),
  })),
});
export const StudyTokenSchema = Type.Object({
  token_id: id, ref: id, source_ref: Type.String(), text: Type.String(), role: text, lemma: text, gloss: text,
  gloss_source: text, gloss_source_revision: text, gloss_status: text, gloss_derivation_method: text,
  lexicon_entry_id: text, lexicon_headword: text, lexicon_pos: text,
  token_in_verse: Type.Integer({ minimum: 1, maximum: 500 }), annotation_method: text, annotation_status: text,
});
export const StudyNodeSchema = Type.Recursive((self) => Type.Object({
  wg_id: id, class: text, role: text, rule: text, type: text, cltype: text,
  children: Type.Array(self), tokens: Type.Array(StudyTokenSchema),
}), { $id: 'StudyNode' });
export const VerseStudySchema = Type.Object({
  ...StudyReferenceSchema.properties,
  reference: Type.String(), words: Type.Array(StudyWordSchema, { maxItems: 500 }),
  syntax: Type.Array(Type.Object({
    sentence_id: id, book_id: Type.String(), sentence_index: Type.Integer({ minimum: 0 }),
    roots: Type.Array(StudyNodeSchema),
  })),
  attribution: Type.String({ minLength: 1 }),
  lexical_resource: Type.Optional(Type.Object({
    dictionary: Type.Literal('ubs_greek'), linkage_scope: lexicalScope,
    meanings: meaningArray, attribution: Type.String(),
  })),
  lsj_resource: Type.Optional(Type.Object({
    dictionary: Type.Literal('lsj'), linkage_scope: Type.Literal('lemma_entry_not_token_sense'),
    entries: Type.Array(LsjEntrySchema), attribution: Type.String(),
  })),
});
export type VerseStudy = Static<typeof VerseStudySchema>;
export const GreekLexiconStudySchema = Type.Object({
  language: Type.Literal('grc'), dictionary: Type.Literal('ubs_greek'), preferred: Type.Literal(true),
  query: Type.Object({ by: Type.Union([Type.Literal('lemma'), Type.Literal('strong')]), value: Type.String() }),
  meanings: meaningArray, linkage_scope: lexicalScope, attribution: Type.String({ minLength: 1 }),
});
export type GreekLexiconStudy = Static<typeof GreekLexiconStudySchema>;
export const GreekSemanticDomainStudySchema = Type.Object({
  language: Type.Literal('grc'), dictionary: Type.Literal('ubs_greek'),
  domain: Type.Object({
    code: SemanticDomainRequestSchema.properties.code, level: Type.Integer({ minimum: 0 }),
    prototype: Type.String(), reference: Type.String(), has_subdomains: Type.Boolean(), label: Type.String(),
    description: Type.String(), opposite: Type.String(), comment: Type.String(), localizations_json: text,
  }),
  meanings: meaningArray, linkage_scope: Type.Literal('lexical_domain_membership_not_token_sense'),
  attribution: Type.String({ minLength: 1 }),
});
export type GreekSemanticDomainStudy = Static<typeof GreekSemanticDomainStudySchema>;

export class StudyClient {
  private readonly rest: RestClient;
  constructor(getFirebaseIdToken: () => Promise<string>, base = 'https://mcp.nuberea.com', fetcher: typeof fetch = fetch) {
    this.rest = new RestClient(apiBaseUrl(base), getFirebaseIdToken, fetcher);
  }
  async verse(request: StudyReference, options: Pick<ApiRequestOptions, 'signal'> = {}): Promise<VerseStudy> {
    parseApiPayload(StudyReferenceSchema, request, 'study reference');
    const query = new URLSearchParams({
      corpus: request.corpus, book: request.book, chapter: String(request.chapter), verse: String(request.verse),
    });
    return parseApiPayload(VerseStudySchema, await this.rest.request('GET', `/v1/study/verse?${query}`, undefined, options), 'verse study');
  }
  async greekLexicon(request: GreekLexiconRequest, options: Pick<ApiRequestOptions, 'signal'> = {}): Promise<GreekLexiconStudy> {
    parseApiPayload(GreekLexiconRequestSchema, request, 'Greek lexicon query');
    const query = new URLSearchParams(request);
    return parseApiPayload(GreekLexiconStudySchema,
      await this.rest.request('GET', `/v1/study/lexicon/greek?${query}`, undefined, options), 'Greek lexicon study');
  }
  async greekSemanticDomain(code: string, options: Pick<ApiRequestOptions, 'signal'> = {}): Promise<GreekSemanticDomainStudy> {
    parseApiPayload(SemanticDomainRequestSchema, { code }, 'semantic domain query');
    return parseApiPayload(GreekSemanticDomainStudySchema,
      await this.rest.request('GET', `/v1/study/semantic-domain/greek?${new URLSearchParams({ code })}`, undefined, options), 'semantic domain study');
  }
}

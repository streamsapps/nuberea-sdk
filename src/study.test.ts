import { afterEach, describe, expect, it, vi } from 'vitest';
import { NuBerea } from './client.js';
import { StudyClient, StudyWordSchema } from './study.js';

const word = {
  ...Object.fromEntries(Object.keys(StudyWordSchema.properties).filter((key) =>
    !['lexical_semantics', 'lsj_semantics', 'lexeme', 'transliteration'].includes(key)).map((key) => [key, null])),
  ref: 'Gen 1:1!1', word_position: 1, token_id: 'morpheme-1', text: 'Fixture',
};
const verse = { corpus: 'hebrew', book: 'Gen', chapter: 1, verse: 1, reference: 'Genesis 1:1',
  words: [word, { ...word, token_id: 'morpheme-2' }], syntax: [], attribution: 'Source attribution' };
const lexicon = { language: 'grc', dictionary: 'ubs_greek', preferred: true,
  query: { by: 'lemma', value: 'λόγος' }, meanings: [], linkage_scope: 'lexical_meaning_not_token_sense', attribution: 'Source' };
const domain = { language: 'grc', dictionary: 'ubs_greek',
  domain: { code: '033', level: 0, prototype: '', reference: '', has_subdomains: false, label: 'Fixture',
    description: '', opposite: '', comment: '', localizations_json: null },
  meanings: [], linkage_scope: 'lexical_domain_membership_not_token_sense', attribution: 'Source' };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('native Study SDK', () => {
  it('calls the MCP-host Study routes with refreshed Firebase credentials, not the OAuth token, and preserves morphology identity', async () => {
    const responses = [verse, lexicon, domain];
    const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify(responses.shift())));
    vi.stubGlobal('fetch', fetcher);
    const token = vi.fn().mockResolvedValue('firebase');
    const client = new NuBerea({ accessToken: 'oauth', getFirebaseIdToken: token });
    const studied = await client.study.verse({ corpus: 'hebrew', book: 'Gen', chapter: 1, verse: 1 });
    expect(studied).toEqual(verse);
    expect(studied.words.map((entry) => entry.token_id)).toEqual(['morpheme-1', 'morpheme-2']);
    expect(await client.study.greekLexicon({ lemma: 'λόγος' })).toEqual(lexicon);
    expect(await client.study.greekSemanticDomain('033')).toEqual(domain);
    expect(fetcher.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      '/v1/study/verse', '/v1/study/lexicon/greek', '/v1/study/semantic-domain/greek',
    ]);
    expect(new URL(fetcher.mock.calls[1][0]).searchParams.get('lemma')).toBe('λόγος');
    for (const [url, init] of fetcher.mock.calls) {
      expect(new URL(url).origin).toBe('https://mcp.nuberea.com');
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer firebase');
      expect(init.method).toBe('GET');
    }
    expect(token).toHaveBeenCalledTimes(3);
  });

  it('rejects non-scalar, ambiguous or out-of-range queries before credentials and preserves server errors without defaults', async () => {
    const token = vi.fn().mockResolvedValue('firebase');
    const client = new StudyClient(token);
    await expect(client.verse({ corpus: 'greek', book: 'John', chapter: 1.5, verse: 1 })).rejects.toThrow('study reference');
    await expect(client.greekSemanticDomain('33')).rejects.toThrow('domain query');
    await expect(Reflect.apply(client.greekLexicon, client, [{ lemma: 'x', strong: 'G1' }])).rejects.toThrow('lexicon query');
    await expect(Reflect.apply(client.verse, client, [{ corpus: 'greek', book: ['John', 'Gen'], chapter: 1, verse: 1 }]))
      .rejects.toThrow('study reference');
    expect(token).not.toHaveBeenCalled();
    const denied = new StudyClient(token, undefined, async () => new Response(JSON.stringify({
      code: 'ENTITLEMENT_REQUIRED', message: 'Paid access required', details: [],
    }), { status: 403 }));
    await expect(denied.verse({ corpus: 'greek', book: 'John', chapter: 1, verse: 1 }))
      .rejects.toMatchObject({ code: 'ENTITLEMENT_REQUIRED', status: 403 });
  });

  it('rejects malformed or empty success bodies instead of manufacturing an empty study', async () => {
    for (const body of ['', JSON.stringify({ ...verse, attribution: undefined }), 'invalid-json']) {
      const client = new StudyClient(async () => 'firebase', undefined, async () => new Response(body));
      await expect(client.verse({ corpus: 'hebrew', book: 'Gen', chapter: 1, verse: 1 })).rejects.toThrow();
    }
  });
});

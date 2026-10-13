import { describe, expect, it } from 'bun:test';
import { acronymKeys, emailKeys, identityKeys, nameKeys, namePhrases, textReferences, urlKey, urlKeys } from '../lib/graph/identity-keys';
import { canonicalType, sameFamily, typeFamily } from '../lib/graph/ontology';

const weak = (label: string) => new Set([...nameKeys(label), ...acronymKeys(label)]);

describe('identity keys', () => {
  it('meets every spelling of an organization on one weak key', () => {
    for (const label of ['UWHPC', 'UW HPC', 'uw-hpc', 'University of Waterloo High Performance Computing',
      'UW HPC Club', 'University of Waterloo HPC Club'])
      expect(weak(label).has('uwhpc')).toBe(true);
    expect(weak('Waterloo Rocketry').has('uwhpc')).toBe(false);
    // A lone lower-case word is not treated as an abbreviation.
    expect(acronymKeys('app')).toEqual([]);
  });

  it('derives account and repository handles from URLs', () => {
    const keys = urlKeys('https://github.com/UWHPC/onboarding-template/blob/main/README.md?plain=1#intro');
    expect(keys).toContainEqual({ kind: 'github', value: 'uwhpc' });
    expect(keys).toContainEqual({ kind: 'github', value: 'uwhpc/onboarding-template' });
    expect(keys).toContainEqual({ kind: 'domain', value: 'github.com' });
    expect(urlKeys('https://github.com/orgs/UWHPC/people')).toContainEqual({ kind: 'github', value: 'uwhpc' });
    expect(urlKeys('https://github.com/settings/profile').some(key => key.kind === 'github')).toBe(false);
    expect(urlKeys('https://discord.com/channels/1478821155057176648/1536071229646053616'))
      .toContainEqual({ kind: 'discord-guild', value: '1478821155057176648' });
    expect(urlKeys('https://www.linkedin.com/company/uwhpc/')).toContainEqual({ kind: 'linkedin', value: 'company/uwhpc' });
  });

  it('normalizes URLs without losing identity-bearing parts', () => {
    expect(urlKey('https://www.Example.com/a/b/?utm_source=x#top')).toBe('example.com/a/b');
    expect(urlKey('https://GitHub.com/UWHPC/Repo/')).toBe('github.com/uwhpc/repo');
    expect(urlKey('https://www.youtube.com/watch?v=abc&t=10')).toBe('youtube.com/watch?v=abc');
    expect(urlKey('https://news.ycombinator.com/item?id=2&utm_source=x')).not.toBe(urlKey('https://news.ycombinator.com/item?id=1'));
    expect(urlKey('https://example.com/p?b=2&a=1&fbclid=z')).toBe('example.com/p?a=1&b=2');
    expect(urlKey('http://localhost:3000/ui')).not.toBe(urlKey('http://localhost:5173/ui'));
    expect(urlKey('https://example.com:443/x')).toBe('example.com/x');
    expect(urlKey('http://localhost:8080/ui/#/models/a')).not.toBe(urlKey('http://localhost:8080/ui/#/models/b'));
    expect(urlKey('http://localhost:8080/ui/')).toBe(urlKey('http://localhost:8080/ui'));
    expect(urlKey('mailto:a@b.c')).toBeNull();
  });

  it('keeps organization domains but not webmail domains', () => {
    expect(emailKeys('Recruiting@Mail.UWHPC.ca')).toEqual([{ kind: 'email', value: 'recruiting@mail.uwhpc.ca' },
      { kind: 'email-domain', value: 'uwhpc.ca' }]);
    expect(emailKeys('someone@gmail.com')).toEqual([{ kind: 'email', value: 'someone@gmail.com' }]);
    expect(emailKeys('not an address')).toEqual([]);
  });

  it('combines and deduplicates keys and finds references in text', () => {
    const keys = identityKeys({ names: ['UWHPC', 'UW HPC'], urls: ['https://github.com/UWHPC'], external: [{ authority: 'discord', id: '1' }] });
    expect(keys.filter(key => key.kind === 'name' && key.value === 'uwhpc')).toHaveLength(1);
    expect(keys).toContainEqual({ kind: 'external', value: 'discord:1' });
    expect(textReferences('See https://github.com/UWHPC/onboarding-template. Mail hpc@uwaterloo.ca!'))
      .toEqual({ urls: ['https://github.com/UWHPC/onboarding-template'], emails: ['hpc@uwaterloo.ca'] });
  });
});

it('finds name-like phrases for weak key lookups', () => {
  const phrases = namePhrases('Interview invitation from the UW HPC club at the University of Waterloo.');
  expect(phrases).toContain('UW HPC');
  expect(phrases.some(phrase => nameKeys(phrase).includes('uwhpc'))).toBe(true);
  expect(phrases).toContain('University of Waterloo');
});

describe('ontology', () => {
  it('maps free-text model types into canonical families', () => {
    expect(canonicalType('club')).toBe('Organization');
    expect(canonicalType('Internship')).toBe('Opportunity');
    expect(canonicalType('GitHub repository')).toBe('Artifact');
    expect(canonicalType('Web Resource')).toBe('Artifact');
    expect(canonicalType('Something odd')).toBe('Concept');
    expect(typeFamily('Topic')).toBe('Concept');
    expect(sameFamily('Bot', 'Person')).toBe(true);
    expect(sameFamily('Server', 'Organization')).toBe(false);
  });
});

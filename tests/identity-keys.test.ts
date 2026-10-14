import { describe, expect, it } from 'bun:test';
import { acronymKeys, emailKeys, fullNameKey, identityKeys, nameKeys, namePhrases, textReferences, urlKey, urlKeys } from '../lib/graph/identity-keys';
import { canonicalType, sameFamily, typeFamily } from '../lib/graph/ontology';

const weak = (label: string) => new Set([...nameKeys(label), ...acronymKeys(label)]);

describe('identity keys', () => {
  it('meets every spelling of an organization on one weak key', () => {
    for (const label of ['NHPC', 'NH PC', 'nh-pc', 'Northbridge High Performance Computing',
      'NH PC Club', 'Northbridge High PC Club'])
      expect(weak(label).has('nhpc')).toBe(true);
    expect(weak('Northbridge Rocketry').has('nhpc')).toBe(false);
    // A lone lower-case word is not treated as an abbreviation.
    expect(acronymKeys('app')).toEqual([]);
  });

  it('keys exact names without dropping distinguishing words', () => {
    for (const label of ['Global Politics', 'global-politics', 'GLOBAL  POLITICS', 'Glóbal Politics'])
      expect(fullNameKey(label)).toBe('globalpolitics');
    expect(fullNameKey('Cloudflare Community')).not.toBe(fullNameKey('Cloudflare'));
    expect(fullNameKey('-')).toBeNull();
  });

  it('derives account and repository handles from URLs', () => {
    const keys = urlKeys('https://github.com/NHPC/onboarding-template/blob/main/README.md?plain=1#intro');
    expect(keys).toContainEqual({ kind: 'github', value: 'nhpc' });
    expect(keys).toContainEqual({ kind: 'github', value: 'nhpc/onboarding-template' });
    expect(keys).toContainEqual({ kind: 'domain', value: 'github.com' });
    expect(urlKeys('https://github.com/orgs/NHPC/people')).toContainEqual({ kind: 'github', value: 'nhpc' });
    expect(urlKeys('https://github.com/settings/profile').some(key => key.kind === 'github')).toBe(false);
    expect(urlKeys('https://discord.com/channels/1000000000000000001/1000000000000000002'))
      .toContainEqual({ kind: 'discord-guild', value: '1000000000000000001' });
    expect(urlKeys('https://www.linkedin.com/company/nhpc/')).toContainEqual({ kind: 'linkedin', value: 'company/nhpc' });
  });

  it('normalizes URLs without losing identity-bearing parts', () => {
    expect(urlKey('https://www.Example.com/a/b/?utm_source=x#top')).toBe('example.com/a/b');
    expect(urlKey('https://GitHub.com/NHPC/Repo/')).toBe('github.com/nhpc/repo');
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
    expect(emailKeys('Recruiting@Mail.NHPC.ca')).toEqual([{ kind: 'email', value: 'recruiting@mail.nhpc.ca' },
      { kind: 'email-domain', value: 'nhpc.ca' }]);
    expect(emailKeys('someone@gmail.com')).toEqual([{ kind: 'email', value: 'someone@gmail.com' }]);
    expect(emailKeys('not an address')).toEqual([]);
  });

  it('combines and deduplicates keys and finds references in text', () => {
    const keys = identityKeys({ names: ['NHPC', 'NH PC'], urls: ['https://github.com/NHPC'], external: [{ authority: 'discord', id: '1' }] });
    expect(keys.filter(key => key.kind === 'name' && key.value === 'nhpc')).toHaveLength(1);
    expect(keys).toContainEqual({ kind: 'external', value: 'discord:1' });
    expect(textReferences('See https://github.com/NHPC/onboarding-template. Mail hpc@northbridge.example.test!'))
      .toEqual({ urls: ['https://github.com/NHPC/onboarding-template'], emails: ['hpc@northbridge.example.test'] });
  });
});

it('finds name-like phrases for weak key lookups', () => {
  const phrases = namePhrases('Interview invitation from the NH PC club at the Northbridge.');
  expect(phrases).toContain('NH PC');
  expect(phrases.some(phrase => nameKeys(phrase).includes('nhpc'))).toBe(true);
  expect(phrases).toContain('Northbridge');
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

import { TIERS } from "./policy";

/** Tier indexes: 0 public, 1 personal, 2 private, 3 secret. */
export interface Classification {
  tier: number;
  /** Credentials, financial identifiers, and private email: the LLM may not lower these. */
  hard: boolean;
  reason: string;
}

const PERSONAL = 1, PRIVATE = 2, SECRET = 3;

const HARD_PATTERNS: Array<[RegExp, number, string]> = [
  [/-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/, SECRET, "private key"],
  [/\b(?:sk|rk)-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{20,}/, SECRET, "API key"],
  [/\bAKIA[0-9A-Z]{16}\b/, SECRET, "AWS access key"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, SECRET, "GitHub token"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, SECRET, "Slack token"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, SECRET, "Google API key"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, SECRET, "access token"],
  [/\b(?:password|passwd|passcode|passphrase|pwd)\s*[:=]\s*\S{4,}/i, SECRET, "password"],
  [/\b(?:secret|api[_ -]?key|access[_ -]?token|auth[_ -]?token|client[_ -]?secret)\s*[:=]\s*["']?[A-Za-z0-9_\-./+=]{12,}/i, SECRET, "credential"],
  [/\b(?:ssn|social security(?: number)?)\D{0,12}\d{3}-?\d{2}-?\d{4}\b/i, SECRET, "social security number"],
  [/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/, PRIVATE, "bank account number (IBAN)"],
  [/\b(?:routing|account)\s*(?:number|no\.?|#)\s*[:=]?\s*\d{6,17}\b/i, PRIVATE, "bank account number"],
  [/\b(?:passport|driver'?s? licen[cs]e)\s*(?:number|no\.?|#)\s*[:=]?\s*[A-Z0-9]{6,12}\b/i, PRIVATE, "identity document number"],
];

const SOFT_PATTERNS: Array<[RegExp, string]> = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "email address"],
  [/(?:\+\d{1,3}[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, "phone number"],
  [/\b\d{1,5}\s+(?:[A-Z][a-z]+\s){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace)\b\.?/g, "street address"],
  [/\b(?:date of birth|DOB|born on)\b/gi, "date of birth"],
];

const SENSITIVE_TOPICS: Record<string, RegExp> = {
  health: /\b(?:diagnos[ie]s|diagnosed|prescri(?:bed|ption)|medication|dosage|symptoms?|therap(?:y|ist)|psychiatr\w*|depress(?:ion|ed)|anxiety|disorder|illness|disease|surgery|hospitali[sz]ed|pregnan(?:t|cy)|miscarriage|HIV|STI|STD|chemotherapy|cancer|mental health|blood test|lab results)\b/gi,
  finance: /\b(?:salary|paycheck|net worth|bank balance|account balance|mortgage|debt|loan|credit score|tax return|bankrupt\w*|overdraft|wire transfer|invoice total)\b/gi,
  legal: /\b(?:lawsuit|arrest(?:ed)?|criminal record|convicted|probation|court case|subpoena|divorce|custody|immigration status|visa status)\b/gi,
  intimate: /\b(?:sexual|sex life|hookup|nudes?|affair|cheating on|breakup|broke up|dating app)\b/gi,
};

const PRIVATE_URI = /^(?:https?:\/\/)?(?:[^/]*\.)?(?:mail\.google\.com|outlook\.(?:live|office)\.com|mail\.yahoo\.com|proton\.me|mail\.proton\.me|[^/]*bank[^/]*|paypal\.com|venmo\.com|wise\.com|revolut\.com|chase\.com|wellsfargo\.com|mychart\.[^/]+|[^/]*patient[^/]*|[^/]*health[^/]*portal[^/]*)(?:[/:?#]|$)/i;
const DIRECT_MESSAGE = /(?:^|[/:._-])(?:dm|dms|direct|direct_messages?|inbox|private_messages?)(?:$|[/:._-])/i;

function luhn(digits: string) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

function cardNumber(text: string) {
  for (const match of text.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const digits = match[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && !/^(\d)\1+$/.test(digits) && luhn(digits)) return true;
  }
  return false;
}

/** Scan text for credentials, identifiers, PII, and sensitive topics. Returns tier 0 when nothing is found. */
export function classifyText(text: string): Classification {
  let tier = 0, hard = false;
  const reasons: string[] = [];
  const raise = (to: number, reason: string, isHard = false) => {
    if (isHard) hard = true;
    if (to > tier) tier = to;
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  for (const [pattern, to, reason] of HARD_PATTERNS) if (pattern.test(text)) raise(to, reason, true);
  if (cardNumber(text)) raise(SECRET, "payment card number", true);
  const softHits: string[] = [];
  for (const [pattern, reason] of SOFT_PATTERNS) {
    const count = text.match(pattern)?.length ?? 0;
    if (count) softHits.push(reason);
    // A few contact details are common on public pages; many, or a home address, mark personal records.
    if (reason === "street address" || reason === "date of birth") { if (count) raise(PRIVATE, reason); }
    else if (count >= 3) raise(PRIVATE, `${reason}s`);
    else if (count) raise(PERSONAL, reason);
  }
  for (const [topic, pattern] of Object.entries(SENSITIVE_TOPICS)) {
    const distinct = new Set((text.match(pattern) ?? []).map(m => m.toLowerCase()));
    if (distinct.size >= 2) raise(PRIVATE, `${topic} details`);
    else if (distinct.size === 1) raise(PERSONAL, `${topic} mention`);
  }
  return { tier, hard, reason: reasons.join(", ") || "no sensitive content detected" };
}

export function maxClassification(...items: Classification[]): Classification {
  const tier = Math.max(...items.map(i => i.tier));
  const hard = items.some(i => i.hard);
  const reason = items.filter(i => i.tier > 0).map(i => i.reason).join("; ") || "no sensitive content detected";
  return { tier, hard, reason };
}

export function classifySource(source: { title: string; uri: string; origin: string; type: string; text: string }): Classification {
  const parts: Classification[] = [classifyText(`${source.title}\n${source.text}`)];
  if (source.origin === "email") parts.push({ tier: PRIVATE, hard: true, reason: "private email" });
  if (PRIVATE_URI.test(source.uri)) parts.push({ tier: PRIVATE, hard: false, reason: "private web service" });
  if (DIRECT_MESSAGE.test(source.uri) || DIRECT_MESSAGE.test(source.type)) parts.push({ tier: PRIVATE, hard: false, reason: "direct messages" });
  return maxClassification(...parts);
}

const SENSITIVE_TYPES = /^(?:medical|health|diagnosis|medication|condition|symptom|bankaccount|account|password|credential|secret|address|phonenumber|email)/i;

export function classifyEntity(entity: { name: string; type: string }): Classification {
  const result = classifyText(entity.name);
  if (SENSITIVE_TYPES.test(entity.type.replace(/[\s_-]/g, "")))
    return maxClassification(result, { tier: PRIVATE, hard: false, reason: `${entity.type} entity` });
  return result;
}

export function classifyClaim(claim: { predicate: string; value: string | null; qualifiers: string; context: string }): Classification {
  const predicate = claim.predicate.replace(/[_-]+/g, " ").toLowerCase();
  return classifyText(`${predicate}\n${claim.value ?? ""}\n${claim.qualifiers === "{}" ? "" : claim.qualifiers}\n${claim.context}`);
}

export function tierName(index: number) {
  return TIERS[Math.max(0, Math.min(TIERS.length - 1, index))]!;
}

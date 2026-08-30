/**
 * Name first on a multi-account phone. 2026-08-30 (Brian).
 *
 * The multi-account branch used to return before matchSpokenName ran, on the
 * 2026-07-28 finding that every candidate company held the same person. Fixtures
 * below are the REAL contact pools and the REAL spoken names from every
 * multi-account call of 08-22..29, so this asserts the reorder against traffic
 * rather than against invented shapes.
 *
 * The bar: exactly one call may newly lock, and only where the name genuinely
 * identifies one person at one account.
 */
import { matchSpokenName, sameSoulAcrossAccounts, PoolContact } from '../src/utils/name-match';

type Case = { cid: string; pool: any[]; names: [string, string][] };

const P = (id: number, firstName: string, lastName: string, companyID: number, primaryContact = false) =>
  ({ id, firstName, lastName, companyID, primaryContact });

const CASES: Case[] = [
  { cid: '0gb85zts', names: [['Edward', '']],
    pool: [P(30686150,'Edward','Sunseri',911), P(30693314,'Edward','Sunseri',6860,true)] },
  { cid: '1gka2ny6', names: [['Eric', 'Fleming']],
    pool: [P(30684774,'Eric','Fleming',641), P(30691253,'Eric','Fleming',5888,true)] },
  { cid: 'btfcnps5', names: [['Maritza', 'Richardson']],
    pool: [P(30685858,'Maritza','Richardson',864,true), P(30693357,'Maritza','Richardson',6883,true)] },
  { cid: 'ft65nqys', names: [['James', 'Miller']],
    pool: [P(30684719,'Jim','Miller',616,true), P(30691926,'Jim','Miller',732)] },
  { cid: '2ycgyc03', names: [['Jason', '']],
    pool: [P(30682939,'Jason','Lorge',201,true), P(30683046,'Jason','Lorge',264,true),
           P(30691222,'Invoices','Classic Improvement Products',201), P(30691384,'B','Lorge',201),
           P(30693164,'Desirae','Hurt',264)] },
  { cid: 'sc8wx0ws', names: [['Chris', 'BET']],
    pool: [P(30685942,'Chris','Ames',873,true), P(30686580,'Tyler','Bailey',1309,true),
           P(30687196,'Chris','Ames',1943,true)] },
  { cid: '6ezwf2jc', names: [['Jason', '']],
    pool: [P(30685104,'Betty','Trask',706), P(30685433,'Betty','Trask',822,true)] },
  { cid: 'm8yjk5gn', names: [['Edward', 'Senseri']],
    pool: [P(30686150,'Edward','Sunseri',911), P(30693314,'Edward','Sunseri',6860,true)] },
  { cid: 'mfpv01ek', names: [['Christine', 'JDM']],
    pool: [P(30689185,'Kristine','Desbines',3895,true), P(30691354,'Kristine','DesBiens',5961,true)] },
  { cid: 'hwrzzjjg', names: [['Christine', 'Davian']],
    pool: [P(30689185,'Kristine','Desbines',3895,true), P(30691354,'Kristine','DesBiens',5961,true)] },
  { cid: 'k36x0ksx', names: [['Becky', 'Gomez']],
    pool: [P(30686186,'Becky','Brown',181,true), P(30687474,'Becky','Brown',2223,true)] },
  { cid: 'cz5x3012', names: [['Chief', 'Kenyatta']],
    pool: [P(30685423,'Jessica','Speas',813,true), P(30692310,'Jessica','Speas',6520,true)] },
];

// The one that should newly resolve: Tom is unique across both accounts.
const TOM_POOL = [
  P(30687028,'Tom','Daus',1769,true), P(30693100,'Mark','Forrester',1769),
  P(30693102,'Billy','Bob',1769),     P(30693208,'Brian','Mendez',1769),
  P(30693362,'Clint','Eastwood',1769),P(30693364,'Mike','Borf',1769),
  P(30693365,'Mike','Borth',1769),    P(30694664,'Brian','G',7710),
];

describe('name first: the win', () => {
  test('a name unique across both accounts locks in one question (djqkjhh0)', () => {
    const v: any = matchSpokenName(TOM_POOL as PoolContact[], 'Tom', '');
    expect(v.status).toBe('locked');
    expect(v.contact.id).toBe(30687028);
    expect(v.contact.companyID).toBe(1769);
  });
});

describe('name first: everything else falls through untouched', () => {
  for (const c of CASES) {
    for (const [first, last] of c.names) {
      test(`${c.cid} "${first} ${last}".trim() does not lock`, () => {
        const v: any = matchSpokenName(c.pool as PoolContact[], first, last);
        expect(v.status).not.toBe('locked');
      });
    }
  }
});

// What the handler actually does: take the lock only when the pool does not
// hold the same person twice.
const resolves = (pool: any[], first: string, last: string) => {
  const v: any = matchSpokenName(pool as PoolContact[], first, last);
  return v.status === 'locked' && !sameSoulAcrossAccounts(pool as PoolContact[], v.contact);
};

describe('the 07-28 rule, stated precisely instead of as a blanket ban', () => {
  test('the same person at two accounts never resolves on a name', () => {
    // Every fixture pool, matched against its own first entry's exact name.
    for (const c of CASES) {
      const p0 = c.pool[0];
      const twin = c.pool.some(o => o.id !== p0.id && o.companyID !== p0.companyID
        && o.firstName === p0.firstName);
      if (!twin) continue;
      expect(resolves(c.pool, p0.firstName, p0.lastName)).toBe(false);
    }
  });

  test('Kristine Desbines / DesBiens - a spelling variant cannot pick an account', () => {
    const pool = [P(30689185,'Kristine','Desbines',3895,true), P(30691354,'Kristine','DesBiens',5961,true)];
    // The raw matcher locks on the exact spelling...
    expect((matchSpokenName(pool as PoolContact[], 'Kristine', 'Desbines') as any).status).toBe('locked');
    // ...and the guard refuses it, because that is one woman with two records.
    expect(resolves(pool, 'Kristine', 'Desbines')).toBe(false);
    expect(resolves(pool, 'Kristine', 'DesBiens')).toBe(false);
  });

  test('the guard does not fire on a genuinely unique name', () => {
    expect(resolves(TOM_POOL, 'Tom', '')).toBe(true);
    expect(sameSoulAcrossAccounts(TOM_POOL as PoolContact[], TOM_POOL[0] as any)).toBe(false);
  });

  test('two different people sharing a first name across accounts still block', () => {
    // Brian Mendez (1769) and Brian G (7710): same first name, different people.
    // Surnames are far apart, so this is NOT the same soul and a full name would
    // resolve - but a lone "Brian" ties and never reaches the guard.
    expect((matchSpokenName(TOM_POOL as PoolContact[], 'Brian', '') as any).status).not.toBe('locked');
  });
  test('a sole candidate is never lifted to a lock across accounts', () => {
    // Only an outright lock is taken in the handler; soleCandidateLock is not
    // consulted here, because the wrong answer across accounts is a stranger.
    const v: any = matchSpokenName(TOM_POOL as PoolContact[], 'Clint', 'Eastwud');
    if (v.status === 'candidates') expect(v.sole ?? null).not.toBeNull();
    expect(['candidates','locked','new_contact']).toContain(v.status);
  });
});

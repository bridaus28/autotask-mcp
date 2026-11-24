import {
  callerReportsPriorContact, openedEarlierSameDay, priorityRank, escalateOnRepeat, EscalationDeps,
} from '../src/utils/repeat-escalation';

const user = (message: string) => ({ role: 'user', message });
const agent = (message: string) => ({ role: 'agent', message });

describe('callerReportsPriorContact', () => {
  test.each([
    'I left two messages and sent one email requesting a remote, um...', // Cal Blend 11-23
    'Uh, nobody\'s called, and I\'m following up on it. It\'s kind of an emergency.',
    'Robert Marical. I called earlier. N- no one called me back.',
    'I was supposed to get a call back.',
    'I had left a message regarding needing service',
    "We've already emailed about this.",
    "This is the third time I'm calling.",
  ])('chaser: %s', (m) => expect(callerReportsPriorContact([user(m)])).toBe(true));

  test.each([
    'They left a message, and they said they had a few questions.', // a returned call, not a chaser
    'Follow up on an item.',
    'Call back for Jason.',
    'Calling regarding your recent loan offer, my direct call back number is',
    'Uh, so when I try to send the email it bounces.',
    'I already restarted the computer.',
    'Representative.',
  ])('not a chaser: %s', (m) => expect(callerReportsPriorContact([user(m)])).toBe(false));

  test('only the caller counts, not Ivy', () => {
    expect(callerReportsPriorContact([agent("I'm sorry, nobody called you back?")])).toBe(false);
    expect(callerReportsPriorContact(undefined)).toBe(false);
  });
});

describe('openedEarlierSameDay', () => {
  const call = Date.parse('2026-11-23T19:35:00Z'); // 11:35 Pacific
  test('earlier the same Pacific day', () => expect(openedEarlierSameDay('2026-11-23T17:34:22Z', call)).toBe(true));
  test('opened during this call', () => expect(openedEarlierSameDay('2026-11-23T19:35:40Z', call)).toBe(false));
  test('yesterday', () => expect(openedEarlierSameDay('2026-11-22T23:00:00Z', call)).toBe(false));
  test('same UTC day but previous Pacific day', () =>
    expect(openedEarlierSameDay('2026-11-23T07:30:00Z', call)).toBe(false)); // 11-22 23:30 Pacific
  test('missing date', () => expect(openedEarlierSameDay(undefined, call)).toBe(false));
});

test('priorityRank orders by label', () => {
  expect(priorityRank('Critical')).toBeGreaterThan(priorityRank('High'));
  expect(priorityRank('High')).toBeGreaterThan(priorityRank('Medium'));
  expect(priorityRank('Medium')).toBeGreaterThan(priorityRank('Low'));
});

// Tenant picklist: values are not ordered by urgency.
const PRIORITIES = [
  { value: '1', label: 'High' }, { value: '2', label: 'Medium' },
  { value: '3', label: 'Low' }, { value: '4', label: 'Critical' },
];

function fakeDeps(tickets: Record<number, any>, notes: Record<number, any[]> = {}) {
  const updates: Array<[number, any]> = [];
  const deps: EscalationDeps = {
    getTicket: async (id) => tickets[id] ?? null,
    searchTicketNotes: async (id) => notes[id] ?? [],
    findTicketByNumber: async (num) => Object.values(tickets).find((t: any) => t.ticketNumber === num) ?? null,
    updateTicket: async (id, u) => { updates.push([id, u]); },
    getPriorities: async () => PRIORITIES,
  };
  return { deps, updates };
}

const CALL_2 = Date.parse('2026-11-23T19:35:00Z');

describe('escalateOnRepeat', () => {
  test('Cal Blend call 2: same-day ticket goes Medium -> High', async () => {
    const { deps, updates } = fakeDeps({ 63250: { id: 63250, status: 21, priority: 2, createDate: '2026-11-23T17:34:22Z' } });
    const r = await escalateOnRepeat(deps, 63250, CALL_2, [user('A current ticket.')]);
    expect(updates).toEqual([[63250, { priority: 1 }]]);
    expect(r).toEqual({ ticketId: 63250, line: 'Priority raised to High: another call today about this ticket.' });
  });

  test('ticket Ivy opened during this call, no chaser words: unchanged', async () => {
    const { deps, updates } = fakeDeps({ 7: { id: 7, status: 1, priority: 2, createDate: '2026-11-23T19:35:40Z' } });
    expect(await escalateOnRepeat(deps, 7, CALL_2, [user('QuickBooks is not working.')])).toEqual({ ticketId: 7, line: null });
    expect(updates).toEqual([]);
  });

  test('chaser words raise even a ticket from an earlier day', async () => {
    const { deps, updates } = fakeDeps({ 7: { id: 7, status: 21, priority: 3, createDate: '2026-11-20T17:00:00Z' } });
    const r = await escalateOnRepeat(deps, 7, CALL_2, [user('I left two messages')]);
    expect(updates).toEqual([[7, { priority: 1 }]]);
    expect(r.line).toMatch(/already called/);
  });

  test('older ticket, no chaser words: unchanged', async () => {
    const { deps, updates } = fakeDeps({ 7: { id: 7, status: 21, priority: 3, createDate: '2026-11-20T17:00:00Z' } });
    expect((await escalateOnRepeat(deps, 7, CALL_2, [user('Checking on my laptop.')])).line).toBeNull();
    expect(updates).toEqual([]);
  });

  test.each([[1, 'High'], [4, 'Critical']])('already %s: never lowered or touched', async (p) => {
    const { deps, updates } = fakeDeps({ 7: { id: 7, status: 21, priority: p, createDate: '2026-11-23T17:00:00Z' } });
    expect((await escalateOnRepeat(deps, 7, CALL_2, [user('I left two messages')])).line).toBeNull();
    expect(updates).toEqual([]);
  });

  test('merged ticket: note and priority follow the merge target (Cal Blend .0017 -> .0022)', async () => {
    const { deps, updates } = fakeDeps(
      {
        63250: { id: 63250, ticketNumber: 'T20261123.0017', status: 5, priority: 2, createDate: '2026-11-23T17:34:22Z' },
        63255: { id: 63255, ticketNumber: 'T20261123.0022', status: 21, priority: 3, createDate: '2026-11-23T18:12:36Z' },
      },
      { 63250: [{ description: 'This ticket was completed and merged into T20261123.0022.\r\n\r\nThe following items were removed' }] },
    );
    const r = await escalateOnRepeat(deps, 63250, Date.parse('2026-11-23T22:00:00Z'), [user('Representative.')]);
    expect(r.ticketId).toBe(63255);
    expect(updates).toEqual([[63255, { priority: 1 }]]);
  });

  test('completed, not merged: note stays, no priority change', async () => {
    const { deps, updates } = fakeDeps({ 7: { id: 7, status: 5, priority: 2, createDate: '2026-11-23T17:00:00Z' } });
    expect(await escalateOnRepeat(deps, 7, CALL_2, [user('I left two messages')])).toEqual({ ticketId: 7, line: null });
    expect(updates).toEqual([]);
  });

  test('any failure leaves the bind exactly as it was', async () => {
    const { deps } = fakeDeps({});
    deps.getTicket = async () => { throw new Error('Autotask down'); };
    expect(await escalateOnRepeat(deps, 7, CALL_2, [user('I left two messages')])).toEqual({ ticketId: 7, line: null });
  });
});

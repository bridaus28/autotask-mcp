/**
 * Transfer gate on the available path (patch 0009, 2026-08-21).
 *
 * Incident: conv_6001...hy3k5 16:05 — "Hina, please" -> spell-ask ->
 * target-or-self -> Tina available -> transferred in 46s with NO caller name
 * and NO reason. Rule 52 (prompt) requires both, but the available-path
 * guidance said only "say: Connecting you now" — the text in her hand at the
 * moment of decision beat the rule at the top of the call. The gate must
 * live in the moment-of-action text too.
 */
jest.mock('autotask-node', () => ({
  AutotaskClient: { create: jest.fn().mockRejectedValue(new Error('Mock: no live API in tests')) }
}));

import { AutotaskToolHandler } from '../src/handlers/tool.handler';

function makeHandler(available: boolean) {
  const service: any = {
    async searchResources() {
      return [{ firstName: 'Tina', lastName: 'Robinson', title: 'Director of Finance', officeExtension: '1002', isActive: true }];
    },
    async getBusinessStatus() { return { business_status: 'open', next_open_text: '' }; },
    testConnection: async () => true,
  };
  const handler = new AutotaskToolHandler(service, { info(){}, warn(){}, error(){}, debug(){} } as any);
  (handler as any).getMappingService = async () => ({ getCompanyName: async () => null, getResourceName: async () => null });
  // presence-service stubbed at fetch level
  process.env.PRESENCE_SERVICE_TOKEN = 'test-token';
  (global as any).fetch = jest.fn(async () => ({ ok: true, json: async () => ({ available }) }));
  return handler;
}

const text = (r: any) => r.content.map((c: any) => c.text).join('');

describe('available path carries the transfer gate', () => {
  it('gate sentence precedes the connect line', async () => {
    const h = makeHandler(true);
    const out = text(await h.callTool('autotask_lookup_tech_status', { searchTerm: 'Tina' }));
    const gate = out.indexOf("caller's own name and a one-line reason");
    const connect = out.indexOf('Connecting you to Tina Robinson now');
    expect(gate).toBeGreaterThan(-1);
    expect(connect).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(connect);
  });

  it('already-given clause prevents re-interrogation of a caller who led with both', async () => {
    const h = makeHandler(true);
    const out = text(await h.callTool('autotask_lookup_tech_status', { searchTerm: 'Tina' }));
    expect(out).toContain('when the call has already given them, go');
  });

  it('affirmative-only lint on the whole response', async () => {
    const h = makeHandler(true);
    const out = text(await h.callTool('autotask_lookup_tech_status', { searchTerm: 'Tina' }));
    expect(out).not.toMatch(/do not|don't|never/i);
  });

  it('not_available guidance unchanged — message-or-queue offer stands as deployed in 0007', async () => {
    const h = makeHandler(false);
    const out = text(await h.callTool('autotask_lookup_tech_status', { searchTerm: 'Tina' }));
    expect(out).toContain("isn't available right now");
    expect(out).toContain('A message is one thing to the caller');
    expect(out).not.toContain('one-line reason first');
  });

  it('fuzzy match keeps confirm-first AFTER the gate, before the connect line', async () => {
    const h = makeHandler(true);
    const out = text(await h.callTool('autotask_lookup_tech_status', { searchTerm: 'Teena' }));
    const gate = out.indexOf('one-line reason first');
    const confirm = out.indexOf("You're looking to reach Tina Robinson, correct?");
    const connect = out.indexOf('Connecting you to Tina Robinson now');
    expect(gate).toBeGreaterThan(-1);
    expect(confirm).toBeGreaterThan(gate);
    expect(connect).toBeGreaterThan(confirm);
  });
});

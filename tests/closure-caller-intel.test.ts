// B1: carrier-lookup intel lands in closure artifacts (2026-08-16).
// The description builder and unidentified title are inline in the /call-closure
// handler, so these tests exercise the same formatting decisions as pure logic:
// present fields render, absent fields leave no empty labels behind.

const buildIntelLines = (dv: Record<string, string>) => {
  const cnamName = String(dv.caller_name_lookup || '').trim();
  const cnamType = String(dv.caller_type_lookup || '').trim();
  const cnamLineType = String(dv.line_type || '').trim();
  const cnamCarrier = String(dv.line_type_carrier || '').trim();
  return [
    cnamName ? `Caller ID Name (CNAM): ${cnamName}` : null,
    cnamType ? `Caller Type: ${cnamType}` : null,
    (cnamLineType || cnamCarrier) ? `Line: ${[cnamLineType, cnamCarrier].filter(Boolean).join(' - ')}` : null,
  ].filter(l => l !== null);
};

const unidTitle = (dv: Record<string, string>, phone: string, clause: string) => {
  const cnamName = String(dv.caller_name_lookup || '').trim();
  const unidLabel = cnamName ? `${cnamName} ${phone}` : phone;
  return `[Unverified] ${unidLabel} - ${clause}`.substring(0, 255);
};

describe('B1 closure caller intel', () => {
  it('renders all fields when the lookup returned them (the Yolanda shape)', () => {
    const lines = buildIntelLines({
      caller_name_lookup: 'YOLANDA CAMPOS', caller_type_lookup: 'CONSUMER',
      line_type: 'mobile', line_type_carrier: 'T-Mobile USA',
    });
    expect(lines).toEqual([
      'Caller ID Name (CNAM): YOLANDA CAMPOS',
      'Caller Type: CONSUMER',
      'Line: mobile - T-Mobile USA',
    ]);
  });
  it('renders nothing when the lookup was empty (no empty labels)', () => {
    expect(buildIntelLines({})).toEqual([]);
  });
  it('renders line type without carrier and vice versa', () => {
    expect(buildIntelLines({ line_type: 'nonFixedVoip' })).toEqual(['Line: nonFixedVoip']);
    expect(buildIntelLines({ line_type_carrier: 'Onvoy' })).toEqual(['Line: Onvoy']);
  });
  it('unidentified title carries the CNAM name when present', () => {
    expect(unidTitle({ caller_name_lookup: 'YOLANDA CAMPOS' }, '+19099928054', 'Callback - General IT Support'))
      .toBe('[Unverified] YOLANDA CAMPOS +19099928054 - Callback - General IT Support');
    expect(unidTitle({}, '+19099928054', 'Callback - General IT Support'))
      .toBe('[Unverified] +19099928054 - Callback - General IT Support');
  });
});

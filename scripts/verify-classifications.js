#!/usr/bin/env node
// Verify Company.classification resolution for two known companies.
// Exercises the same picklist-cache path the enriched /phone-lookup uses.

const { config } = require('dotenv');
const winston = require('winston');
const { AutotaskService } = require('../dist/services/autotask.service.js');
const { PicklistCache } = require('../dist/services/picklist.cache.js');

config();

const logger = winston.createLogger({
  level: 'error',
  format: winston.format.simple(),
  transports: [new winston.transports.Console()]
});

const MANAGED_LABELS = new Set(['Gold', 'Silver', 'Bronze']);

const TARGETS = [
  { name: 'Daus Technologies Corporation', expected: 'Silver' },
  { name: 'City of San Dimas', expected: 'Gold' }
];

async function main() {
  const serviceConfig = {
    autotask: {
      username: process.env.AUTOTASK_USERNAME,
      secret: process.env.AUTOTASK_SECRET,
      integrationCode: process.env.AUTOTASK_INTEGRATION_CODE
    }
  };
  if (!serviceConfig.autotask.username) {
    console.error('Missing AUTOTASK_* env vars');
    process.exit(1);
  }

  const svc = new AutotaskService(serviceConfig, logger);
  const cache = new PicklistCache(logger, (et) => svc.getFieldInfo(et));

  const classValues = await cache.getPicklistValues('Companies', 'classification');
  const byId = new Map(classValues.map(v => [String(v.value), v.label]));

  console.log('classification picklist:');
  for (const v of classValues) console.log(`  ${v.value} → ${v.label}`);
  console.log();

  for (const target of TARGETS) {
    const hits = await svc.searchCompanies({ searchTerm: target.name, pageSize: 10 });
    const exact = hits.find(c => c.companyName === target.name) || hits[0];

    if (!exact) {
      console.log(`[MISS] ${target.name}: not found`);
      continue;
    }

    const classId = exact.classification != null ? String(exact.classification) : null;
    const label = classId ? (byId.get(classId) || `unknown(${classId})`) : 'none';
    const isManaged = MANAGED_LABELS.has(label);
    const ok = label === target.expected ? 'OK ' : 'FAIL';

    console.log(`[${ok}] ${exact.companyName} (id=${exact.id})`);
    console.log(`       classificationId=${classId} label=${label} isManaged=${isManaged}`);
    console.log(`       expected=${target.expected}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });

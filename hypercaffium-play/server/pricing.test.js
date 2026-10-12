process.env.HYPERCAFFIUM_TIMEZONE ??= 'America/New_York';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { assertAllowed } from './guard.js';
import { fromMoney, prepareMigratePrices, prepareSetSubscriptionPrice, toMoney } from './pricing.js';
import { setFeatureSource } from './rules.js';
import { applyChange, TicketStore } from './writes.js';

const PKG = 'com.example.app';
const usd = (n) => toMoney(n, 'USD');
const SUB = {
  packageName: PKG,
  productId: 'master_monthly',
  basePlans: [
    {
      basePlanId: 'monthly',
      state: 'ACTIVE',
      regionalConfigs: [
        { regionCode: 'US', newSubscriberAvailability: true, price: usd(1.99) },
        { regionCode: 'CA', newSubscriberAvailability: true, price: toMoney(2.79, 'CAD') },
      ],
      otherRegionsConfig: { usdPrice: usd(1.99), eurPrice: toMoney(1.99, 'EUR'), newSubscriberAvailability: true },
    },
    { basePlanId: 'other', state: 'ACTIVE', regionalConfigs: [{ regionCode: 'US', price: usd(9.99) }] },
  ],
};
const CONVERTED = {
  convertedRegionPrices: { US: { regionCode: 'US', price: usd(2.99) }, CA: { regionCode: 'CA', price: toMoney(3.99, 'CAD') } },
  convertedOtherRegionsPrice: { usdPrice: usd(2.99), eurPrice: toMoney(2.79, 'EUR') },
  regionVersion: { version: '2025/03' },
};

function fake() {
  const calls = [];
  return {
    calls,
    store: new TicketStore(),
    defaultPackage: () => PKG,
    writesEnabled: () => true,
    withReadContext: async (_p, needsEdit, fn) => fn(needsEdit ? 'E0' : null),
    get: async (p) => {
      if (p.endsWith('/subscriptions/master_monthly')) return structuredClone(SUB);
      throw new Error(`fake: no GET ${p}`);
    },
    convert: async (_pkg, body) => {
      calls.push(['CONVERT', body]);
      return CONVERTED;
    },
    send: async (method, p, query, body) => {
      calls.push([method, p, query, body]);
      return {};
    },
  };
}
afterEach(() => setFeatureSource(() => ({})));

test('money helpers round-trip and refuse bad amounts', () => {
  assert.deepEqual(toMoney(4.99, 'USD'), { currencyCode: 'USD', units: '4', nanos: 990000000 });
  assert.equal(fromMoney(toMoney(12.5, 'EUR')), 12.5);
  assert.throws(() => toMoney(-1, 'USD'), /positive/);
  assert.throws(() => toMoney(1.999, 'USD'), /2 decimal/);
});

test('set price: per-region table, new subscribers only, and only the chosen base plan changes', async () => {
  const d = fake();
  const p = await prepareSetSubscriptionPrice(d, { productId: 'master_monthly', basePlanId: 'monthly', price: 2.99 });
  assert.equal(p.allowed, true);
  assert.equal(p.tier, 2);
  assert.equal(p.feature, 'pricing');
  assert.match(p.whoPays, /NEW subscribers only/);
  assert.deepEqual(
    p.priceTable.map((r) => [r.region, r.from, r.to]),
    [
      ['US', '1.99 USD', '2.99 USD'],
      ['CA', '2.79 CAD', '3.99 CAD'],
    ],
  );
  assert.equal(p.priceTable[0].change, '+50.3%');
  assert.ok(!d.calls.some((c) => c[0] === 'PATCH'), 'the preview changes nothing');

  await applyChange({ ticketId: p.ticket, deps: d });
  const [method, path, query, body] = d.calls.find((c) => c[0] === 'PATCH');
  assert.equal(method, 'PATCH');
  assert.match(path, /\/subscriptions\/master_monthly$/);
  assert.equal(query.updateMask, 'basePlans');
  assert.equal(query['regionsVersion.version'], '2025/03');
  const monthly = body.basePlans.find((b) => b.basePlanId === 'monthly');
  assert.equal(fromMoney(monthly.regionalConfigs[0].price), 2.99);
  assert.equal(fromMoney(monthly.otherRegionsConfig.usdPrice), 2.99);
  assert.equal(fromMoney(body.basePlans.find((b) => b.basePlanId === 'other').regionalConfigs[0].price), 9.99, 'other base plans untouched');
});

test('set price for selected regions leaves the rest (and other regions) alone', async () => {
  const d = fake();
  const p = await prepareSetSubscriptionPrice(d, { productId: 'master_monthly', basePlanId: 'monthly', price: 2.99, regions: ['US'] });
  assert.equal(p.regionsChanged, 1);
  await applyChange({ ticketId: p.ticket, deps: d });
  const body = d.calls.find((c) => c[0] === 'PATCH')[3];
  const monthly = body.basePlans.find((b) => b.basePlanId === 'monthly');
  assert.equal(fromMoney(monthly.regionalConfigs.find((c) => c.regionCode === 'CA').price), 2.79);
  assert.equal(fromMoney(monthly.otherRegionsConfig.usdPrice), 1.99);
  await assert.rejects(prepareSetSubscriptionPrice(d, { productId: 'master_monthly', basePlanId: 'monthly', price: 2.99, regions: ['FR'] }), /not offered in: FR/);
  await assert.rejects(prepareSetSubscriptionPrice(d, { productId: 'master_monthly', basePlanId: 'nope', price: 2.99 }), /no base plan "nope"/);
});

test('migrate: spells out the customer impact and sends opt-in migrations for every region', async () => {
  const d = fake();
  const p = await prepareMigratePrices(d, { productId: 'master_monthly', basePlanId: 'monthly', oldestAllowedPriceVersionTime: '2026-10-11T00:00:00Z' });
  assert.equal(p.allowed, true);
  assert.equal(p.tier, 2);
  assert.match(p.customerImpact.join(' '), /existing, paying customers.*ACCEPT/s);
  assert.equal(p.currentPrices.US, '1.99 USD');
  await applyChange({ ticketId: p.ticket, deps: d });
  const [method, path, , body] = d.calls.find((c) => c[0] === 'POST');
  assert.equal(method, 'POST');
  assert.match(path, /\/basePlans\/monthly:migratePrices$/);
  assert.deepEqual(
    body.regionalPriceMigrations.map((m) => [m.regionCode, m.priceIncreaseType]),
    [
      ['US', 'PRICE_INCREASE_TYPE_OPT_IN'],
      ['CA', 'PRICE_INCREASE_TYPE_OPT_IN'],
    ],
  );
  assert.equal(body.regionsVersion.version, '2025/03');
});

test('migrate: opt-out is explained as limited, and bad input is refused', async () => {
  const d = fake();
  const p = await prepareMigratePrices(d, { productId: 'master_monthly', basePlanId: 'monthly', increaseType: 'OPT_OUT' });
  assert.match(p.customerImpact.join(' '), /may refuse/);
  await assert.rejects(prepareMigratePrices(d, { productId: 'master_monthly', basePlanId: 'monthly', increaseType: 'SURPRISE' }), /OPT_IN or OPT_OUT/);
  await assert.rejects(prepareMigratePrices(d, { productId: 'master_monthly', basePlanId: 'monthly', oldestAllowedPriceVersionTime: 'soon' }), /date-time/);
});

test('pricing tools refuse when the pricing feature is off, before contacting Google', async () => {
  setFeatureSource(() => ({ pricing: false }));
  const d = fake();
  const a = await prepareSetSubscriptionPrice(d, { productId: 'master_monthly', basePlanId: 'monthly', price: 2.99 });
  const b = await prepareMigratePrices(d, { productId: 'master_monthly', basePlanId: 'monthly' });
  for (const r of [a, b]) {
    assert.equal(r.allowed, false);
    assert.match(r.reason, /switched off/);
  }
  assert.equal(d.calls.length, 0);
});

test('the read guard allows the Google price converter but no other POST', () => {
  assert.doesNotThrow(() => assertAllowed('POST', `/androidpublisher/v3/applications/${PKG}/pricing:convertRegionPrices`));
  assert.throws(() => assertAllowed('POST', `/androidpublisher/v3/applications/${PKG}/subscriptions/x/basePlans/y:migratePrices`), /not a read-only/);
});

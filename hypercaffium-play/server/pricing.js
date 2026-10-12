// Google Play subscription prices. Two separate, deliberate steps, mirroring how Google works:
//   1. play_set_subscription_price changes a base plan's price. It applies to NEW subscribers only.
//   2. play_migrate_subscription_prices moves EXISTING subscribers to the current price. It changes
//      what real customers are charged, so its preview spells out exactly who is affected and how.
// Both are previews with a ticket (Tier 2, "pricing" feature); nothing changes until applied.
import { currentFeatures } from './rules.js';
import { prepareChange } from './writes.js';

const APP = '/androidpublisher/v3/applications';
const enc = encodeURIComponent;

// Google money: { currencyCode, units: "4", nanos: 990000000 }.
export function toMoney(amount, currencyCode) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) throw new Error('price must be a positive number, like 4.99.');
  if (!/^[A-Z]{3}$/.test(currencyCode)) throw new Error('currency must be a 3-letter code such as USD.');
  const cents = Math.round(amount * 100);
  if (Math.abs(cents / 100 - amount) > 1e-9) throw new Error('price may have at most 2 decimal places.');
  return { currencyCode, units: String(Math.floor(cents / 100)), nanos: (cents % 100) * 10_000_000 };
}
export const fromMoney = (m) => (m ? Number(m.units || 0) + Number(m.nanos || 0) / 1e9 : null);
const OFF = {
  allowed: false,
  tier: 3,
  blocked: true,
  reason: 'The "pricing" feature is switched off in your settings. Run /hypercaffium-play:setup to see or change your settings.',
};
const show = (m) => (m ? `${fromMoney(m).toFixed(2)} ${m.currencyCode}` : '(none)');

async function loadBasePlan(deps, pkg, productId, basePlanId) {
  if (!productId || !basePlanId) throw new Error('Pass productId and basePlanId (see play_subscription_overview).');
  const sub = await deps.get(`${APP}/${pkg}/subscriptions/${enc(productId)}`, {});
  const plan = (sub.basePlans || []).find((b) => b.basePlanId === basePlanId);
  if (!plan) throw new Error(`Subscription ${productId} has no base plan "${basePlanId}". Base plans: ${(sub.basePlans || []).map((b) => b.basePlanId).join(', ')}.`);
  return { sub, plan };
}

function pickRegions(plan, regions) {
  const offered = (plan.regionalConfigs || []).map((c) => c.regionCode);
  if (regions === 'all' || regions === undefined) return offered;
  if (!Array.isArray(regions) || regions.length === 0) throw new Error('regions must be "all" or a list of region codes such as ["US", "CA"].');
  const unknown = regions.filter((r) => !offered.includes(r));
  if (unknown.length) throw new Error(`This base plan is not offered in: ${unknown.join(', ')}.`);
  return regions;
}

// Keep tool output readable: the full subscription body is in the ticket, not in the preview text.
const slim = (preview) => ({
  allowed: preview.allowed,
  tier: preview.tier,
  tierReason: preview.tierReason,
  feature: preview.feature,
  ticket: preview.ticket,
  expires: preview.expires,
  blocked: preview.blocked,
  reason: preview.reason,
  nextStep: preview.nextStep,
});

export async function prepareSetSubscriptionPrice(deps, { packageName, productId, basePlanId, price, currency = 'USD', regions = 'all', includeOtherRegions = true }) {
  if (!currentFeatures().pricing) return OFF;
  const pkg = packageName || deps.defaultPackage();
  const money = toMoney(price, currency);
  const { sub, plan } = await loadBasePlan(deps, pkg, productId, basePlanId);
  const chosen = pickRegions(plan, regions);

  // Google converts one price into every region's local currency (with its own rounding rules).
  const converted = await deps.convert(pkg, { price: money });
  const version = converted.regionVersion?.version;
  if (!version) throw new Error('Google did not return a regions version for the price conversion.');

  const rows = [];
  const newConfigs = (plan.regionalConfigs || []).map((c) => {
    if (!chosen.includes(c.regionCode)) return c;
    const local = c.price?.currencyCode === currency ? money : converted.convertedRegionPrices?.[c.regionCode]?.price;
    if (!local) throw new Error(`Google gave no converted price for ${c.regionCode}.`);
    const before = fromMoney(c.price);
    const after = fromMoney(local);
    rows.push({
      region: c.regionCode,
      from: show(c.price),
      to: show(local),
      change: before ? `${after >= before ? '+' : ''}${(((after - before) / before) * 100).toFixed(1)}%` : 'new',
    });
    return { ...c, price: local };
  });
  const newPlan = { ...plan, regionalConfigs: newConfigs };
  let otherRegions;
  if (includeOtherRegions && regions === 'all' && plan.otherRegionsConfig && converted.convertedOtherRegionsPrice) {
    const o = converted.convertedOtherRegionsPrice;
    newPlan.otherRegionsConfig = { ...plan.otherRegionsConfig, usdPrice: o.usdPrice, eurPrice: o.eurPrice };
    otherRegions = { from: `${show(plan.otherRegionsConfig.usdPrice)} / ${show(plan.otherRegionsConfig.eurPrice)}`, to: `${show(o.usdPrice)} / ${show(o.eurPrice)}` };
  }
  const body = { packageName: pkg, productId, basePlans: (sub.basePlans || []).map((b) => (b.basePlanId === basePlanId ? newPlan : b)) };

  const preview = await prepareChange({
    changes: [
      {
        methodId: 'monetization.subscriptions.patch',
        params: { packageName: pkg, productId, updateMask: 'basePlans', 'regionsVersion.version': version },
        body,
      },
    ],
    deps,
  });
  return {
    title: `Set ${productId} / ${basePlanId} to ${show(money)} in ${regions === 'all' ? `all ${chosen.length} regions` : chosen.join(', ')}`,
    whoPays: 'NEW subscribers only. Existing subscribers keep paying their current price until you move them with play_migrate_subscription_prices (a separate step).',
    regionsChanged: rows.length,
    priceTable: rows,
    otherRegions,
    rounding: 'Local prices are Google\'s own conversion of your price, rounded to each country\'s price rules.',
    ...slim(preview),
  };
}

const INCREASE = {
  OPT_IN: {
    api: 'PRICE_INCREASE_TYPE_OPT_IN',
    meaning:
      'Opt-in: for subscribers whose price goes UP, Google notifies them and they must ACCEPT the new price. Anyone who does not accept before their renewal is unsubscribed at the end of their current period.',
  },
  OPT_OUT: {
    api: 'PRICE_INCREASE_TYPE_OPT_OUT',
    meaning:
      'Opt-out: subscribers whose price goes UP are notified in advance and charged the new price unless they cancel. Google only allows this for small increases, in some countries, and not too often; it may refuse the request.',
  },
};

export async function prepareMigratePrices(deps, { packageName, productId, basePlanId, regions = 'all', increaseType = 'OPT_IN', oldestAllowedPriceVersionTime }) {
  if (!currentFeatures().pricing) return OFF;
  const pkg = packageName || deps.defaultPackage();
  const kind = INCREASE[increaseType];
  if (!kind) throw new Error('increaseType must be OPT_IN or OPT_OUT.');
  const { plan } = await loadBasePlan(deps, pkg, productId, basePlanId);
  const chosen = pickRegions(plan, regions);
  const cutoff = oldestAllowedPriceVersionTime || new Date().toISOString();
  if (Number.isNaN(Date.parse(cutoff))) throw new Error('oldestAllowedPriceVersionTime must be a date-time like 2026-10-11T00:00:00Z.');

  // migratePrices needs the regions version; a conversion of the plan's own price returns it.
  const sample = (plan.regionalConfigs || []).find((c) => c.regionCode === 'US') || (plan.regionalConfigs || [])[0];
  if (!sample?.price) throw new Error('This base plan has no regional prices to migrate.');
  const converted = await deps.convert(pkg, { price: sample.price });
  const version = converted.regionVersion?.version;
  if (!version) throw new Error('Google did not return a regions version.');

  const body = {
    regionalPriceMigrations: chosen.map((regionCode) => ({ regionCode, oldestAllowedPriceVersionTime: cutoff, priceIncreaseType: kind.api })),
    regionsVersion: { version },
  };
  const preview = await prepareChange({
    changes: [{ methodId: 'monetization.subscriptions.basePlans.migratePrices', params: { packageName: pkg, productId, basePlanId }, body }],
    deps,
  });
  const prices = Object.fromEntries((plan.regionalConfigs || []).map((c) => [c.regionCode, show(c.price)]));
  return {
    title: `Move EXISTING ${productId} / ${basePlanId} subscribers to the current price in ${regions === 'all' ? `all ${chosen.length} regions` : chosen.join(', ')}`,
    customerImpact: [
      `This changes what existing, paying customers are charged. Subscribers who signed up at a price set before ${cutoff} move to today's price for their region.`,
      kind.meaning,
      'Subscribers whose price goes DOWN simply pay less from their next renewal.',
      'Google emails affected subscribers. This cannot be undone by the plugin; to reverse it you would set the old price again and migrate again.',
    ],
    currentPrices: chosen.length <= 12 ? Object.fromEntries(chosen.map((r) => [r, prices[r]])) : `${chosen.length} regions (see play_subscription_overview)`,
    ...slim(preview),
    nextStep: preview.allowed
      ? 'Read the customer impact to the owner in plain English, confirm the regions and opt-in/opt-out choice, and wait for an explicit yes. Then apply with play_apply_change.'
      : preview.nextStep,
  };
}

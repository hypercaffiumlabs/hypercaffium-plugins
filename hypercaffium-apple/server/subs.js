// Apple subscription workflows. Money-affecting, so every change is Tier 2 and previewed per territory.
import { findOperation, preparePlan } from './plans.js';
import { flat, list, resolveApp } from './release.js';
import { toLocalTime } from './util.js';
import { prepareChange } from './writes.js';

const qs = (o) => {
  const e = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return e.length ? `?${e.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')}` : '';
};
const opFor = (method, path) => {
  const op = findOperation(method, path);
  if (!op) throw new Error(`Apple's API has no ${method} ${path}.`);
  return op;
};
const enc = encodeURIComponent;

// Follow Apple's pagination (links.next) up to a sane cap.
export async function getAll(deps, path, { pages = 6 } = {}) {
  const data = [];
  const included = [];
  let next = path;
  for (let i = 0; i < pages && next; i++) {
    const body = await deps.get(next);
    data.push(...(body.data || []));
    included.push(...(body.included || []));
    const link = body.links?.next;
    next = link ? link.replace(/^https:\/\/api\.appstoreconnect\.apple\.com/, '') : null;
  }
  return { data, included };
}

// ---- reading prices --------------------------------------------------------

export async function subscriptionPrices(deps, { subscriptionId, territory }) {
  const { data, included } = await getAll(deps, `/v1/subscriptions/${enc(subscriptionId)}/prices${qs({ include: 'subscriptionPricePoint,territory', limit: 200 })}`);
  const byId = (type) => new Map(included.filter((i) => i.type === type).map((i) => [i.id, i]));
  const points = byId('subscriptionPricePoints');
  const territories = byId('territories');
  const rows = data.map((p) => {
    const pp = points.get(p.relationships?.subscriptionPricePoint?.data?.id);
    const t = territories.get(p.relationships?.territory?.data?.id);
    return {
      territory: p.relationships?.territory?.data?.id || t?.id,
      currency: t?.attributes?.currency,
      customerPrice: pp?.attributes?.customerPrice,
      proceeds: pp?.attributes?.proceeds,
      startDate: p.attributes?.startDate ?? null,
      preserved: p.attributes?.preserved ?? null,
      pricePointId: pp?.id,
      priceId: p.id,
    };
  });
  const today = new Date().toISOString().slice(0, 10);
  // Per territory: the price in effect today (latest start date not in the future; null = since the beginning).
  const current = new Map();
  for (const r of rows) {
    if (r.startDate && r.startDate > today) continue;
    const prev = current.get(r.territory);
    if (!prev || String(r.startDate || '') >= String(prev.startDate || '')) current.set(r.territory, r);
  }
  const scheduled = rows.filter((r) => r.startDate && r.startDate > today);
  const pick = (r) => !territory || r.territory === territory;
  return {
    subscriptionId,
    current: [...current.values()].filter(pick).sort((a, b) => String(a.territory).localeCompare(String(b.territory))),
    scheduled: scheduled.filter(pick).sort((a, b) => String(a.startDate).localeCompare(String(b.startDate))),
  };
}

export async function findPricePoint(deps, { subscriptionId, territory = 'USA', amount }) {
  const { data } = await getAll(deps, `/v1/subscriptions/${enc(subscriptionId)}/pricePoints${qs({ 'filter[territory]': territory, limit: 200 })}`, { pages: 8 });
  const points = data.map((p) => ({ id: p.id, customerPrice: p.attributes?.customerPrice, proceeds: p.attributes?.proceeds }));
  if (amount === undefined) return { territory, points };
  const want = Number(amount);
  const exact = points.find((p) => Number(p.customerPrice) === want);
  if (exact) return { territory, match: exact };
  const nearest = [...points].sort((a, b) => Math.abs(Number(a.customerPrice) - want) - Math.abs(Number(b.customerPrice) - want)).slice(0, 5);
  return { territory, match: null, nearest };
}

// ---- overview --------------------------------------------------------------

export async function subscriptionOverview(deps, { appId }) {
  const app = await resolveApp(deps, appId);
  const groups = list(await deps.get(`/v1/apps/${enc(app)}/subscriptionGroups${qs({ limit: 50 })}`));
  const out = [];
  for (const g of groups) {
    const subs = list(await deps.get(`/v1/subscriptionGroups/${enc(g.id)}/subscriptions${qs({ limit: 50 })}`)).slice(0, 30);
    const rows = [];
    for (const s of subs) {
      const [locs, intro, promo, codes, prices] = await Promise.all([
        deps.get(`/v1/subscriptions/${enc(s.id)}/subscriptionLocalizations${qs({ limit: 50 })}`).catch(() => ({ data: [] })),
        deps.get(`/v1/subscriptions/${enc(s.id)}/introductoryOffers${qs({ limit: 50 })}`).catch(() => ({ data: [] })),
        deps.get(`/v1/subscriptions/${enc(s.id)}/promotionalOffers${qs({ limit: 50 })}`).catch(() => ({ data: [] })),
        deps.get(`/v1/subscriptions/${enc(s.id)}/offerCodes${qs({ limit: 50 })}`).catch(() => ({ data: [] })),
        subscriptionPrices(deps, { subscriptionId: s.id, territory: 'USA' }).catch(() => null),
      ]);
      rows.push({
        id: s.id,
        name: s.name,
        productId: s.productId,
        state: s.state,
        period: s.subscriptionPeriod,
        level: s.groupLevel,
        familySharable: s.familySharable,
        localizations: list(locs).map((l) => ({ locale: l.locale, name: l.name, state: l.state })),
        introductoryOffers: (intro.data || []).length,
        promotionalOffers: (promo.data || []).length,
        offerCodes: (codes.data || []).length,
        usPrice: prices?.current?.[0] ? { customerPrice: prices.current[0].customerPrice, currency: prices.current[0].currency, since: prices.current[0].startDate } : null,
        scheduledPriceChanges: (prices?.scheduled || []).map((p) => ({ territory: p.territory, customerPrice: p.customerPrice, startDate: p.startDate })),
      });
    }
    out.push({ groupId: g.id, group: g.referenceName, subscriptions: rows });
  }
  return { app, groups: out };
}

// ---- changing prices -------------------------------------------------------

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function prepareSetPrice(deps, { subscriptionId, territory = 'USA', amount, pricePointId, allTerritories = false, startDate, preserveCurrentPrice = true }) {
  if (startDate && !DATE.test(startDate)) throw new Error('startDate must look like 2026-11-01.');
  if (startDate && startDate < new Date().toISOString().slice(0, 10)) throw new Error('startDate cannot be in the past.');
  let basePoint = pricePointId ? { id: pricePointId } : null;
  let customerPrice;
  if (!basePoint) {
    if (amount === undefined) throw new Error('Pass amount (e.g. 4.99) or pricePointId.');
    const found = await findPricePoint(deps, { subscriptionId, territory, amount });
    if (!found.match) {
      throw new Error(`No ${territory} price point is exactly ${amount}. Apple only allows fixed price points. Nearest: ${found.nearest.map((n) => n.customerPrice).join(', ')}.`);
    }
    basePoint = found.match;
    customerPrice = found.match.customerPrice;
  }

  const current = await subscriptionPrices(deps, { subscriptionId });
  const nowBy = new Map(current.current.map((r) => [r.territory, r]));

  // Which territories get which price point
  let targets = [{ territory, pricePointId: basePoint.id, customerPrice }];
  if (allTerritories) {
    const eq = await getAll(deps, `/v1/subscriptionPricePoints/${enc(basePoint.id)}/equalizations${qs({ include: 'territory', limit: 200 })}`, { pages: 5 });
    const terr = new Map(eq.included.filter((i) => i.type === 'territories').map((i) => [i.id, i]));
    targets = [
      ...targets,
      ...eq.data.map((p) => {
        const tid = p.relationships?.territory?.data?.id;
        return { territory: tid, pricePointId: p.id, customerPrice: p.attributes?.customerPrice, currency: terr.get(tid)?.attributes?.currency };
      }),
    ].filter((t, i, arr) => t.territory && arr.findIndex((x) => x.territory === t.territory) === i);
  }

  const steps = targets.map((t) => ({
    label: `${t.territory}: price to ${t.customerPrice ?? '(price point)'}${startDate ? ` from ${startDate}` : ' now'}`,
    method: 'POST',
    path: '/v1/subscriptionPrices',
    body: {
      data: {
        type: 'subscriptionPrices',
        attributes: { preserveCurrentPrice: Boolean(preserveCurrentPrice), ...(startDate ? { startDate } : {}) },
        relationships: {
          subscription: { data: { type: 'subscriptions', id: subscriptionId } },
          subscriptionPricePoint: { data: { type: 'subscriptionPricePoints', id: t.pricePointId } },
          territory: { data: { type: 'territories', id: t.territory } },
        },
      },
    },
  }));

  const plan = await preparePlan({
    title: `Change subscription price (${allTerritories ? `${targets.length} territories` : territory})`,
    steps,
    deps,
  });
  if (!plan.allowed) return plan;

  const table = targets.map((t) => {
    const now = nowBy.get(t.territory);
    const from = now?.customerPrice;
    const pct = from && t.customerPrice ? Math.round(((Number(t.customerPrice) - Number(from)) / Number(from)) * 1000) / 10 : null;
    return { territory: t.territory, currency: t.currency || now?.currency, from: from ?? null, to: t.customerPrice ?? null, changePercent: pct };
  });
  const increases = table.filter((r) => r.changePercent !== null && r.changePercent > 0).length;
  return {
    ...plan,
    summary: {
      territories: targets.length,
      starts: startDate || 'immediately',
      existingSubscribers: preserveCurrentPrice
        ? 'Existing subscribers KEEP their current price (preserveCurrentPrice is on).'
        : 'Existing subscribers are moved to the new price (Apple may require their consent for increases).',
      increases,
      decreases: table.filter((r) => r.changePercent !== null && r.changePercent < 0).length,
    },
    priceTable: table.slice(0, 200),
    warning: 'This changes what customers pay. Review the table, and only approve it if every row is intended.',
  };
}

// ---- editing subscriptions -------------------------------------------------

export async function prepareEditSubscription(deps, { subscriptionId, fields }) {
  const allowed = ['name', 'reviewNote', 'familySharable', 'groupLevel'];
  const entries = Object.entries(fields || {}).filter(([, v]) => v !== undefined);
  if (!entries.length) throw new Error(`Provide at least one field: ${allowed.join(', ')}.`);
  for (const [k] of entries) if (!allowed.includes(k)) throw new Error(`Cannot change "${k}" here. Allowed: ${allowed.join(', ')}.`);
  const preview = await prepareChange({
    op: opFor('PATCH', '/v1/subscriptions/{id}'),
    pathParams: { id: subscriptionId },
    body: { data: { type: 'subscriptions', id: subscriptionId, attributes: Object.fromEntries(entries) } },
    deps,
  });
  return preview;
}

export async function prepareEditSubscriptionLocalization(deps, { subscriptionId, locale, name, description }) {
  if (!locale) throw new Error('Pass locale, e.g. en-US.');
  if (name === undefined && description === undefined) throw new Error('Provide name and/or description.');
  const attrs = {};
  if (name !== undefined) {
    if (name.length < 2 || name.length > 30) throw new Error('A subscription display name must be 2 to 30 characters.');
    attrs.name = name;
  }
  if (description !== undefined) {
    if (description.length > 45) throw new Error('A subscription description may be at most 45 characters.');
    attrs.description = description;
  }
  const locs = list(await deps.get(`/v1/subscriptions/${enc(subscriptionId)}/subscriptionLocalizations${qs({ limit: 50 })}`));
  const hit = locs.find((l) => l.locale === locale);
  if (hit) {
    return prepareChange({
      op: opFor('PATCH', '/v1/subscriptionLocalizations/{id}'),
      pathParams: { id: hit.id },
      body: { data: { type: 'subscriptionLocalizations', id: hit.id, attributes: attrs } },
      deps,
    });
  }
  if (!attrs.name || attrs.description === undefined) throw new Error(`No ${locale} localization exists yet; creating one needs both name and description.`);
  const preview = await prepareChange({
    op: opFor('POST', '/v1/subscriptionLocalizations'),
    body: {
      data: {
        type: 'subscriptionLocalizations',
        attributes: { locale, ...attrs },
        relationships: { subscription: { data: { type: 'subscriptions', id: subscriptionId } } },
      },
    },
    deps,
  });
  return { creatingNewLocale: true, existingLocales: locs.map((l) => l.locale), ...preview };
}

export async function prepareIntroOffer(deps, { subscriptionId, offerMode = 'FREE_TRIAL', duration = 'ONE_WEEK', numberOfPeriods = 1, territory, startDate, endDate, amount }) {
  const attributes = { offerMode, duration, numberOfPeriods };
  if (startDate) attributes.startDate = startDate;
  if (endDate) attributes.endDate = endDate;
  const relationships = { subscription: { data: { type: 'subscriptions', id: subscriptionId } } };
  if (territory) relationships.territory = { data: { type: 'territories', id: territory } };
  if (offerMode !== 'FREE_TRIAL') {
    if (!territory || amount === undefined) throw new Error('Paid introductory offers need territory and amount (the price per period).');
    const pp = await findPricePoint(deps, { subscriptionId, territory, amount });
    if (!pp.match) throw new Error(`No ${territory} price point is exactly ${amount}. Nearest: ${pp.nearest.map((n) => n.customerPrice).join(', ')}.`);
    relationships.subscriptionPricePoint = { data: { type: 'subscriptionPricePoints', id: pp.match.id } };
  }
  return prepareChange({
    op: opFor('POST', '/v1/subscriptionIntroductoryOffers'),
    body: { data: { type: 'subscriptionIntroductoryOffers', attributes, relationships } },
    deps,
  });
}

export { toLocalTime, flat };

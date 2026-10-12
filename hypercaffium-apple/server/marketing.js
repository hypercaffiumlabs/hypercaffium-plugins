// Marketing and offers on the App Store: custom product pages (alternate store pages you can point
// ads at), offer codes, promotional offers and win-back offers. Everything is a preview + ticket;
// custom pages are the "marketing" feature, offers are "pricing" (they change what customers pay).
import { findOperation, preparePlan } from './plans.js';
import { list, resolveApp } from './release.js';
import { findPricePoint, getAll, subscriptionPrices } from './subs.js';
import { toLocalTime } from './util.js';
import { prepareChange } from './writes.js';

const enc = encodeURIComponent;
const qs = (o) => {
  const e = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return e.length ? `?${e.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')}` : '';
};
const opFor = (method, path) => {
  const op = findOperation(method, path);
  if (!op) throw new Error(`Apple's API has no ${method} ${path}.`);
  return op;
};
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const DURATIONS = ['THREE_DAYS', 'ONE_WEEK', 'TWO_WEEKS', 'ONE_MONTH', 'TWO_MONTHS', 'THREE_MONTHS', 'SIX_MONTHS', 'ONE_YEAR'];
export const OFFER_MODES = ['FREE_TRIAL', 'PAY_AS_YOU_GO', 'PAY_UP_FRONT'];

// ---- custom product pages ----------------------------------------------------

async function findPage(deps, app, page) {
  const pages = list(await deps.get(`/v1/apps/${enc(app)}/appCustomProductPages${qs({ limit: 50 })}`));
  const hit = pages.find((p) => p.id === page || p.name === page);
  if (!hit) throw new Error(`No custom product page "${page}". Pages: ${pages.map((p) => p.name).join(', ') || 'none'}.`);
  return hit;
}

async function pageVersions(deps, pageId) {
  return list(await deps.get(`/v1/appCustomProductPages/${enc(pageId)}/appCustomProductPageVersions${qs({ limit: 20 })}`));
}

export async function customPagesOverview(deps, { appId }) {
  const app = await resolveApp(deps, appId);
  const pages = list(await deps.get(`/v1/apps/${enc(app)}/appCustomProductPages${qs({ limit: 50 })}`));
  const out = [];
  for (const p of pages) {
    const versions = await pageVersions(deps, p.id).catch(() => []);
    const latest = versions[0];
    const locs = latest ? list(await deps.get(`/v1/appCustomProductPageVersions/${enc(latest.id)}/appCustomProductPageLocalizations${qs({ limit: 50 })}`).catch(() => ({ data: [] }))) : [];
    out.push({
      id: p.id,
      name: p.name,
      visible: p.visible,
      url: p.url,
      versions: versions.map((v) => ({ id: v.id, version: v.version, state: v.state, deepLink: v.deepLink })),
      locales: locs.map((l) => ({ locale: l.locale, promotionalText: l.promotionalText })),
    });
  }
  return { app, pages: out, note: 'Apple allows up to 70 custom product pages. A page is public (and usable in ads) once Apple approves it.' };
}

export async function prepareCreateCustomPage(deps, { appId, name, locale = 'en-US', promotionalText, deepLink, copyFromLiveVersion = true }) {
  if (!name || name.length > 64) throw new Error('Give the page a name (64 characters max); only you see it.');
  if (promotionalText && promotionalText.length > 170) throw new Error('promotionalText may be at most 170 characters.');
  const app = await resolveApp(deps, appId);
  const relationships = {
    app: { data: { type: 'apps', id: app } },
    appCustomProductPageVersions: { data: [{ type: 'appCustomProductPageVersions', id: '${new-version}' }] },
  };
  let template = null;
  if (copyFromLiveVersion) {
    const versions = list(await deps.get(`/v1/apps/${enc(app)}/appStoreVersions${qs({ 'filter[appStoreState]': 'READY_FOR_SALE', limit: 1 })}`));
    if (versions[0]) {
      template = versions[0].versionString;
      relationships.appStoreVersionTemplate = { data: { type: 'appStoreVersions', id: versions[0].id } };
    }
  }
  const versionAttrs = deepLink ? { deepLink } : undefined;
  const body = {
    data: { type: 'appCustomProductPages', attributes: { name }, relationships },
    included: [
      {
        type: 'appCustomProductPageVersions',
        id: '${new-version}',
        ...(versionAttrs ? { attributes: versionAttrs } : {}),
        relationships: { appCustomProductPageLocalizations: { data: [{ type: 'appCustomProductPageLocalizations', id: '${new-locale}' }] } },
      },
      {
        type: 'appCustomProductPageLocalizations',
        id: '${new-locale}',
        attributes: { locale, ...(promotionalText ? { promotionalText } : {}) },
      },
    ],
  };
  const preview = await prepareChange({ op: opFor('POST', '/v1/appCustomProductPages'), body, deps });
  return {
    page: name,
    locale,
    startsFrom: template ? `a copy of the live version ${template} (its screenshots and previews)` : 'empty (add screenshots with asc_upload_screenshots and customProductPage)',
    note: 'The new page is a private draft until you submit it with asc_submit_custom_page and Apple approves it.',
    ...preview,
  };
}

export async function prepareEditCustomPageText(deps, { appId, page, locale = 'en-US', promotionalText }) {
  if (typeof promotionalText !== 'string' || promotionalText.length > 170) throw new Error('promotionalText is required, 170 characters max.');
  const app = await resolveApp(deps, appId);
  const p = await findPage(deps, app, page);
  const draft = (await pageVersions(deps, p.id)).find((v) => ['PREPARE_FOR_SUBMISSION', 'REJECTED'].includes(v.state));
  if (!draft) throw new Error(`"${p.name}" has no editable draft.`);
  const locs = list(await deps.get(`/v1/appCustomProductPageVersions/${enc(draft.id)}/appCustomProductPageLocalizations${qs({ limit: 50 })}`));
  const hit = locs.find((l) => l.locale === locale);
  if (hit) {
    return {
      page: p.name,
      ...(await prepareChange({
        op: opFor('PATCH', '/v1/appCustomProductPageLocalizations/{id}'),
        pathParams: { id: hit.id },
        body: { data: { type: 'appCustomProductPageLocalizations', id: hit.id, attributes: { promotionalText } } },
        deps,
      })),
    };
  }
  return {
    page: p.name,
    creatingNewLocale: true,
    ...(await prepareChange({
      op: opFor('POST', '/v1/appCustomProductPageLocalizations'),
      body: {
        data: {
          type: 'appCustomProductPageLocalizations',
          attributes: { locale, promotionalText },
          relationships: { appCustomProductPageVersion: { data: { type: 'appCustomProductPageVersions', id: draft.id } } },
        },
      },
      deps,
    })),
  };
}

export async function prepareSubmitCustomPage(deps, { appId, page, platform = 'IOS' }) {
  const app = await resolveApp(deps, appId);
  const p = await findPage(deps, app, page);
  const draft = (await pageVersions(deps, p.id)).find((v) => ['PREPARE_FOR_SUBMISSION', 'REJECTED'].includes(v.state));
  if (!draft) throw new Error(`"${p.name}" has no draft to submit.`);
  const open = list(
    await deps.get(`/v1/apps/${enc(app)}/reviewSubmissions${qs({ 'filter[state]': 'READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES', 'filter[platform]': platform, limit: 10 })}`),
  );
  const busy = open.find((s) => s.state !== 'READY_FOR_REVIEW');
  if (busy) {
    return {
      allowed: false,
      reason: `Another submission is already ${busy.state}. Apple allows one at a time per platform; submit the page after that review finishes.`,
    };
  }
  const draftSub = open.find((s) => s.state === 'READY_FOR_REVIEW');
  const steps = [];
  let subRef = draftSub?.id;
  if (!draftSub) {
    steps.push({
      label: 'Create a review submission',
      method: 'POST',
      path: '/v1/reviewSubmissions',
      body: { data: { type: 'reviewSubmissions', attributes: { platform }, relationships: { app: { data: { type: 'apps', id: app } } } } },
    });
    subRef = '{{0.id}}';
  }
  steps.push({
    label: `Add custom product page "${p.name}"`,
    method: 'POST',
    path: '/v1/reviewSubmissionItems',
    body: {
      data: {
        type: 'reviewSubmissionItems',
        relationships: {
          reviewSubmission: { data: { type: 'reviewSubmissions', id: subRef } },
          appCustomProductPageVersion: { data: { type: 'appCustomProductPageVersions', id: draft.id } },
        },
      },
    },
  });
  steps.push({
    label: 'Submit for App Review',
    method: 'PATCH',
    path: '/v1/reviewSubmissions/{id}',
    pathParams: { id: subRef },
    body: { data: { type: 'reviewSubmissions', id: subRef, attributes: { submitted: true } } },
  });
  const plan = await preparePlan({ title: `Submit custom product page "${p.name}" for App Review`, steps, deps });
  return {
    ...plan,
    page: p.name,
    joinsExistingDraft: draftSub
      ? 'An unsent review submission already exists; the page is added to it and EVERYTHING in it is submitted together. Check what else is in it first.'
      : undefined,
  };
}

// ---- offer prices ------------------------------------------------------------

// Apple wants one price entry per territory. Free offers name the territory only; paid offers also
// pick Apple's price point there (equalized from one base price, like asc_set_subscription_price).
async function offerPrices(deps, { subscriptionId, offerMode, territories = 'all', amount, baseTerritory = 'USA', priceType }) {
  let terr = territories;
  if (terr === 'all') {
    const current = await subscriptionPrices(deps, { subscriptionId });
    terr = [...new Set(current.current.map((r) => r.territory))];
    if (!terr.length) throw new Error('This subscription has no prices yet, so there are no territories to offer it in.');
  }
  if (!Array.isArray(terr) || !terr.length) throw new Error('territories must be "all" or a list such as ["USA", "CAN"].');
  const pointBy = new Map();
  if (offerMode !== 'FREE_TRIAL') {
    if (amount === undefined) throw new Error(`A ${offerMode} offer needs amount: the price in ${baseTerritory}, e.g. 0.99.`);
    const found = await findPricePoint(deps, { subscriptionId, territory: baseTerritory, amount });
    if (!found.match) throw new Error(`No ${baseTerritory} price point is exactly ${amount}. Nearest: ${found.nearest.map((n) => n.customerPrice).join(', ')}.`);
    pointBy.set(baseTerritory, { id: found.match.id, price: found.match.customerPrice });
    const eq = await getAll(deps, `/v1/subscriptionPricePoints/${enc(found.match.id)}/equalizations${qs({ include: 'territory', limit: 200 })}`, { pages: 5 });
    for (const pt of eq.data) {
      const t = pt.relationships?.territory?.data?.id;
      if (t && !pointBy.has(t)) pointBy.set(t, { id: pt.id, price: pt.attributes?.customerPrice });
    }
    const missing = terr.filter((t) => !pointBy.has(t));
    if (missing.length) throw new Error(`Apple has no equalized price for: ${missing.join(', ')}. Leave them out or pick another amount.`);
  }
  const refs = [];
  const included = [];
  terr.forEach((t, i) => {
    const id = `\${price-${i}}`;
    refs.push({ type: priceType, id });
    const relationships = { territory: { data: { type: 'territories', id: t } } };
    if (pointBy.has(t)) relationships.subscriptionPricePoint = { data: { type: 'subscriptionPricePoints', id: pointBy.get(t).id } };
    included.push({ type: priceType, id, relationships });
  });
  const table = terr.map((t) => ({ territory: t, price: offerMode === 'FREE_TRIAL' ? 'free' : pointBy.get(t).price }));
  return { refs, included, table };
}

function checkOfferBasics({ offerMode, duration, numberOfPeriods }) {
  if (!OFFER_MODES.includes(offerMode)) throw new Error(`offerMode must be one of ${OFFER_MODES.join(', ')}.`);
  if (!DURATIONS.includes(duration)) throw new Error(`duration must be one of ${DURATIONS.join(', ')}.`);
  if (!Number.isInteger(numberOfPeriods) || numberOfPeriods < 1) throw new Error('numberOfPeriods must be a whole number of at least 1.');
}

const offerSummary = (o) =>
  o.offerMode === 'FREE_TRIAL'
    ? `free for ${o.numberOfPeriods} x ${o.duration}`
    : o.offerMode === 'PAY_UP_FRONT'
      ? `one payment for ${o.numberOfPeriods} x ${o.duration}`
      : `a reduced price each period for ${o.numberOfPeriods} x ${o.duration}`;

// ---- offer codes -------------------------------------------------------------

export async function offerCodesOverview(deps, { subscriptionId }) {
  const codes = list(await deps.get(`/v1/subscriptions/${enc(subscriptionId)}/offerCodes${qs({ limit: 50 })}`));
  const out = [];
  for (const c of codes) {
    const [oneTime, custom] = await Promise.all([
      deps.get(`/v1/subscriptionOfferCodes/${enc(c.id)}/oneTimeUseCodes${qs({ limit: 50 })}`).catch(() => ({ data: [] })),
      deps.get(`/v1/subscriptionOfferCodes/${enc(c.id)}/customCodes${qs({ limit: 50 })}`).catch(() => ({ data: [] })),
    ]);
    out.push({
      id: c.id,
      name: c.name,
      active: c.active,
      offer: offerSummary(c),
      customerEligibilities: c.customerEligibilities,
      oneTimeCodeBatches: list(oneTime).map((b) => ({ id: b.id, codes: b.numberOfCodes, expires: b.expirationDate, created: toLocalTime(b.createdDate), active: b.active })),
      customCodes: list(custom).map((b) => ({ id: b.id, code: b.customCode, redemptions: b.numberOfCodes, expires: b.expirationDate, active: b.active })),
    });
  }
  return { subscriptionId, offerCodes: out, note: 'One-time code values are downloaded in App Store Connect (Subscriptions > Offer Codes).' };
}

export async function prepareCreateOfferCode(deps, { subscriptionId, name, customerEligibilities = ['NEW'], offerEligibility = 'STACK_WITH_INTRO_OFFERS', offerMode = 'FREE_TRIAL', duration = 'ONE_MONTH', numberOfPeriods = 1, territories = 'all', amount }) {
  if (!name || name.length > 64) throw new Error('Give the offer a name (64 characters max); only you see it.');
  checkOfferBasics({ offerMode, duration, numberOfPeriods });
  const elig = ['NEW', 'EXISTING', 'EXPIRED'];
  if (!Array.isArray(customerEligibilities) || !customerEligibilities.length || customerEligibilities.some((e) => !elig.includes(e))) {
    throw new Error(`customerEligibilities must list one or more of ${elig.join(', ')}.`);
  }
  const prices = await offerPrices(deps, { subscriptionId, offerMode, territories, amount, priceType: 'subscriptionOfferCodePrices' });
  const attributes = { name, customerEligibilities, offerEligibility, offerMode, duration, numberOfPeriods };
  const preview = await prepareChange({
    op: opFor('POST', '/v1/subscriptionOfferCodes'),
    body: {
      data: {
        type: 'subscriptionOfferCodes',
        attributes,
        relationships: { subscription: { data: { type: 'subscriptions', id: subscriptionId } }, prices: { data: prices.refs } },
      },
      included: prices.included,
    },
    deps,
  });
  return {
    offer: `${name}: ${offerSummary(attributes)} for ${customerEligibilities.join(' / ').toLowerCase()} customers`,
    territories: prices.table.length,
    priceTable: prices.table.slice(0, 40),
    note: 'This creates the offer only. Generate redeemable codes for it with asc_generate_offer_codes.',
    ...preview,
  };
}

export async function prepareGenerateOfferCodes(deps, { offerCodeId, numberOfCodes, expirationDate, customCode }) {
  if (!offerCodeId) throw new Error('Pass offerCodeId (from asc_offer_codes_overview).');
  if (!Number.isInteger(numberOfCodes) || numberOfCodes < 1) throw new Error('numberOfCodes must be a whole number of at least 1.');
  if (expirationDate && !DATE.test(expirationDate)) throw new Error('expirationDate must look like 2026-12-31.');
  if (customCode) {
    if (!/^[A-Za-z0-9]{1,64}$/.test(customCode)) throw new Error('A custom code may only use letters and digits (64 max).');
    return {
      kind: `custom code "${customCode}", redeemable ${numberOfCodes} time(s)`,
      ...(await prepareChange({
        op: opFor('POST', '/v1/subscriptionOfferCodeCustomCodes'),
        body: {
          data: {
            type: 'subscriptionOfferCodeCustomCodes',
            attributes: { customCode: customCode.toUpperCase(), numberOfCodes, ...(expirationDate ? { expirationDate } : {}) },
            relationships: { offerCode: { data: { type: 'subscriptionOfferCodes', id: offerCodeId } } },
          },
        },
        deps,
      })),
    };
  }
  if (!expirationDate) throw new Error('One-time codes need an expirationDate, e.g. 2026-12-31.');
  return {
    kind: `${numberOfCodes} one-time code(s), expiring ${expirationDate}`,
    note: 'Download the code values in App Store Connect once Apple has generated them.',
    ...(await prepareChange({
      op: opFor('POST', '/v1/subscriptionOfferCodeOneTimeUseCodes'),
      body: {
        data: {
          type: 'subscriptionOfferCodeOneTimeUseCodes',
          attributes: { numberOfCodes, expirationDate },
          relationships: { offerCode: { data: { type: 'subscriptionOfferCodes', id: offerCodeId } } },
        },
      },
      deps,
    })),
  };
}

export async function prepareSetOfferCodeActive(deps, { offerCodeId, active }) {
  if (typeof active !== 'boolean') throw new Error('Pass active: true or false.');
  return prepareChange({
    op: opFor('PATCH', '/v1/subscriptionOfferCodes/{id}'),
    pathParams: { id: offerCodeId },
    body: { data: { type: 'subscriptionOfferCodes', id: offerCodeId, attributes: { active } } },
    deps,
  });
}

// ---- promotional offers (for existing / lapsed subscribers, redeemed through your app) -------

export async function prepareCreatePromotionalOffer(deps, { subscriptionId, name, offerCode, offerMode = 'PAY_AS_YOU_GO', duration = 'ONE_MONTH', numberOfPeriods = 1, territories = 'all', amount }) {
  if (!name || !offerCode) throw new Error('Pass name (only you see it) and offerCode (the identifier your app uses to request the offer).');
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(offerCode)) throw new Error('offerCode may use letters, digits, dots, dashes and underscores (64 max).');
  checkOfferBasics({ offerMode, duration, numberOfPeriods });
  const prices = await offerPrices(deps, { subscriptionId, offerMode, territories, amount, priceType: 'subscriptionPromotionalOfferPrices' });
  const attributes = { name, offerCode, offerMode, duration, numberOfPeriods };
  const preview = await prepareChange({
    op: opFor('POST', '/v1/subscriptionPromotionalOffers'),
    body: {
      data: {
        type: 'subscriptionPromotionalOffers',
        attributes,
        relationships: { subscription: { data: { type: 'subscriptions', id: subscriptionId } }, prices: { data: prices.refs } },
      },
      included: prices.included,
    },
    deps,
  });
  return {
    offer: `${name} (${offerCode}): ${offerSummary(attributes)}`,
    territories: prices.table.length,
    priceTable: prices.table.slice(0, 40),
    note: 'Promotional offers only reach customers when your app requests them with a signed offer. Creating one changes nothing for customers by itself.',
    ...preview,
  };
}

// ---- win-back offers (shown by Apple to lapsed subscribers) ---------------------------------

export async function prepareCreateWinBackOffer(deps, {
  subscriptionId,
  referenceName,
  offerId,
  offerMode = 'FREE_TRIAL',
  duration = 'ONE_MONTH',
  periodCount = 1,
  paidMonthsBefore = 1,
  lapsedMinMonths = 1,
  lapsedMaxMonths = 24,
  waitBetweenOffersMonths,
  startDate,
  endDate,
  priority = 'NORMAL',
  promote = false,
  territories = 'all',
  amount,
}) {
  if (!referenceName || !offerId) throw new Error('Pass referenceName (only you see it) and offerId (a unique identifier, e.g. winback_2026_q4).');
  checkOfferBasics({ offerMode, duration, numberOfPeriods: periodCount });
  if (!startDate || !DATE.test(startDate)) throw new Error('startDate is required, like 2026-11-01.');
  if (endDate && !DATE.test(endDate)) throw new Error('endDate must look like 2027-01-31.');
  if (!(lapsedMinMonths >= 1 && lapsedMaxMonths >= lapsedMinMonths)) throw new Error('lapsedMinMonths must be at least 1 and no more than lapsedMaxMonths.');
  const prices = await offerPrices(deps, { subscriptionId, offerMode, territories, amount, priceType: 'winBackOfferPrices' });
  const attributes = {
    referenceName,
    offerId,
    offerMode,
    duration,
    periodCount,
    customerEligibilityPaidSubscriptionDurationInMonths: paidMonthsBefore,
    customerEligibilityTimeSinceLastSubscribedInMonths: { minimum: lapsedMinMonths, maximum: lapsedMaxMonths },
    ...(waitBetweenOffersMonths ? { customerEligibilityWaitBetweenOffersInMonths: waitBetweenOffersMonths } : {}),
    startDate,
    ...(endDate ? { endDate } : {}),
    priority,
    promotionIntent: promote ? 'USE_AUTO_GENERATED_ASSETS' : 'NOT_PROMOTED',
  };
  const preview = await prepareChange({
    op: opFor('POST', '/v1/winBackOffers'),
    body: {
      data: {
        type: 'winBackOffers',
        attributes,
        relationships: { subscription: { data: { type: 'subscriptions', id: subscriptionId } }, prices: { data: prices.refs } },
      },
      included: prices.included,
    },
    deps,
  });
  return {
    offer: `${referenceName}: ${offerSummary({ offerMode, duration, numberOfPeriods: periodCount })}`,
    whoSeesIt: `People who paid for at least ${paidMonthsBefore} month(s) and lapsed ${lapsedMinMonths} to ${lapsedMaxMonths} months ago, from ${startDate}${endDate ? ` to ${endDate}` : ''}.${promote ? ' Apple may also promote it on the App Store.' : ''}`,
    territories: prices.table.length,
    priceTable: prices.table.slice(0, 40),
    ...preview,
  };
}

// Google Play subscriptions overview (read-only). Edits go through play_prepare_change.
const APP = '/androidpublisher/v3/applications';

export async function subscriptionOverview(get, pkg) {
  let body;
  try {
    body = await get(`${APP}/${pkg}/subscriptions`, { pageSize: 100, showArchived: 'false' });
  } catch (err) {
    if (/\b403\b/.test(String(err.message))) {
      throw new Error(
        'Google Play refused to list subscriptions (403). The service account needs the "Manage orders and subscriptions" permission in Play Console (Users and permissions). ' + err.message,
      );
    }
    throw err;
  }
  const subs = (body.subscriptions || []).map((s) => ({
    productId: s.productId,
    archived: Boolean(s.archived),
    listings: (s.listings || []).map((l) => ({ language: l.languageCode, title: l.title })),
    basePlans: (s.basePlans || []).map((b) => ({
      basePlanId: b.basePlanId,
      state: b.state,
      renews: b.autoRenewingBasePlanType ? 'auto-renewing' : b.prepaidBasePlanType ? 'prepaid' : 'unknown',
      billingPeriod: b.autoRenewingBasePlanType?.billingPeriodDuration || b.prepaidBasePlanType?.billingPeriodDuration || null,
      regionsConfigured: (b.regionalConfigs || []).length,
    })),
  }));
  return { app: pkg, subscriptions: subs, count: subs.length };
}

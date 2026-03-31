const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const Community = require('../models/Community');
const Subscription = require('../models/Subscription');
const User = require('../models/User');

const JWT_SECRET = process.env.JWT_SECRET || 'wave-secret-key-change-in-prod';
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const APP_URL = process.env.APP_URL || 'https://wave-chat-fnpr.onrender.com';
// WAVE platform fee percentage (e.g. 10 = 10%)
const WaveSettings = require('../models/WaveSettings');

let stripe = null;
function getStripe(){
  if(!stripe && STRIPE_SECRET) stripe = require('stripe')(STRIPE_SECRET);
  return stripe;
}

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

const PLAN_INTERVALS = {
  weekly:   { interval: 'week',  interval_count: 1 },
  monthly:  { interval: 'month', interval_count: 1 },
  yearly:   { interval: 'year',  interval_count: 1 },
  lifetime: null // one-time payment
};

// ── Get community subscription info (public) ──
router.get('/communities/:id/subscription', auth, async (req, res) => {
  try {
    const community = await Community.findById(req.params.id)
      .select('name isPaid subscription platformFeePercent ownerId').lean();
    if(!community) return res.status(404).json({ error: 'Not found' });

    // Check if user already has active subscription
    const existing = await Subscription.findOne({
      userId: req.user.id,
      communityId: req.params.id,
      status: { $in: ['active','trialing'] }
    });

    // Check if user is owner (never needs subscription)
    const isOwner = community.ownerId.toString() === req.user.id;

    res.json({
      isPaid: community.isPaid,
      isOwner,
      hasAccess: isOwner || !!existing,
      subscription: community.subscription,
      platformFeePercent: community.platformFeePercent,
      currentPlan: existing?.plan || null,
      currentPeriodEnd: existing?.currentPeriodEnd || null
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Creator: set up / update subscription pricing ──
router.post('/communities/:id/subscription/setup', auth, async (req, res) => {
  try {
    const s = getStripe();
    if(!s) return res.status(503).json({ error: 'Stripe not configured' });

    const community = await Community.findById(req.params.id);
    if(!community) return res.status(404).json({ error: 'Not found' });
    if(community.ownerId.toString() !== req.user.id)
      return res.status(403).json({ error: 'Only the owner can set up subscriptions' });

    const { weekly, monthly, yearly, lifetime, enableFlatFee } = req.body;
    // Prices in dollars → convert to cents
    const plans = { weekly, monthly, yearly, lifetime };

    // Create Stripe product if needed
    let productId = community.stripeProductId;
    if(!productId){
      const product = await s.products.create({
        name: `${community.name} — WAVE Community`,
        metadata: { communityId: community._id.toString(), waveApp: 'true' }
      });
      productId = product.id;
      community.stripeProductId = productId;
    }

    // Create/update Stripe prices for each plan
    for(const [plan, dollars] of Object.entries(plans)){
      if(!dollars || dollars <= 0) continue;
      const cents = Math.round(parseFloat(dollars) * 100);
      const interval = PLAN_INTERVALS[plan];

      if(plan === 'lifetime'){
        // One-time price
        const price = await s.prices.create({
          product: productId,
          unit_amount: cents,
          currency: 'usd',
          metadata: { plan: 'lifetime', communityId: community._id.toString() }
        });
        community.subscription.lifetime.price = cents;
        community.subscription.lifetime.stripePriceId = price.id;
      } else if(interval){
        const price = await s.prices.create({
          product: productId,
          unit_amount: cents,
          currency: 'usd',
          recurring: { interval: interval.interval, interval_count: interval.interval_count },
          metadata: { plan, communityId: community._id.toString() }
        });
        community.subscription[plan].price = cents;
        community.subscription[plan].stripePriceId = price.id;
      }
    }

    community.isPaid = true;
    await community.save();
    res.json({ success: true, productId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Create Stripe Connect onboarding link for creator ──
router.post('/stripe/connect/onboard', auth, async (req, res) => {
  try {
    const s = getStripe();
    if(!s) return res.status(503).json({ error: 'Stripe not configured. Add STRIPE_SECRET_KEY to environment variables.' });

    const user = await User.findById(req.user.id).select('email username');
    let accountId = req.body.existingAccountId;

    if(!accountId){
      let account;
      try {
        // Use Stripe v2 Accounts API (matches your Stripe Connect sandbox setup)
        account = await fetch('https://api.stripe.com/v2/core/accounts', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${STRIPE_SECRET}`,
            'Content-Type': 'application/json',
            'Stripe-Version': '2025-03-31.basil'
          },
          body: JSON.stringify({
            display_name: user.username,
            contact_email: user.email,
            configuration: {
              merchant: { simulate_accept_tos_obo: false }
            },
            include: ['configuration.merchant', 'configuration.customer', 'identity', 'defaults'],
            identity: { country: 'US' },
            dashboard: 'full',
            defaults: {
              responsibilities: {
                losses_collector: 'stripe',
                fees_collector: 'stripe'
              }
            }
          })
        });
        const accountData = await account.json();
        if(!account.ok){
          console.error('v2 account creation failed:', accountData);
          // Fallback to legacy Express account
          const legacy = await s.accounts.create({
            type: 'express',
            email: user.email,
            capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
            metadata: { userId: req.user.id, username: user.username }
          });
          accountId = legacy.id;
        } else {
          accountId = accountData.id;
        }
      } catch(createErr) {
        console.error('Account creation failed:', createErr.message);
        return res.status(400).json({
          error: 'Could not create Stripe Connect account. Make sure Connect is enabled in your Stripe Dashboard under Settings → Connect.',
          stripeError: createErr.message
        });
      }
    }

    // Create account link for onboarding using v2 API
    let onboardingUrl;
    try {
      const linkRes = await fetch('https://api.stripe.com/v2/core/account_links', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${STRIPE_SECRET}`,
          'Content-Type': 'application/json',
          'Stripe-Version': '2025-03-31.basil'
        },
        body: JSON.stringify({
          account: accountId,
          use_case: {
            type: 'account_onboarding',
            account_onboarding: {
              configurations: ['merchant', 'customer'],
              refresh_url: `${APP_URL}?stripe_refresh=1&account=${accountId}`,
              return_url:  `${APP_URL}?stripe_return=1&account=${accountId}`
            }
          }
        })
      });
      const linkData = await linkRes.json();
      if(!linkRes.ok || !linkData.url){
        // Fallback to v1 account links
        const fallbackLink = await s.accountLinks.create({
          account: accountId,
          refresh_url: `${APP_URL}?stripe_refresh=1&account=${accountId}`,
          return_url:  `${APP_URL}?stripe_return=1&account=${accountId}`,
          type: 'account_onboarding'
        });
        onboardingUrl = fallbackLink.url;
      } else {
        onboardingUrl = linkData.url;
      }
    } catch(linkErr) {
      // Fallback to v1
      const fallbackLink = await s.accountLinks.create({
        account: accountId,
        refresh_url: `${APP_URL}?stripe_refresh=1&account=${accountId}`,
        return_url:  `${APP_URL}?stripe_return=1&account=${accountId}`,
        type: 'account_onboarding'
      });
      onboardingUrl = fallbackLink.url;
    }

    res.json({ url: onboardingUrl, accountId });
  } catch(e) {
    console.error('Stripe Connect error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Save creator's Stripe account to a community ──
router.post('/communities/:id/stripe-account', auth, async (req, res) => {
  try {
    const community = await Community.findById(req.params.id);
    if(!community) return res.status(404).json({ error: 'Not found' });
    if(community.ownerId.toString() !== req.user.id) return res.status(403).json({ error: 'Owner only' });
    community.stripeAccountId = req.body.accountId;
    await community.save();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Create checkout session (member subscribing) ──
router.post('/communities/:id/subscribe', auth, async (req, res) => {
  try {
    const s = getStripe();
    if(!s) return res.status(503).json({ error: 'Stripe not configured' });

    const { plan } = req.body;
    if(!PLAN_INTERVALS.hasOwnProperty(plan))
      return res.status(400).json({ error: 'Invalid plan' });

    const community = await Community.findById(req.params.id);
    if(!community) return res.status(404).json({ error: 'Not found' });
    if(!community.isPaid) return res.status(400).json({ error: 'Community is free' });

    const planData = community.subscription[plan];
    if(!planData?.stripePriceId)
      return res.status(400).json({ error: `${plan} plan not available` });

    // Check existing subscription
    const existing = await Subscription.findOne({
      userId: req.user.id, communityId: req.params.id, status: 'active'
    });
    if(existing) return res.status(400).json({ error: 'Already subscribed' });

    const user = await User.findById(req.user.id).select('email username');
    const settings = await WaveSettings.get();
    const feePercent = settings.subscriptionFeePercent;

    const isLifetime = plan === 'lifetime';
    const sessionParams = {
      payment_method_types: ['card'],
      customer_email: user.email,
      line_items: [{ price: planData.stripePriceId, quantity: 1 }],
      mode: isLifetime ? 'payment' : 'subscription',
      success_url: `${APP_URL}?sub_success=1&community=${req.params.id}&plan=${plan}`,
      cancel_url:  `${APP_URL}?sub_cancel=1&community=${req.params.id}`,
      metadata: {
        userId: req.user.id,
        communityId: req.params.id,
        plan,
        username: user.username
      }
    };

    // Apply platform fee + route to creator's Stripe account if connected
    if(community.stripeAccountId){
      sessionParams.payment_intent_data = {
        application_fee_amount: Math.round(planData.price * feePercent / 100),
        transfer_data: { destination: community.stripeAccountId }
      };
      if(!isLifetime){
        sessionParams.subscription_data = {
          application_fee_percent: feePercent,
          transfer_data: { destination: community.stripeAccountId }
        };
        delete sessionParams.payment_intent_data;
      }
    }

    const session = await s.checkout.sessions.create(sessionParams);
    res.json({ url: session.url, sessionId: session.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Cancel subscription ──
router.post('/communities/:id/cancel-subscription', auth, async (req, res) => {
  try {
    const s = getStripe();
    if(!s) return res.status(503).json({ error: 'Stripe not configured' });

    const sub = await Subscription.findOne({
      userId: req.user.id, communityId: req.params.id, status: 'active'
    });
    if(!sub) return res.status(404).json({ error: 'No active subscription' });
    if(sub.plan === 'lifetime') return res.status(400).json({ error: 'Lifetime subscriptions cannot be canceled' });

    await s.subscriptions.update(sub.stripeSubscriptionId, { cancel_at_period_end: true });
    sub.canceledAt = new Date();
    sub.status = 'canceled';
    await sub.save();
    res.json({ success: true, message: 'Subscription will cancel at end of billing period' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Get user's subscriptions ──
router.get('/subscriptions/mine', auth, async (req, res) => {
  try {
    const subs = await Subscription.find({ userId: req.user.id, status: { $in: ['active','trialing'] } })
      .populate('communityId', 'name avatar').lean();
    res.json({ subscriptions: subs });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Stripe webhook (raw body needed) ──
router.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const s = getStripe();
  if(!s) return res.status(503).send('Stripe not configured');

  let event;
  try {
    event = s.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch(e) {
    console.log('Webhook signature error:', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  try {
    switch(event.type){
      case 'checkout.session.completed': {
        const session = event.data.object;
        const { userId, communityId, plan } = session.metadata;
        const isLifetime = plan === 'lifetime';

        // Grant access
        let periodEnd = null;
        if(!isLifetime && session.subscription){
          const stripeSub = await s.subscriptions.retrieve(session.subscription);
          periodEnd = new Date(stripeSub.current_period_end * 1000);
          await Subscription.create({
            userId, communityId, plan,
            stripeCustomerId: session.customer,
            stripeSubscriptionId: session.subscription,
            status: 'active',
            amount: stripeSub.items.data[0].price.unit_amount,
            currentPeriodStart: new Date(stripeSub.current_period_start * 1000),
            currentPeriodEnd: periodEnd
          });
        } else if(isLifetime){
          await Subscription.create({
            userId, communityId, plan: 'lifetime',
            stripeCustomerId: session.customer,
            stripePaymentIntentId: session.payment_intent,
            status: 'active',
            amount: session.amount_total,
            currentPeriodStart: new Date(),
            currentPeriodEnd: null
          });
        }

        // Auto-add user to community
        const community = await Community.findById(communityId);
        if(community){
          const already = community.members.find(m=>m.userId.toString()===userId);
          if(!already){
            const memberRole = community.roles.find(r=>r.name==='Member');
            community.members.push({ userId, roles: memberRole ? [memberRole._id.toString()] : [] });
            await community.save();
          }
        }
        console.log(`✅ Subscription activated: ${plan} for user ${userId} in community ${communityId}`);
        break;
      }
      case 'customer.subscription.updated': {
        const stripeSub = event.data.object;
        await Subscription.findOneAndUpdate(
          { stripeSubscriptionId: stripeSub.id },
          {
            status: stripeSub.status,
            currentPeriodStart: new Date(stripeSub.current_period_start * 1000),
            currentPeriodEnd:   new Date(stripeSub.current_period_end   * 1000)
          }
        );
        break;
      }
      case 'customer.subscription.deleted': {
        const stripeSub = event.data.object;
        const sub = await Subscription.findOneAndUpdate(
          { stripeSubscriptionId: stripeSub.id },
          { status: 'canceled', canceledAt: new Date() },
          { new: true }
        );
        // Remove from community if subscription lapsed
        if(sub){
          const community = await Community.findById(sub.communityId);
          if(community){
            community.members = community.members.filter(m=>m.userId.toString()!==sub.userId.toString());
            await community.save();
          }
        }
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        await Subscription.findOneAndUpdate(
          { stripeSubscriptionId: invoice.subscription },
          { status: 'past_due' }
        );
        break;
      }
    }
  } catch(e) { console.error('Webhook handler error:', e.message); }

  res.json({ received: true });
});

// ── Admin: get all subscriptions + revenue stats ──
router.get('/admin/subscriptions', auth, async (req, res) => {
  try {
    const ADMIN = process.env.ADMIN_USERNAME || 'JayMerch';
    if(req.user.username.toLowerCase() !== ADMIN.toLowerCase())
      return res.status(403).json({ error: 'Admin only' });

    const subs = await Subscription.find()
      .populate('userId', 'username email')
      .populate('communityId', 'name')
      .sort({ createdAt: -1 }).limit(100).lean();

    const totalRevenue = subs.reduce((s,sub)=>s+(sub.amount||0),0);
    const settings = await WaveSettings.get();
    const waveFee = Math.round(totalRevenue * settings.subscriptionFeePercent / 100);
    const activeSubs = subs.filter(s=>s.status==='active').length;

    res.json({ subscriptions: subs, totalRevenue, waveFee, activeSubs, feePercent: settings.subscriptionFeePercent, flatFeeMonthly: settings.communityFlatFeeMonthly, setupFee: settings.communitySetupFee });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: Test Stripe connection ──
router.get('/admin/stripe-status', auth, async (req, res) => {
  try {
    const ADMIN = process.env.ADMIN_USERNAME || 'JayMerch';
    if(req.user.username.toLowerCase() !== ADMIN.toLowerCase())
      return res.status(403).json({ error: 'Admin only' });
    const s = getStripe();
    if(!s) return res.json({ connected: false, reason: 'No STRIPE_SECRET_KEY set in environment variables' });
    // Try fetching the account to verify the key works
    const account = await s.account.retrieve();
    const settings = await WaveSettings.get();
    res.json({
      connected: true,
      accountId: account.id,
      email: account.email,
      country: account.country,
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      displayName: account.settings?.dashboard?.display_name || account.business_profile?.name || '—',
      feePercent: settings.subscriptionFeePercent,
      flatFee: settings.communityFlatFeeMonthly,
      setupFee: settings.communitySetupFee
    });
  } catch(e) {
    res.json({ connected: false, reason: e.message });
  }
});

// ── ADMIN: Get current fee settings ──
router.get('/admin/fees', auth, async (req, res) => {
  try {
    const ADMIN = process.env.ADMIN_USERNAME || 'JayMerch';
    if(req.user.username.toLowerCase() !== ADMIN.toLowerCase())
      return res.status(403).json({ error: 'Admin only' });
    const settings = await WaveSettings.get();
    res.json({
      subscriptionFeePercent: settings.subscriptionFeePercent,
      communityFlatFeeMonthly: settings.communityFlatFeeMonthly,
      communitySetupFee: settings.communitySetupFee,
      updatedAt: settings.updatedAt,
      updatedBy: settings.updatedBy
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: Update fee settings ──
router.post('/admin/fees', auth, async (req, res) => {
  try {
    const ADMIN = process.env.ADMIN_USERNAME || 'JayMerch';
    if(req.user.username.toLowerCase() !== ADMIN.toLowerCase())
      return res.status(403).json({ error: 'Admin only' });
    const { subscriptionFeePercent, communityFlatFeeMonthly, communitySetupFee } = req.body;
    const settings = await WaveSettings.get();
    if(subscriptionFeePercent !== undefined){
      const v = parseFloat(subscriptionFeePercent);
      if(isNaN(v)||v<0||v>100) return res.status(400).json({ error: 'Fee percent must be 0–100' });
      settings.subscriptionFeePercent = v;
    }
    if(communityFlatFeeMonthly !== undefined){
      const v = Math.round(parseFloat(communityFlatFeeMonthly)*100);
      if(isNaN(v)||v<0) return res.status(400).json({ error: 'Invalid flat fee' });
      settings.communityFlatFeeMonthly = v;
    }
    if(communitySetupFee !== undefined){
      const v = Math.round(parseFloat(communitySetupFee)*100);
      if(isNaN(v)||v<0) return res.status(400).json({ error: 'Invalid setup fee' });
      settings.communitySetupFee = v;
    }
    settings.updatedAt = new Date();
    settings.updatedBy = req.user.username;
    await settings.save();
    res.json({ success: true, settings: {
      subscriptionFeePercent: settings.subscriptionFeePercent,
      communityFlatFeeMonthly: settings.communityFlatFeeMonthly,
      communitySetupFee: settings.communitySetupFee
    }});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Creator dashboard stats ──
router.get('/communities/:id/creator-dashboard', auth, async (req, res) => {
  try {
    const community = await Community.findById(req.params.id).select('ownerId name subscription').lean();
    if(!community) return res.status(404).json({ error: 'Not found' });
    if(community.ownerId.toString() !== req.user.id)
      return res.status(403).json({ error: 'Owner only' });

    const allSubs = await Subscription.find({ communityId: req.params.id })
      .populate('userId','username email').sort({ createdAt: -1 }).lean();

    const active = allSubs.filter(s => s.status === 'active');
    const totalRevenue = allSubs.reduce((t,s) => t + (s.amount||0), 0);

    // Monthly estimate based on active plans
    const planMonthly = { weekly: 4.33, monthly: 1, yearly: 1/12, lifetime: 0 };
    const monthlyEst = active.reduce((t,s) => {
      const price = s.amount || 0;
      return t + Math.round(price * (planMonthly[s.plan] || 0));
    }, 0);

    // Breakdown by plan
    const byPlan = { weekly:0, monthly:0, yearly:0, lifetime:0 };
    active.forEach(s => { if(byPlan[s.plan] !== undefined) byPlan[s.plan]++; });

    // Expiring in next 14 days or already canceled
    const soon = new Date(Date.now() + 14 * 86400000);
    const expiring = allSubs.filter(s =>
      (s.status === 'canceled') ||
      (s.currentPeriodEnd && new Date(s.currentPeriodEnd) <= soon && s.status === 'active')
    ).slice(0, 10);

    // Recent 10 subscribers
    const recent = allSubs.slice(0, 10);

    res.json({ activeSubs: active.length, totalRevenue, monthlyEst, byPlan, expiring, recent });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
module.exports = router;
